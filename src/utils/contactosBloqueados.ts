import models from "../models";

/**
 * Personas a las que el sistema NO contacta bajo ningun concepto: ni correo,
 * ni Slack, ni notificacion de la plataforma. Decision de direccion.
 *
 * Se aplica en el origen de cada canal (resend.service, slack.service,
 * notification.service) para que ninguna funcion nueva lo pueda saltar por
 * olvido, aunque avise "a todos los superadmins".
 *
 * Se bloquea por correo y por nombre: si la persona tiene otro correo en la
 * base, tambien queda fuera. CONTACTOS_BLOQUEADOS suma correos por variable.
 */
const CORREOS_FIJOS = ["lreyes@bakano.ec"];
const NOMBRES_FIJOS = [/\bluis\b.*\breyes\b/i];
const CACHE_MS = 10 * 60_000;

let cache: { en: number; correos: Set<string>; ids: Set<string> } | null = null;

function correosDeEntorno(): string[] {
  return (process.env.CONTACTOS_BLOQUEADOS || "")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
}

async function cargar(): Promise<{ correos: Set<string>; ids: Set<string> }> {
  if (cache && Date.now() - cache.en < CACHE_MS) return cache;
  const correos = new Set([...CORREOS_FIJOS, ...correosDeEntorno()]);
  // Por nombre se busca amplio ("Luis" en name) y se confirma con el nombre
  // completo abajo: el apellido puede estar en `name` o en `lastName`.
  const usuarios = await models.users
    .find({ $or: [{ email: { $in: [...correos] } }, { name: /\bluis\b/i }] })
    .select("_id email name lastName")
    .lean()
    .catch(() => [] as any[]);
  const ids = new Set<string>();
  for (const u of usuarios as any[]) {
    const completo = `${u.name || ""} ${u.lastName || ""}`;
    // Por nombre solo si es "Luis ... Reyes" completo, para no bloquear a otro Luis.
    if (correos.has(String(u.email).toLowerCase()) || NOMBRES_FIJOS.some((re) => re.test(completo))) {
      ids.add(String(u._id));
      if (u.email) correos.add(String(u.email).toLowerCase());
    }
  }
  cache = { en: Date.now(), correos, ids };
  return cache;
}

function correoDe(valor: string): string {
  const m = valor.match(/<([^>]+)>/);
  return (m ? m[1] : valor).trim().toLowerCase();
}

export async function correoBloqueado(correo: string): Promise<boolean> {
  return (await cargar()).correos.has(correoDe(correo));
}

export async function usuarioBloqueado(userId: string | { toString(): string }): Promise<boolean> {
  return (await cargar()).ids.has(String(userId));
}

/** Quita a los bloqueados de una lista (o de un solo destinatario). */
export async function sinBloqueados<T extends string | string[] | undefined>(destinatarios: T): Promise<T> {
  if (!destinatarios) return destinatarios;
  const { correos } = await cargar();
  if (Array.isArray(destinatarios)) {
    return destinatarios.filter((d) => !correos.has(correoDe(d))) as T;
  }
  return (correos.has(correoDe(destinatarios as string)) ? undefined : destinatarios) as T;
}
