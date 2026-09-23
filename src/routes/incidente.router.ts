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
    const { estado, workspaceId, mios, buscar, pagina, limite } = req.query as Record<string, string>;
    const datos = await incidentesService.listar({
      estado,
      workspaceId,
      correo: req.user?.email,
      mios: mios === "true",
      buscar,
      pagina: pagina ? Number(pagina) : undefined,
      limite: limite ? Number(limite) : undefined,
    });
    res.status(200).send(datos);
  } catch (error) {
    next(error);
  }
});

/** El equipo al que se le puede asignar un caso. */
incidenteRouter.get("/equipo", async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.status(200).send({ equipo: await incidentesService.equipo() });
  } catch (error) {
    next(error);
  }
});

incidenteRouter.patch("/:id/asignar", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const incidente = await incidentesService.asignar(
      req.params["id"] as string,
      req.body?.userId,
      req.user as any,
      req.body?.nota
    );
    res.status(200).send({ message: "Caso asignado.", incidente });
  } catch (error: any) {
    if (error.message === "NOT_FOUND" || error.message === "INVALID_ID") {
      res.status(404).send({ message: "Incidente no encontrado." });
      return;
    }
    if (error.message === "USUARIO_NO_ENCONTRADO") {
      res.status(404).send({ message: "Esa persona no está en el equipo." });
      return;
    }
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
