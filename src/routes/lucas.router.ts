import { Router, type Request, type Response } from "express";
import { Types } from "mongoose";
import models from "../models";
import { limpiarVentas } from "../controllers/brandProfile.controller";

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

export default lucasRouter;
