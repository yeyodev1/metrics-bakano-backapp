import { Router, Response, NextFunction } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { internalOrSuperadminMiddleware } from "../middlewares/internalOrSuperadmin.middleware";
import { incidentesService } from "../services/incidentes.service";
import type { AuthRequest } from "../types/AuthRequest";

/**
 * Incidentes de clientes detectados por el bot. Los ve TODO el equipo interno:
 * lo propio y lo de los demas, que es justo lo que antes se perdia en correos
 * que cada quien leia por su cuenta.
 */
export const incidenteRouter = Router();

incidenteRouter.use(authMiddleware, internalOrSuperadminMiddleware);

incidenteRouter.get("/", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { estado, workspaceId, mios, limite } = req.query as Record<string, string>;
    const datos = await incidentesService.listar({
      estado,
      workspaceId,
      correo: req.user?.email,
      mios: mios === "true",
      limite: limite ? Number(limite) : undefined,
    });
    res.status(200).send(datos);
  } catch (error) {
    next(error);
  }
});

incidenteRouter.get("/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const incidente = await incidentesService.uno(req.params["id"] as string);
    if (!incidente) {
      res.status(404).send({ message: "Ese incidente no existe." });
      return;
    }
    res.status(200).send({ incidente });
  } catch (error) {
    next(error);
  }
});

incidenteRouter.patch("/:id/tomar", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const incidente = await incidentesService.tomar(req.params["id"] as string, req.user as any);
    res.status(200).send({ message: "Tomaste el caso.", incidente });
  } catch (error: any) {
    if (error.message === "NOT_FOUND") {
      res.status(404).send({ message: "Ese incidente ya lo tomó alguien más." });
      return;
    }
    next(error);
  }
});

incidenteRouter.patch("/:id/cerrar", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const incidente = await incidentesService.cerrar(req.params["id"] as string, req.user as any, req.body?.nota);
    res.status(200).send({ message: "Incidente cerrado.", incidente });
  } catch (error: any) {
    if (error.message === "NOT_FOUND") {
      res.status(404).send({ message: "Incidente no encontrado." });
      return;
    }
    next(error);
  }
});
