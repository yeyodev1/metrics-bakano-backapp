import type { Response } from "express";
import cloudinary from "../config/cloudinary";
import { billingService } from "../services/billing.service";
import { SalesBookingRequestModel } from "../models/salesBookingRequest.model";
import type { AuthRequest } from "../types/AuthRequest";

const approaches = ["spin", "automatic_paragraph", "direct_service", "catalog"];
const objections = ["price_no_response", "think_about_it", "out_of_budget", "curiosity", "other"];

export async function getSalesEligibility(req: AuthRequest, res: Response): Promise<void> {
  const workspaceId = String(req.params.workspaceId);
  const userId = String(req.user!._id);
  const [request, billingCompletion] = await Promise.all([
    SalesBookingRequestModel.findOne({ workspaceId, userId }).lean(),
    billingService.getCurrentMonthCompletion(userId, workspaceId),
  ]);

  const hasSalesInformation = !!request && request.lostSaleEvidence.length > 0;
  res.json({
    eligible: hasSalesInformation && billingCompletion.isComplete,
    hasSalesInformation,
    isBillingUpToDate: billingCompletion.isComplete,
    missingBillingDates: billingCompletion.missingDates,
    request: request ?? null,
  });
}

export async function submitSalesBookingRequest(req: AuthRequest, res: Response): Promise<void> {
  try {
    const workspaceId = String(req.params.workspaceId);
    const userId = String(req.user!._id);
    const { salesApproach, commonObjection, otherObjection } = req.body;
    const approach = typeof salesApproach === "string" ? salesApproach : "";
    const objection = typeof commonObjection === "string" ? commonObjection : "";
    const other = typeof otherObjection === "string" ? otherObjection : "";

    const billingCompletion = await billingService.getCurrentMonthCompletion(userId, workspaceId);
    if (!billingCompletion.isComplete) {
      res.status(403).json({ message: "Completa la facturación pendiente antes de solicitar una asesoría de ventas.", missingBillingDates: billingCompletion.missingDates });
      return;
    }

    if (!approaches.includes(approach) || !objections.includes(objection) || (objection === "other" && !other.trim())) {
      res.status(400).json({ message: "Completa la información comercial con valores válidos." });
      return;
    }

    const files = req.files as Express.Multer.File[] | undefined;
    if (!files?.length) {
      res.status(400).json({ message: "Sube al menos una evidencia de una venta perdida." });
      return;
    }

    const evidence = await Promise.all(files.map(async (file) => {
      const result = await new Promise<{ url: string; publicId: string }>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: `sales-booking/${workspaceId}/${userId}`, resource_type: file.mimetype === "application/pdf" ? "raw" : "image" },
          (error, upload) => error || !upload ? reject(error) : resolve({ url: upload.secure_url, publicId: upload.public_id })
        );
        stream.end(file.buffer);
      });
      return { name: file.originalname, url: result.url, publicId: result.publicId, mimeType: file.mimetype };
    }));

    const request = await SalesBookingRequestModel.findOneAndUpdate(
      { workspaceId, userId },
      { salesApproach: approach, commonObjection: objection, otherObjection: objection === "other" ? other.trim() : undefined, lostSaleEvidence: evidence },
      { new: true, upsert: true, runValidators: true }
    );
    res.status(201).json({ eligible: true, hasSalesInformation: true, isBillingUpToDate: true, missingBillingDates: [], request });
  } catch (error) {
    console.error("[BookingController] submit sales request error:", error);
    res.status(500).json({ message: "No se pudo guardar la información comercial." });
  }
}
