import { Router, type Request, type Response } from "express";
import { Types } from "mongoose";
import models from "../models";
import { limpiarVentas } from "../controllers/brandProfile.controller";
import { estadoMetricsService } from "../services/estadoMetrics.service";
import { ventasCrmService } from "../services/ventasCrm.service";

/**
 * Lucas (el agente de ventas por WhatsApp) guarda aquí lo que el negocio le
 * cuenta con /negocio, /pago y /regla, para que Metrics y Lucas tengan la
 * misma información. Lucas lee directo de la base; solo escribe por aquí.
 *
 * Servidor a servidor: la misma llave que ya comparten para Finanzas
 * (METRICS_PROXY_KEY aquí, FINANCES_PORTAL_KEY en Lucas).
 */
const lucasRouter = Router();

lucasRouter.use((req, res, next) => {
  const llave = process.env.METRICS_PROXY_KEY;
  if (!llave || req.headers["x-metrics-key"] !== llave) {
    res.status(401).send({ message: "Llave inválida." });
    return;
  }
  next();
});

lucasRouter.put("/negocio/:workspaceId", async (req: Request, res: Response) => {
  const id = String(req.params.workspaceId || "");
  if (!Types.ObjectId.isValid(id)) {
    res.status(400).send({ message: "Entorno inválido." });
    return;
  }
  const ventas = limpiarVentas(req.body || {});
  if (!Object.keys(ventas).length) {
    res.status(400).send({ message: "Nada que guardar." });
    return;
  }
  try {
    // brandProfile puede estar en null: se crea vacío antes de escribir adentro.
    await models.workspaces.updateOne(
      { _id: id, $or: [{ brandProfile: null }, { brandProfile: { $exists: false } }] },
      { $set: { brandProfile: { descripcion: "", vertical: "", trafficLink: "", archivos: [] } } }
    );
    const set: Record<string, unknown> = {
      "brandProfile.ventasActualizadoEn": new Date(),
      "brandProfile.ventasFuente": "lucas",
    };
    for (const [k, v] of Object.entries(ventas)) set[`brandProfile.${k}`] = v;
    const r = await models.workspaces.updateOne({ _id: id }, { $set: set });
    if (!r.matchedCount) {
      res.status(404).send({ message: "Entorno no encontrado." });
      return;
    }
    res.status(200).send({ ok: true });
  } catch (error: any) {
    console.error("[Lucas] guardar negocio:", error?.message || error);
    res.status(500).send({ message: "No se pudo guardar." });
  }
});

/**
 * Lo que hay en Metrics del negocio (contrato, archivos, citas, guiones,
 * videos, CRM...), la misma foto que ve el bot de Bakano.
 */
lucasRouter.get("/estado/:workspaceId", async (req: Request, res: Response) => {
  try {
    const estado = await estadoMetricsService.de(String(req.params.workspaceId || ""));
    if (!estado) {
      res.status(404).send({ message: "Entorno no encontrado." });
      return;
    }
    res.status(200).send(estado);
  } catch (error: any) {
    console.error("[Lucas] estado:", error?.message || error);
    res.status(500).send({ message: "No se pudo leer el entorno." });
  }
});

/**
 * Las ventas abiertas del CRM del negocio, por asesor, con la conversacion
 * de cada una. `?email=` filtra a un asesor (el vendedor que pregunta por lo
 * suyo). Nunca sale un token.
 */
lucasRouter.get("/crm/:workspaceId/ventas", async (req: Request, res: Response) => {
  try {
    const email = typeof req.query.email === "string" ? req.query.email : undefined;
    const max = Number(req.query.max) || undefined;
    res.status(200).send(await ventasCrmService.porAsesor(String(req.params.workspaceId || ""), { email, max }));
  } catch (error: any) {
    console.error("[Lucas] ventas CRM:", error?.message || error);
    res.status(200).send({ disponible: false, motivo: "No pude leer el CRM del negocio ahora." });
  }
});

/** Lo que el CRM sabe de un lead por su telefono. */
lucasRouter.get("/crm/:workspaceId/contacto", async (req: Request, res: Response) => {
  const telefono = typeof req.query.telefono === "string" ? req.query.telefono : "";
  if (!telefono) {
    res.status(400).send({ message: "Falta el teléfono." });
    return;
  }
  try {
    res.status(200).send(await ventasCrmService.delContacto(String(req.params.workspaceId || ""), telefono));
  } catch (error: any) {
    console.error("[Lucas] contacto CRM:", error?.message || error);
    res.status(200).send({ disponible: false, motivo: "No pude leer el CRM del negocio ahora." });
  }
});

export default lucasRouter;
