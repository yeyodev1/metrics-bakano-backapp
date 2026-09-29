import { Router, type Response } from "express";
import { Types } from "mongoose";
import { authMiddleware } from "../middlewares/auth.middleware";
import { internalOrSuperadminMiddleware } from "../middlewares/internalOrSuperadmin.middleware";
import type { AuthRequest } from "../types/AuthRequest";
import { estadoPagoService } from "../services/estadoPago.service";
import { pagosClienteService } from "../services/pagosCliente.service";
import { destacarClienteService } from "../services/destacarCliente.service";

/**
 * Lo que el equipo necesita saber de un cliente antes de planificarle: si
 * esta al dia (si no, no vera los guiones) y que quiere destacar.
 */
const contextoClienteRouter = Router();
contextoClienteRouter.use(authMiddleware, internalOrSuperadminMiddleware);

// GET /api/contexto-cliente/:workspaceId
contextoClienteRouter.get("/:workspaceId", async (req: AuthRequest, res: Response) => {
  const workspaceId = req.params["workspaceId"] as string;
  if (!Types.ObjectId.isValid(workspaceId)) {
    res.status(400).json({ message: "workspaceId inválido." });
    return;
  }
  try {
    const [estado, bloqueo, destacar] = await Promise.all([
      pagosClienteService.estado(workspaceId),
      estadoPagoService.bloqueo(workspaceId),
      destacarClienteService.de(workspaceId),
    ]);
    res.status(200).json({
      pago: {
        vinculado: estado.vinculado,
        alDia: !bloqueo,
        deudaTexto: bloqueo?.deudaTexto ?? null,
        facturasVencidas: bloqueo?.facturasVencidas ?? 0,
      },
      destacar: destacar.actual ?? null,
    });
  } catch (error: any) {
    console.error("contextoCliente error:", error?.message || error);
    res.status(500).json({ message: "No se pudo cargar el contexto del cliente." });
  }
});

export default contextoClienteRouter;
