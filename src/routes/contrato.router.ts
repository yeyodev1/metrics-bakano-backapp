import { Router, type Request, type Response } from "express";
import { contratoModelo } from "../services/contratoModelo.service";
import { onboardingService } from "../services/onboarding.service";

/**
 * El contrato modelo, público: es el que se le manda a un prospecto antes de
 * cerrar la venta para que lo lea con calma. Sin datos de nadie.
 */
const contratoRouter = Router();

contratoRouter.get("/modelo", (_req: Request, res: Response) => {
  res.status(200).send(contratoModelo());
});

contratoRouter.get("/modelo.pdf", async (_req: Request, res: Response) => {
  try {
    const pdf = await onboardingService.generateContractPDF(contratoModelo().datos as any, { borrador: true });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="contrato_bakano_modelo.pdf"');
    res.status(200).send(pdf);
  } catch (error) {
    console.error("contrato modelo pdf:", error);
    res.status(500).send({ error: "No se pudo generar el PDF." });
  }
});

export default contratoRouter;
