/**
 * Normalización de teléfonos a E.164 (el formato que espera WhatsApp).
 *
 * La gente escribe el mismo número de tres formas: 0995254965, 995254965 o
 * 593995254965. Si se guardan tal cual, el webhook recibe basura y el mensaje
 * no llega — sin error visible, que es lo peor. Aquí se guarda siempre igual.
 */

export interface Pais {
  codigo: string;
  nombre: string;
  /** Prefijo internacional, sin el +. */
  prefijo: string;
  /** Dígitos del número nacional, ya sin el 0 inicial. */
  largoNacional: number;
}

/** Ecuador primero: es donde está la mayoría de clientes. */
export const PAISES: Pais[] = [
  { codigo: "EC", nombre: "Ecuador", prefijo: "593", largoNacional: 9 },
  { codigo: "CO", nombre: "Colombia", prefijo: "57", largoNacional: 10 },
  { codigo: "PE", nombre: "Perú", prefijo: "51", largoNacional: 9 },
  { codigo: "MX", nombre: "México", prefijo: "52", largoNacional: 10 },
  { codigo: "US", nombre: "Estados Unidos", prefijo: "1", largoNacional: 10 },
  { codigo: "ES", nombre: "España", prefijo: "34", largoNacional: 9 },
  { codigo: "AR", nombre: "Argentina", prefijo: "54", largoNacional: 10 },
  { codigo: "CL", nombre: "Chile", prefijo: "56", largoNacional: 9 },
];

export function paisPorPrefijo(prefijo: string): Pais | undefined {
  return PAISES.find((p) => p.prefijo === prefijo.replace("+", ""));
}

export interface TelefonoNormalizado {
  valido: boolean;
  /** Listo para WhatsApp: solo dígitos, con prefijo. Ej: 593995254965 */
  e164: string;
  /** Para mostrar. Ej: +593 99 525 4965 */
  legible: string;
  error?: string;
}

/**
 * Acepta las tres formas y devuelve siempre la misma.
 *
 * @param entrada  lo que escribió la persona
 * @param prefijo  el país elegido en el selector
 */
export function normalizarTelefono(entrada: string, prefijo: string): TelefonoNormalizado {
  const pais = paisPorPrefijo(prefijo);
  const fallo = (error: string): TelefonoNormalizado => ({
    valido: false,
    e164: "",
    legible: "",
    error,
  });

  if (!pais) return fallo("País no reconocido.");

  let digitos = (entrada || "").replace(/\D/g, "");
  if (!digitos) return fallo("Escribe el número.");

  // 593995254965 → ya trae el prefijo del país elegido
  if (digitos.startsWith(pais.prefijo) && digitos.length > pais.largoNacional) {
    digitos = digitos.slice(pais.prefijo.length);
  }

  // 0995254965 → el 0 es para llamar dentro del país, no viaja en E.164
  if (digitos.length === pais.largoNacional + 1 && digitos.startsWith("0")) {
    digitos = digitos.slice(1);
  }

  if (digitos.length !== pais.largoNacional) {
    return fallo(
      `Un número de ${pais.nombre} tiene ${pais.largoNacional} dígitos; escribiste ${digitos.length}.`
    );
  }

  const e164 = `${pais.prefijo}${digitos}`;
  const grupos = digitos.replace(/(\d{2})(\d{3})(\d+)/, "$1 $2 $3");

  return { valido: true, e164, legible: `+${pais.prefijo} ${grupos}` };
}
