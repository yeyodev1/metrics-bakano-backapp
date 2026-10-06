import { z } from "zod";
import models from "../../models";
import { atencionClienteService, fechaEcuador } from "../../services/atencionCliente.service";
import { CALENDARIOS_PRODUCCION } from "../../services/equipoAtencion.service";
import { estadoPagoService } from "../../services/estadoPago.service";
import { ghlService } from "../../services/ghl.service";
import { ANTICIPACION_PRODUCCION_H, estadoEntorno, fecha, leerFecha, resolverCliente, type ToolMcp } from "./base";

/**
 * Producción crea las grabaciones de un cliente desde el MCP, por el mismo
 * camino que el bot: cita en el calendario de producción del CRM, sync al
 * Planificador y avisos. Las reglas del cliente (cada cuántos meses, reunión
 * con Ariana, pagos) aquí son advertencias: el equipo decide.
 */

const PERFILES = ["produccion", "pm", "direccion"] as const;
const calendarioEnum = z.enum(["standard", "premium"]);

/** Lo que el equipo tiene que saber antes de agendar. Nunca bloquea. */
async function advertencias(workspaceId: any): Promise<string[]> {
  const ahora = new Date();
  const [proxima, pago, ariana] = await Promise.all([
    models.planning
      .findOne({ workspaceId, date: { $gte: ahora }, title: { $not: /^CANCELADA/ }, cancelada: { $ne: true } })
      .sort({ date: 1 })
      .select("date title")
      .lean(),
    estadoPagoService.bloqueo(String(workspaceId)).catch(() => null),
    atencionClienteService.reglaAriana(workspaceId).catch(() => null),
  ]);
  const salida: string[] = [];
  if (proxima) salida.push(`Ya tiene una producción agendada: ${fecha(proxima.date)} (${proxima.title}).`);
  if (pago) salida.push(`Tiene pagos pendientes (${pago.deudaTexto}). Sin pago al día no se graba: confírmalo con atención antes.`);
  if (ariana?.aplica && !ariana.tieneAriana) salida.push("Todavía no tuvo la reunión de levantamiento con Ariana (va antes de la primera producción).");
  return salida;
}

async function entornoVigente(cliente: string) {
  const ws = await resolverCliente(cliente);
  const doc: any = await models.workspaces.findById(ws._id).select("name isActive desactivacion").lean();
  const estado = estadoEntorno(doc);
  if (estado.estado === "contrato_finalizado") throw new Error(`${ws.name}: su contrato terminó, no se le agendan producciones. ${estado.motivo}`);
  return { ws, estado };
}

export const toolsCrearProduccion: ToolMcp[] = [
  {
    nombre: "horarios_produccion",
    titulo: "Horarios libres para producción",
    descripcion:
      "Horarios libres del calendario de producción del cliente (standard o premium, el que ya usa) en una ventana de días, más lo que conviene saber antes (ya tiene producción, pagos, reunión con Ariana). Cada horario trae `inicio`, el valor exacto para crear_produccion. Son los horarios que ven los clientes; si la persona quiere otra hora, crear_produccion con fuera_de_horario=true revisa que no choque. Solo lectura.",
    perfiles: [...PERFILES],
    entrada: {
      cliente: z.string(),
      desde: z.string().optional().describe("Fecha desde la que buscar (por defecto, pasado mañana)"),
      dias: z.number().int().min(1).max(45).optional().describe("Cuántos días mirar (por defecto 14)"),
      calendario: calendarioEnum.optional(),
    },
    async correr(a) {
      const { ws, estado } = await entornoVigente(a.cliente);
      if (!ghlService.isConfigured()) throw new Error("El calendario del CRM no está configurado en el servidor.");
      // El equipo puede agendar para ya mismo: desde la próxima hora.
      const minimo = new Date(Date.now() + 3_600_000);
      const desdePedido = a.desde ? leerFecha(a.desde) : minimo;
      const desde = desdePedido.getTime() < minimo.getTime() ? minimo : desdePedido;
      const hasta = new Date(desde.getTime() + (a.dias ?? 14) * 86_400_000);
      const calendario = await atencionClienteService.calendarioProduccion(ws._id, a.calendario);
      const [libres, avisos] = await Promise.all([ghlService.getFreeSlots(calendario, desde, hasta), advertencias(ws._id)]);
      return {
        cliente: ws.name,
        ...(estado.estado !== "activo" ? { estadoCliente: estado } : {}),
        calendario: calendario === CALENDARIOS_PRODUCCION.premium ? "premium" : "standard",
        advertencias: avisos,
        horarios: libres.slice(0, 40).map((h) => ({ cuando: fechaEcuador(h), inicio: h.toISOString() })),
        nota: `El equipo puede agendar con menos de ${ANTICIPACION_PRODUCCION_H} h; si queda tan cerca, avísale al cliente directamente.`,
      };
    },
  },
  {
    nombre: "crear_produccion",
    titulo: "Crear una producción",
    descripcion:
      "Crea la producción de un cliente: cita en el calendario de producción del CRM, entra al Planificador y avisa a producción, contenido y atención. Sin `confirmar` solo revisa que el horario siga libre y devuelve el resumen con advertencias: PREGUNTA a la persona antes de llamarla con confirmar=true. Usa el `inicio` de horarios_produccion (o una fecha y hora de Ecuador). " +
      "Con `fuera_de_horario=true` el equipo agenda a cualquier hora aunque el calendario no ofrezca ese horario (los clientes nunca tienen esa opción): solo se crea si no choca con otra cita ni bloqueo del equipo de producción. Úsalo cuando la persona lo pida.",
    perfiles: [...PERFILES],
    escribe: true,
    entrada: {
      cliente: z.string(),
      inicio: z.string().describe("Fecha y hora de inicio (ISO de horarios_produccion, o fecha y hora de Ecuador)"),
      calendario: calendarioEnum.optional(),
      fuera_de_horario: z.boolean().optional().describe("Agendar a una hora que el calendario no ofrece; solo si no choca con nada"),
      confirmar: z.boolean().optional(),
    },
    async correr(a, u) {
      const { ws, estado } = await entornoVigente(a.cliente);
      if (!ghlService.isConfigured()) throw new Error("El calendario del CRM no está configurado en el servidor.");
      const inicio = leerFecha(a.inicio);
      if (inicio.getTime() <= Date.now()) throw new Error("Esa hora ya pasó.");
      const calendario = await atencionClienteService.calendarioProduccion(ws._id, a.calendario);
      const nombreCal = calendario === CALENDARIOS_PRODUCCION.premium ? "premium" : "standard";

      if (a.fuera_de_horario) {
        const choques = await atencionClienteService.choquesProduccion(calendario, inicio);
        if (choques.length) {
          return {
            creada: false,
            motivo: "Choca con lo que ya tiene el equipo de producción a esa hora. Elige otra hora.",
            choques,
          };
        }
      } else if (!(await atencionClienteService.sigueLibre(calendario, inicio))) {
        const cercanos = await ghlService
          .getFreeSlots(calendario, new Date(inicio.getTime() - 2 * 86_400_000), new Date(inicio.getTime() + 3 * 86_400_000))
          .catch(() => [] as Date[]);
        const futuros = cercanos.filter((h) => h.getTime() > Date.now()).slice(0, 6);
        return {
          creada: false,
          motivo: `Ese horario no está libre en el calendario ${nombreCal} (ocupado o fuera de los horarios que ofrece). Si la persona quiere esa hora igual, revisa con fuera_de_horario=true: se crea si no choca con nada.`,
          libresCerca: futuros.map((h) => ({ cuando: fechaEcuador(h), inicio: h.toISOString() })),
        };
      }

      const avisos = await advertencias(ws._id);
      if (estado.estado !== "activo") avisos.unshift(`El cliente está pausado: ${estado.motivo}.`);
      if (inicio.getTime() - Date.now() < ANTICIPACION_PRODUCCION_H * 3_600_000) {
        avisos.unshift(`Queda a menos de ${ANTICIPACION_PRODUCCION_H} h: confírmalo con el cliente directamente, puede no ver el aviso a tiempo.`);
      }
      if (!a.confirmar) {
        return {
          creada: false,
          revisar: {
            cliente: ws.name,
            cuando: fechaEcuador(inicio),
            calendario: nombreCal,
            ...(a.fuera_de_horario ? { fueraDeHorario: "Sí: no choca con nada del equipo; los clientes no ven ese horario." } : {}),
            advertencias: avisos,
          },
          siguiente: "Pregúntale a la persona si la crea. Si dice que sí, llama a crear_produccion con confirmar=true y los mismos inicio y fuera_de_horario.",
        };
      }

      const r = await atencionClienteService.crearProduccionPorEquipo(ws._id, inicio, { id: u._id, nombre: u.nombre }, { calendario: a.calendario, fueraDeHorario: a.fuera_de_horario === true });
      if (!r.ok) {
        const motivos: Record<string, string> = {
          sin_calendario: "El calendario del CRM no está configurado en el servidor.",
          sin_contacto: `${ws.name} no tiene ningún usuario cliente con correo para la cita. Agrégalo primero (agregar_persona_entorno).`,
          ocupado: a.fuera_de_horario
            ? "Ahora choca con otra cita del equipo de producción. Revisa otra hora."
            : "Ese horario se ocupó justo ahora. Pide los horarios otra vez.",
          error: "El CRM no aceptó la cita. Intenta de nuevo en un momento.",
        };
        return { creada: false, motivo: motivos[r.motivo] };
      }
      return {
        creada: true,
        cliente: ws.name,
        cuando: r.cuando,
        calendario: r.calendario,
        enPlanificador: r.enPlanificador,
        ...(r.planningId ? { produccionId: r.planningId } : { nota: "Ya está en el CRM; entra al Planificador con el sync del CRM en unos minutos." }),
        contactoDeLaCita: r.contacto,
        avisados: r.avisados,
        advertencias: avisos,
      };
    },
  },
];
