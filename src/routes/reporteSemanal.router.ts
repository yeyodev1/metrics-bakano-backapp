import { Router, Response, NextFunction } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { internalOrSuperadminMiddleware } from "../middlewares/internalOrSuperadmin.middleware";
import { AuthRequest } from "../types/AuthRequest";
import { reporteSemanalService } from "../services/reporteSemanal.service";

/**
 * Reporte semanal (viernes 6 pm Ecuador). Lo envia el cron; aqui el equipo
 * lo previsualiza sin enviar y puede mandarse una prueba a un correo.
 */
const reporteSemanalRouter = Router();
reporteSemanalRouter.use(authMiddleware, internalOrSuperadminMiddleware);

// GET /api/reporte-semanal/consolidado/preview — lo que recibiria direccion.
reporteSemanalRouter.get("/consolidado/preview", async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const c = await reporteSemanalService.consolidado();
    res.json({ clientes: c.filas.length, equipo: c.equipo, telegram: c.telegram, correoHtml: c.correoHtml });
  } catch (error) {
    next(error);
  }
});

// GET /api/reporte-semanal/:workspaceId/preview — el reporte del cliente, sin enviar.
reporteSemanalRouter.get("/:workspaceId/preview", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await reporteSemanalService.previsualizar(String(req.params["workspaceId"])));
  } catch (error: any) {
    if (error?.message === "INVALID_ID" || error?.message === "NOT_FOUND") {
      res.status(404).json({ message: "Cliente no encontrado." });
      return;
    }
    next(error);
  }
});

// POST /api/reporte-semanal/:workspaceId/prueba { correo } — solo a ese correo.
reporteSemanalRouter.post("/:workspaceId/prueba", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const correo = String(req.body?.correo || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
      res.status(400).json({ message: "Pon un correo válido para la prueba." });
      return;
    }
    const { reporte } = await reporteSemanalService.generar(String(req.params["workspaceId"]));
    await reporteSemanalService.enviarCliente(reporte, correo);
    res.json({ message: `Prueba enviada a ${correo}.` });
  } catch (error: any) {
    if (error?.message === "INVALID_ID" || error?.message === "NOT_FOUND") {
      res.status(404).json({ message: "Cliente no encontrado." });
      return;
    }
    next(error);
  }
});

export default reporteSemanalRouter;
