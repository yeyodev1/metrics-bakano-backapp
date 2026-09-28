import { z } from "zod";
import jwt from "jsonwebtoken";
import models from "../../models";
import { resendService } from "../../services/resend.service";
import { correoBloqueado } from "../../utils/contactosBloqueados";
import { LINK_CONTRATO_MODELO } from "../../services/contratoModelo.service";
import { estadoEntorno, resolverCliente, type ToolMcp } from "./base";

/** Da tiempo a abrir la prueba en el correo y leerla con calma. */
const TOKEN_MIN = 30;
/** Se manda de a uno (nadie ve los correos de los demás) y la función vive 60 s. */
const MAX_DESTINATARIOS = 40;
const PAUSA_MS = 550;

function secreto(): string {
  return `${process.env.JWT_SECRET || "default_jwt_secret_key"}:mcp-correos`;
}

/**
 * Junta los correos sueltos y, si se pide un entorno, sus clientes activos
 * (sin la gente de @bakano.ec). Los bloqueados se apartan aquí para que la
 * persona sepa que no les va a llegar.
 */
async function destinatarios(a: { para?: string[]; cliente?: string }) {
  const todos = new Set<string>((a.para ?? []).map((c) => c.toLowerCase().trim()).filter(Boolean));
  let entorno: string | undefined;
  let estado: ReturnType<typeof estadoEntorno> | undefined;
  if (a.cliente) {
    const ref = await resolverCliente(a.cliente);
    entorno = ref.name;
    estado = estadoEntorno(await models.workspaces.findById(ref._id).select("isActive desactivacion").lean());
    const gente = await models.users
      .find({
        $or: [{ "workspaces.workspaceId": ref._id }, { workspaceId: ref._id }],
        isActive: { $ne: false },
        role: { $ne: "superadmin" },
        email: { $not: /@bakano\.ec$/i },
      })
      .select("email")
      .lean();
    gente.forEach((g: any) => g.email && todos.add(String(g.email).toLowerCase()));
  }
  const envio: string[] = [];
  const bloqueados: string[] = [];
  for (const c of todos) ((await correoBloqueado(c)) ? bloqueados : envio).push(c);
  return { envio, bloqueados, entorno, estado };
}

export const toolsCorreos: ToolMcp[] = [
  {
    nombre: "correo_prueba",
    titulo: "Correo: enviarme la prueba",
    descripcion:
      "Paso 1 de 2 para mandar un correo. Te manda SOLO a ti una prueba, con una franja que dice a quién le llegaría, y devuelve un token de 30 minutos para enviar_correo. Destinatarios: correos sueltos en `para` y/o los clientes activos de un entorno en `cliente`. Sale de noreply@bakano.ec y el pie siempre avisa que es una dirección de solo envío: si responden, nadie lo verá (se les indica soporte@bakano.ec). El mensaje es texto plano; una línea en blanco separa párrafos. Se firma con tu nombre. Solo superadmin.",
    perfiles: ["direccion"],
    soloSuperadmin: true,
    escribe: true,
    entrada: {
      asunto: z.string().min(3).max(150),
      mensaje: z.string().min(10).max(8000),
      para: z.array(z.string().email()).max(MAX_DESTINATARIOS).optional(),
      cliente: z.string().optional().describe("Nombre o id del entorno: le llega a sus clientes activos"),
    },
    async correr(a, u) {
      if (!a.para?.length && !a.cliente) throw new Error("Dime a quién: correos en `para` o un entorno en `cliente`.");
      const { envio, bloqueados, entorno, estado } = await destinatarios(a);
      if (!envio.length) throw new Error("No queda nadie a quien enviarle.");
      if (envio.length > MAX_DESTINATARIOS) throw new Error(`Son ${envio.length} destinatarios; el máximo por envío es ${MAX_DESTINATARIOS}. Pártelo.`);
      const firma = `${u.nombre} · Bakano`;
      const r = await resendService.sendCorreoDelEquipo({ to: u.email, asunto: a.asunto, mensaje: a.mensaje, firma, prueba: { destinatarios: envio } });
      if (r.error) throw new Error(`No salió la prueba: ${r.error}`);
      // El token lleva el correo entero: enviar_correo manda exactamente lo que se probó.
      const token = jwt.sign({ u: u._id, s: a.asunto, m: a.mensaje, f: firma, d: envio }, secreto(), { expiresIn: `${TOKEN_MIN}m` });
      return {
        pruebaEnviadaA: u.email,
        ...(entorno ? { entorno } : {}),
        ...(estado && estado.estado !== "activo" ? { ojo: `${entorno} no está activo: ${estado.motivo}. ${estado.aviso}` } : {}),
        llegaria: envio,
        ...(bloqueados.length ? { noSeLesEnvia: bloqueados.length } : {}),
        token,
        venceEn: `${TOKEN_MIN} minutos`,
        siguiente: "Que la persona revise la prueba en su correo. Si la aprueba, enviar_correo con este token. Si quiere cambios, otra correo_prueba.",
      };
    },
  },
  {
    nombre: "enviar_correo",
    titulo: "Correo: enviar el de verdad",
    descripcion:
      "Paso 2 de 2: envía el correo que se probó con correo_prueba, igual pero sin la franja de prueba, a cada destinatario por separado (nadie ve a los demás). Solo acepta ese token (30 minutos, de quien lo pidió). No se puede deshacer: confirma con la persona que ya vio la prueba. Solo superadmin.",
    perfiles: ["direccion"],
    soloSuperadmin: true,
    escribe: true,
    entrada: { token: z.string() },
    async correr(a, u) {
      let d: any;
      try {
        d = jwt.verify(a.token, secreto());
      } catch {
        throw new Error("El token venció o no es válido. Vuelve a correo_prueba.");
      }
      if (d.u !== u._id) throw new Error("Ese token es de otra persona.");
      const enviados: string[] = [];
      const fallidos: { correo: string; error: string }[] = [];
      for (const [i, correo] of (d.d as string[]).entries()) {
        if (i) await new Promise((r) => setTimeout(r, PAUSA_MS));
        const r = await resendService
          .sendCorreoDelEquipo({ to: correo, asunto: d.s, mensaje: d.m, firma: d.f })
          .catch((e: any) => ({ error: e?.message || String(e) }));
        if ("error" in r && r.error) fallidos.push({ correo, error: r.error });
        else enviados.push(correo);
      }
      return { asunto: d.s, enviados: enviados.length, a: enviados, ...(fallidos.length ? { fallidos } : {}) };
    },
  },
  {
    nombre: "enviar_contrato_modelo",
    titulo: "Mandar el contrato para revisar (antes de cerrar)",
    descripcion:
      "Le manda a un prospecto, antes de cerrar la venta, un correo desde team@bakano.ec con el enlace para leer nuestro contrato de servicios vigente en la web (y descargarlo en PDF). Es el contrato modelo: sin datos del cliente ni firma. Puedes agregar una nota corta. Confirma el correo con quien lo pide antes de enviarlo.",
    perfiles: ["direccion", "pm"],
    escribe: true,
    entrada: {
      correo: z.string().email(),
      nombre: z.string().max(120).optional().describe("Nombre del prospecto, para el saludo"),
      nota: z.string().max(800).optional().describe("Mensaje corto que va antes del botón"),
    },
    async correr(a, u) {
      const correo = String(a.correo).toLowerCase().trim();
      if (await correoBloqueado(correo)) throw new Error("Ese contacto está bloqueado: no se le escribe.");
      const r = await resendService.sendContratoParaRevisar({
        to: correo,
        nombre: a.nombre,
        nota: a.nota,
        enviadoPor: `${u.nombre} · Bakano`,
        link: LINK_CONTRATO_MODELO,
      });
      return { enviado: true, a: correo, desde: "team@bakano.ec", enlace: LINK_CONTRATO_MODELO, id: r.id };
    },
  },
];
