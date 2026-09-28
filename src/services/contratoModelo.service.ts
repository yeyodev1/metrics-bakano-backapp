import { BAKANO_LEGAL, CONTRATO_VERSION_ACTUAL, PAUTA_MINIMA, TITULO_CONTRATO, clausulasContrato } from "./contratoTexto";

const APP_URL = process.env.APP_URL || "https://metrics.bakano.ec";
export const LINK_CONTRATO_MODELO = `${APP_URL}/contrato`;

/** Datos guía en lugar de los del cliente: se ve qué se completa al contratar. */
const DATOS_MODELO = {
  nombreCliente: "[Nombre o razón social del cliente]",
  rucCliente: "[RUC o cédula]",
  representanteCliente: "[Representante legal]",
  pautaModelo: `[monto acordado, mínimo $${PAUTA_MINIMA}]`,
  version: CONTRATO_VERSION_ACTUAL,
};

/** El contrato vigente sin datos de nadie. */
export function contratoModelo() {
  return {
    titulo: TITULO_CONTRATO,
    version: CONTRATO_VERSION_ACTUAL,
    bakano: BAKANO_LEGAL,
    clausulas: clausulasContrato(DATOS_MODELO),
    datos: DATOS_MODELO,
  };
}
