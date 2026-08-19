import type { Response } from "express";
import { AuthRequest } from "../types/AuthRequest";
import models from "../models";
import { CustomError } from "../errors/customError.error";
import * as billingPortalService from "../services/billingPortal.service";

function handleError(res: Response, error: unknown, fallback: string) {
  if (error instanceof CustomError) {
    res.status(error.status).json({ message: error.message });
    return;
  }
  console.error(`[billingPortal] ${fallback}:`, error);
  res.status(500).json({ message: fallback });
}

/** GET /api/workspaces/:workspaceId/finance-billing */
export async function getFinanceBilling(req: AuthRequest, res: Response): Promise<void> {
  try {
    const workspaceId = String(req.params.workspaceId);
    const data = await billingPortalService.getBilling(workspaceId);
    res.status(200).json(data);
  } catch (error) {
    handleError(res, error, "No se pudo obtener la facturación.");
  }
}

/** POST /api/workspaces/:workspaceId/finance-billing/checkout — body: { invoiceId } */
export async function createFinanceCheckout(req: AuthRequest, res: Response): Promise<void> {
  try {
    const workspaceId = String(req.params.workspaceId);
    const { invoiceId } = req.body ?? {};

    if (typeof invoiceId !== "string" || !invoiceId.trim()) {
      res.status(400).json({ message: "La factura (invoiceId) es requerida." });
      return;
    }

    // El returnUrl se arma server-side para que nadie redirija el checkout a
    // dominios ajenos. APP_URL es el frontend de metrics.
    const appUrl = (process.env.APP_URL || "http://localhost:5173").replace(/\/+$/, "");
    const returnUrl = `${appUrl}/workspaces/${workspaceId}/facturacion`;

    const data = await billingPortalService.createCheckout(workspaceId, invoiceId.trim(), returnUrl);
    res.status(201).json(data);
  } catch (error) {
    handleError(res, error, "No se pudo generar el link de pago.");
  }
}

/** POST /api/workspaces/:workspaceId/finance-billing/submissions — multipart: receipt + montos */
export async function submitFinanceReceipt(req: AuthRequest, res: Response): Promise<void> {
  try {
    const workspaceId = String(req.params.workspaceId);

    if (!req.file?.buffer) {
      res.status(400).json({ message: "Falta el comprobante de la transferencia." });
      return;
    }

    const { grossAmount, feeAmount, invoiceId } = req.body ?? {};
    if (!grossAmount) {
      res.status(400).json({ message: "El monto enviado (grossAmount) es requerido." });
      return;
    }

    // El nombre/email salen de la sesión, no del formulario: el comprobante
    // queda firmado por quien realmente lo subió.
    const user = await models.users.findById(req.user!._id).select("name email").lean();

    const data = await billingPortalService.submitReceipt(workspaceId, {
      buffer: req.file.buffer,
      filename: req.file.originalname || "comprobante",
      mimetype: req.file.mimetype,
      fields: {
        invoiceId,
        grossAmount: String(grossAmount),
        feeAmount: feeAmount !== undefined ? String(feeAmount) : undefined,
        submittedByName: (user as { name?: string } | null)?.name || req.user!.email,
        submittedByEmail: (user as { email?: string } | null)?.email || req.user!.email,
      },
    });

    res.status(201).json(data);
  } catch (error) {
    handleError(res, error, "No se pudo subir el comprobante.");
  }
}
