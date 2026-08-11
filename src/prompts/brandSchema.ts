/**
 * Renders the brand's strategic schema for the prompt.
 *
 * The workspace already stored `segmentosMercado`, `canalesDetail`,
 * `actividadesClave` and `customerJourneyCases` — the exact shape of the
 * agency's Drive document — but the generator never sent any of it to the
 * model. That omission is the main reason scripts came out generic and
 * interchangeable between clients.
 */
import type { IBrandProfile, ICustomerJourneyCase } from "../models/workspace.model";

function renderCase(c: ICustomerJourneyCase): string {
  const title = c.nombreCaso ? `${c.nombreCaso}` : `Caso ${c.casoNumero}`;
  return [
    `Caso ${c.casoNumero} — ${title}`,
    `  · Quién es: ${c.potencialCliente || "No especificado"}`,
    `  · Cómo se siente al inicio: ${c.efectoAnuncio || "No especificado"}`,
    `  · Qué obtiene: ${c.accionEsperada || "No especificado"}`,
  ].join("\n");
}

/**
 * @param casoUsoRef Which journey case this script targets. The framework
 *   requires one case per script, so the chosen one is called out explicitly
 *   instead of leaving the model to pick.
 */
export function buildBrandSchemaBlock(
  brandProfile: IBrandProfile,
  casoUsoRef?: number
): string {
  const sections: string[] = ["ESQUEMA ESTRATÉGICO DE LA MARCA:"];

  if (brandProfile.propuestaValor) {
    sections.push(`PROPUESTA DE VALOR:\n${brandProfile.propuestaValor}`);
  }

  const segmentos = brandProfile.segmentosMercado ?? [];
  if (segmentos.length) {
    sections.push(
      "SEGMENTOS DE MERCADO:\n" +
        segmentos
          .map((s, i) => `${i + 1}. ${s.nombre}: ${s.descripcion}`)
          .join("\n")
    );
  }

  const canales = brandProfile.canalesDetail ?? [];
  if (canales.length) {
    sections.push("CANALES:\n" + canales.map((c) => `- ${c}`).join("\n"));
  }

  const actividades = brandProfile.actividadesClave ?? [];
  if (actividades.length) {
    sections.push(
      "ACTIVIDADES CLAVE:\n" + actividades.map((a) => `- ${a}`).join("\n")
    );
  }

  const casos = brandProfile.customerJourneyCases ?? [];
  if (casos.length) {
    sections.push(
      "CUSTOMER JOURNEY:\n" + casos.map(renderCase).join("\n\n")
    );

    const target = casos.find((c) => c.casoNumero === casoUsoRef);
    if (target) {
      sections.push(
        `ESTE GUIÓN APUNTA AL CASO ${target.casoNumero}.\n` +
          `El HOOK 1 debe salir directamente de cómo se siente ese perfil al inicio: "${target.efectoAnuncio}".\n` +
          `El cierre debe apuntar a lo que ese perfil obtiene: "${target.accionEsperada}".\n` +
          `No mezcles los otros casos en este guión.`
      );
    } else {
      sections.push(
        "Elige UN solo caso del Customer Journey para este guión y constrúyelo entero alrededor de ese perfil. Indica cuál elegiste al inicio del campo \"conceptoVisual\"."
      );
    }
  }

  // Only the schema header means nothing on its own.
  return sections.length > 1 ? sections.join("\n\n") : "";
}
