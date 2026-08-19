import { NextFunction, Response } from "express";
import { HttpStatusCode } from "axios";
import { AuthRequest } from "../types/AuthRequest";
import { videoReviewNotificationService } from "../services/videoReviewNotification.service";

/**
 * POST /api/video-planning/:planningId/notify-review
 * El equipo avisa al cliente que sus videos estan listos para revision.
 * El tipo (primer aviso o recordatorio) se deduce solo.
 */
export async function notificarRevisionVideos(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const planningId = String(req.params["planningId"]);
    const porNombre = req.user?.email;

    const resultado = await videoReviewNotificationService.notificar(planningId, porNombre);

    const alguno = resultado.whatsapp.enviado || resultado.email.enviado;
    res.status(alguno ? HttpStatusCode.Ok : HttpStatusCode.BadGateway).send({
      message: alguno
        ? "Aviso de revision enviado al cliente."
        : "No se pudo enviar el aviso por ningun canal.",
      resultado,
    });
  } catch (error: any) {
    if (error.message === "NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).send({ message: "Planificacion no encontrada." });
      return;
    }
    if (error.message === "WORKSPACE_NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).send({ message: "El entorno de esta planificacion no existe." });
      return;
    }
    if (error.message === "SIN_VIDEOS_EDITADOS") {
      res.status(HttpStatusCode.Conflict).send({
        message: "Todavia no hay videos editados en esta planificacion: no hay nada que el cliente pueda revisar.",
      });
      return;
    }
    if (error.message === "YA_REVISADO") {
      res.status(HttpStatusCode.Conflict).send({
        message: "El cliente ya reviso estos videos: no tiene sentido volver a avisarle.",
      });
      return;
    }
    next(error);
  }
}

/**
 * POST /api/video-planning/:planningId/video-review
 * El cliente entrega su veredicto sobre los videos terminados. Cuando no
 * queda ninguno pendiente se cierra el ciclo y se confirma con el aviso
 * "revisado".
 */
export async function registrarRevisionVideos(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const planningId = String(req.params["planningId"]);
    const { reviews } = req.body ?? {};

    if (!Array.isArray(reviews) || !reviews.length) {
      res.status(HttpStatusCode.BadRequest).send({
        message: "Envia al menos un video con su veredicto (APROBADO o RECHAZADO).",
      });
      return;
    }

    const resultado = await videoReviewNotificationService.registrarRevision(
      planningId,
      reviews,
      req.user?._id ? String(req.user._id) : undefined
    );

    res.status(HttpStatusCode.Ok).send({
      message: resultado.cicloCerrado
        ? "Revision completa. Gracias, ya avisamos al equipo."
        : `Revision guardada. Quedan ${resultado.pendientes} videos por revisar.`,
      ...resultado,
    });
  } catch (error: any) {
    if (error.message === "NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).send({ message: "Planificacion no encontrada." });
      return;
    }
    if (error.message === "REVISION_CERRADA") {
      res.status(HttpStatusCode.Conflict).send({
        message: "Esta revision ya fue completada o todavia no fue enviada al cliente.",
      });
      return;
    }
    if (error.message === "MOTIVO_REQUERIDO") {
      res.status(HttpStatusCode.BadRequest).send({
        message: "Para rechazar un video hay que decir el motivo: es lo que el editor necesita para corregirlo.",
      });
      return;
    }
    next(error);
  }
}

/**
 * GET /api/video-planning/pending-review?workspaceId=...
 * Que revision le toca a un entorno. Es lo que resuelve el enlace fijo del
 * WhatsApp de revision al aterrizar.
 */
export async function revisionPendiente(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = String(req.query.workspaceId ?? "");
    if (!workspaceId) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Falta workspaceId." });
      return;
    }

    const pendiente = await videoReviewNotificationService.pendienteDeRevisar(workspaceId);
    res.status(HttpStatusCode.Ok).send({ pendiente });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/video-planning/:planningId/review-notifications
 * Auditoria del circuito: que aviso salio, cuando, por que canal y con que
 * resultado.
 */
export async function historialAvisosRevision(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const planningId = String(req.params["planningId"]);
    const historial = await videoReviewNotificationService.historial(planningId);
    res.status(HttpStatusCode.Ok).send(historial);
  } catch (error: any) {
    if (error.message === "NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).send({ message: "Planificacion no encontrada." });
      return;
    }
    next(error);
  }
}
