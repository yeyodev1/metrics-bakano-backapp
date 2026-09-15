import type { Request, Response } from "express";
import { soporteService } from "../services/soporte.service";

/**
 * POST /v1/webhooks/soporte-email
 *
 * Resend avisa (`email.received`) cuando llega un correo a su direccion de
 * recepcion, a la que Google reenvia soporte@bakano.ec. Firmado con Svix:
 * secreto `RESEND_INBOUND_WEBHOOK_SECRET` (el `whsec_…` de ese webhook en
 * Resend). Distinto de RESEND_WEBHOOK_SECRET, que usa el webhook de aperturas.
 *
 * Responde 200 aun con error de proceso: el ticket ya quedo creado y un
 * reintento de Resend solo daria "duplicado".
 */
export async function recibirCorreoSoporte(req: Request, res: Response): Promise<void> {
  const secreto = process.env.RESEND_INBOUND_WEBHOOK_SECRET;
  if (!secreto) {
    res.status(503).json({ message: "El soporte por correo no está configurado." });
    return;
  }
  const cuerpo = (req as Request & { rawBody?: string }).rawBody;
  if (!cuerpo || !soporteService.verificarFirma(cuerpo, req.headers, secreto)) {
    res.status(401).json({ message: "Firma inválida." });
    return;
  }

  try {
    res.status(200).json(await soporteService.procesar(req.body));
  } catch (error) {
    console.error("[Soporte] error procesando correo:", error);
    res.status(200).json({ ok: false });
  }
}
