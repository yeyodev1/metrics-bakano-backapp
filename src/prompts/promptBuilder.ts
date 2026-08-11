/**
 * Assembles the system instruction for script generation.
 *
 * Order matters — later blocks are meant to win over earlier ones:
 *   base (style rules + few-shots) → framework(vertical) → objetivo → engram
 *
 * The engram goes last on purpose: what this brand's own numbers proved
 * outranks any general rule.
 */
import type { IBrandProfile } from "../models/workspace.model";
import type { ObjetivoGuion } from "../models/videoPlanning.model";
import { getFrameworkBlock, inferVertical, type VerticalKind } from "./scriptFramework";
import { getObjetivoBlock } from "./objetivo";

export interface BuildSystemInstructionParams {
  base: string;
  brandProfile: Pick<IBrandProfile, "tipoNegocio" | "vertical">;
  objetivo?: ObjetivoGuion;
  engramBlock?: string;
}

export interface BuiltInstruction {
  systemInstruction: string;
  vertical: VerticalKind;
  objetivo: ObjetivoGuion;
}

export function buildSystemInstruction(
  params: BuildSystemInstructionParams
): BuiltInstruction {
  const { base, brandProfile, engramBlock } = params;

  const vertical = inferVertical(brandProfile);
  // Feed is the safe default: an organic script shown as an ad underperforms,
  // but an ad-style script in the feed burns the audience.
  const objetivo: ObjetivoGuion = params.objetivo ?? "feed";

  const sections = [base, getFrameworkBlock(vertical), getObjetivoBlock(objetivo)];

  if (engramBlock) {
    sections.push(
      `${engramBlock}\n\nEstos aprendizajes provienen de los resultados reales de esta marca. Cuando entren en conflicto con las reglas generales de arriba, GANAN los aprendizajes.`
    );
  }

  return {
    systemInstruction: sections.join("\n\n---\n\n"),
    vertical,
    objetivo,
  };
}
