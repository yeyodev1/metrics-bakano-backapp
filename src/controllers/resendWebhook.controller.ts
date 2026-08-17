import type { Request, Response } from "express";
import { HttpStatusCode } from "axios";
import models from "../models";

/**
 * Eventos de Resend: apertura y clic del correo.
 *
 * Resend no avisa por sí solo: hay que dar de alta esta URL en su panel
 * (Webhooks → añadir endpoint, eventos `email.opened` y `email.clicked`).
 * Mientras no se configure, la auditoría muestra los envíos pero nunca
 * aperturas — que es correcto, no un fallo.
 *
 * El emparejamiento se hace por el id del correo, que se guardó al enviarlo.
 */
export async function recibirEventoResend(req: Request, res: Response) {
  try {
    const secreto = process.env.RESEND_WEBHOOK_SECRET;
    if (secreto && req.headers["x-webhook-secret"] !== secreto) {
      res.status(HttpStatusCode.Unauthorized).send({ message: "Firma inválida." });
      return;
    }

    const tipo = req.body?.type as string | undefined;
    const emailId = req.body?.data?.email_id as string | undefined;

    if (!tipo || !emailId) {
      // 200 a propósito: un evento que no entendemos no debe hacer que Resend
      // reintente para siempre.
      res.status(HttpStatusCode.Ok).send({ ignorado: true });
      return;
    }

    const campo =
      tipo === "email.opened"
        ? "notificaciones.$.abiertoEn"
        : tipo === "email.clicked"
        ? "notificaciones.$.clicEn"
        : null;

    if (!campo) {
      res.status(HttpStatusCode.Ok).send({ ignorado: true });
      return;
    }

    await models.videoPlanning.updateOne(
      { "notificaciones.proveedorId": emailId },
      { $set: { [campo]: new Date() } }
    );

    res.status(HttpStatusCode.Ok).send({ ok: true });
    return;
  } catch (error) {
    console.error("Resend webhook error:", error);
    res.status(HttpStatusCode.Ok).send({ ok: false });
    return;
  }
}
