/**
 * Quien puede mover un paso del onboarding.
 *
 * Cada responsable marca SU paso: Joel la especializacion, Ariana el
 * levantamiento, Karen y Jean la produccion. Los superadmin y Genesis, que
 * coordina el onboarding de punta a punta, pueden marcar cualquiera. Asi el
 * avance lo firma quien hizo el trabajo y nadie cierra por error el paso de
 * otro.
 *
 * Los pasos sin responsable (los que dependen del cliente, como aprobar los
 * videos) los puede mover cualquiera del equipo.
 */

/** Coordinan el onboarding: pueden marcar todos los pasos. */
export const COORDINAN_ONBOARDING = ["gbenalcazar@bakano.ec"];

export function puedeMarcarPaso(
  usuario: { role?: string | null; email?: string | null } | undefined,
  responsables: (string | undefined)[]
): boolean {
  if (!usuario) return false;
  if (usuario.role === "superadmin") return true;
  const email = (usuario.email || "").trim().toLowerCase();
  if (COORDINAN_ONBOARDING.includes(email)) return true;
  const correos = responsables.filter(Boolean).map((c) => String(c).toLowerCase());
  if (!correos.length) return true;
  return correos.includes(email);
}
