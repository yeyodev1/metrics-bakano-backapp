import type { Response } from "express";
import { AuthRequest } from "../types/AuthRequest";
import { billingService } from "../services/billing.service";

/**
 * POST /api/billing/:workspaceId
 * Creates a billing entry for the authenticated user in the workspace.
 * Body: { amount: number, notes?: string }
 */
export async function createBillingEntry(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { workspaceId } = req.params;
    const userId = req.user!._id;
    const { amount, notes, date } = req.body;

    if (amount === undefined || amount === null) {
      res.status(400).json({ message: "El monto (amount) es requerido." });
      return;
    }

    if (typeof amount !== "number" || amount < 0) {
      res.status(400).json({ message: "El monto debe ser un número mayor o igual a 0." });
      return;
    }

    // Validate optional date param (YYYY-MM-DD)
    let entryDate: Date | undefined;
    if (date) {
      const parsed = new Date(date + "T12:00:00Z");
      if (isNaN(parsed.getTime())) {
        res.status(400).json({ message: "Fecha inválida. Use el formato YYYY-MM-DD." });
        return;
      }
      // Reject future dates only
      const todayEcuador = billingService.normalizeDateToEcuador(new Date());
      const targetEcuador = billingService.normalizeDateToEcuador(parsed);
      if (targetEcuador.getTime() > todayEcuador.getTime()) {
        res.status(400).json({ message: "No puedes registrar facturación para fechas futuras." });
        return;
      }
      // Allow any past date — no limit on how far back
      entryDate = parsed;
    }

    const entry = await billingService.createEntry(workspaceId as string, userId as string, amount, notes, entryDate);

    res.status(201).json({ message: "Entrada de facturación registrada exitosamente.", entry });
  } catch (error: any) {
    if (error.message === "WORKSPACE_NOT_FOUND") {
      res.status(404).json({ message: "Workspace no encontrado." });
      return;
    }
    if (error.message === "USER_NOT_FOUND") {
      res.status(404).json({ message: "Usuario no encontrado." });
      return;
    }
    if (error.message === "ENTRY_ALREADY_EXISTS") {
      res.status(409).json({ message: "Ya tienes una entrada registrada para ese día." });
      return;
    }
    console.error("[BillingController] createBillingEntry error:", error);
    res.status(500).json({ message: "Error interno al registrar la facturación." });
  }
}

/**
 * GET /api/billing/:workspaceId/month
 * Query params: ?year=2026&month=3
 * Returns all billing entries for the workspace grouped by day.
 */
export async function getMonthBilling(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { workspaceId } = req.params;
    const year = parseInt(req.query["year"] as string, 10);
    const month = parseInt(req.query["month"] as string, 10);

    if (!year || !month || isNaN(year) || isNaN(month) || month < 1 || month > 12) {
      res.status(400).json({ message: "Parámetros year y month son requeridos y deben ser válidos." });
      return;
    }

    const result = await billingService.getMonthEntries(workspaceId as string, year, month);

    res.status(200).json({ message: "Facturación del mes obtenida.", ...result });
  } catch (error: any) {
    console.error("[BillingController] getMonthBilling error:", error);
    res.status(500).json({ message: "Error interno al obtener la facturación del mes." });
  }
}

/**
 * GET /api/billing/:workspaceId/day
 * Query param: ?date=2026-03-30
 * Returns the billing summary for a specific day.
 */
export async function getDayBilling(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { workspaceId } = req.params;
    const dateParam = req.query["date"] as string;

    if (!dateParam) {
      res.status(400).json({ message: "El parámetro date es requerido (formato: YYYY-MM-DD)." });
      return;
    }

    const parsed = new Date(dateParam + "T12:00:00Z"); // noon UTC to avoid timezone edge cases
    if (isNaN(parsed.getTime())) {
      res.status(400).json({ message: "Fecha inválida. Use el formato YYYY-MM-DD." });
      return;
    }

    const summary = await billingService.getDaySummary(workspaceId as string, parsed);

    res.status(200).json({ message: "Resumen del día obtenido.", ...summary });
  } catch (error: any) {
    console.error("[BillingController] getDayBilling error:", error);
    res.status(500).json({ message: "Error interno al obtener el resumen del día." });
  }
}

/**
 * PUT /api/billing/:workspaceId/entry/:entryId
 * Updates a billing entry. Body: { amount: number, notes?: string }
 */
export async function updateBillingEntry(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { workspaceId, entryId } = req.params;
    const requesterId = req.user!._id;
    const requesterRole = req.user!.role;
    const { amount, notes } = req.body;

    if (amount === undefined || amount === null) {
      res.status(400).json({ message: "El monto (amount) es requerido." });
      return;
    }

    if (typeof amount !== "number" || amount < 0) {
      res.status(400).json({ message: "El monto debe ser un número mayor o igual a 0." });
      return;
    }

    const entry = await billingService.updateEntry(
      entryId as string,
      workspaceId as string,
      requesterId as string,
      requesterRole as string,
      amount,
      notes
    );

    res.status(200).json({ message: "Entrada de facturación actualizada.", entry });
  } catch (error: any) {
    if (error.message === "ENTRY_NOT_FOUND") {
      res.status(404).json({ message: "Entrada de facturación no encontrada." });
      return;
    }
    if (error.message === "EDIT_NOT_ALLOWED") {
      res.status(403).json({ message: "Solo puedes editar entradas de los últimos 7 días." });
      return;
    }
    console.error("[BillingController] updateBillingEntry error:", error);
    res.status(500).json({ message: "Error interno al actualizar la entrada." });
  }
}

/**
 * GET /api/billing/:workspaceId/my-entry-today
 * Returns the authenticated user's entry for today, if it exists.
 */
export async function getMyEntryToday(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { workspaceId } = req.params;
    const userId = req.user!._id;

    const entry = await billingService.getUserEntryForDay(userId as string, workspaceId as string, new Date());

    res.status(200).json({
      message: entry ? "Entrada encontrada para hoy." : "No tienes entrada registrada para hoy.",
      hasEntry: !!entry,
      entry: entry || null,
    });
  } catch (error: any) {
    console.error("[BillingController] getMyEntryToday error:", error);
    res.status(500).json({ message: "Error interno al verificar la entrada del día." });
  }
}
