import { Request, Response, NextFunction } from "express";
import { WorkspaceModel } from "../models/workspace.model";
import { onboardingService } from "../services/onboarding.service";
import { resendService } from "../services/resend.service";
import cloudinary from "../config/cloudinary";

export const acceptVideoResponsibilities = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { workspaceId } = req.params;

    const workspace = await WorkspaceModel.findById(workspaceId);
    if (!workspace) {
      return res.status(404).send({ error: "Workspace not found" });
    }

    if (!workspace.onboardingStatus) {
      workspace.onboardingStatus = {
        videoGenesisAccepted: false,
        contractSubmitted: false,
        meetingScheduled: false,
      };
    }

    workspace.onboardingStatus.videoGenesisAccepted = true;
    await workspace.save();

    res.status(200).send({ message: "Video responsibilities accepted successfully." });
  } catch (error) {
    console.error("Error in acceptVideoResponsibilities:", error);
    res.status(500).send({ error: "Internal server error" });
  }
};

export const submitContract = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { workspaceId } = req.params;
    const {
      rucBakano,
      nombreCliente,
      rucCliente,
      representanteCliente,
      cantidadGuiones,
      videosEntretenimiento,
      videosVenta,
      numeroFunnels,
      frecuenciaSesiones,
      valorMensual,
      diasPago,
      plazoMeses,
      mesesPermanencia,
      mensualidadesPenalidad,
      email, // To send the contract to
      clientSignatureBase64
    } = req.body;

    const workspace = await WorkspaceModel.findById(workspaceId);
    if (!workspace) {
      return res.status(404).send({ error: "Workspace not found" });
    }

    // Generate PDF
    const pdfBuffer = await onboardingService.generateContractPDF({
      rucBakano,
      nombreCliente,
      rucCliente,
      representanteCliente,
      cantidadGuiones,
      videosEntretenimiento,
      videosVenta,
      numeroFunnels,
      frecuenciaSesiones,
      valorMensual,
      diasPago,
      plazoMeses,
      mesesPermanencia,
      mensualidadesPenalidad,
      clientSignatureBase64
    });

    // Send email
    await resendService.sendContractEmail({
      to: email,
      recipientName: representanteCliente,
      pdfBuffer
    });

    // Upload to Cloudinary
    let pdfUrl = null;
    try {
      const cloudinaryResult = await new Promise<{ url: string; public_id: string }>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: "contracts", resource_type: "image", format: "pdf" },
          (error, result) => {
            if (error || !result) return reject(error);
            resolve({ url: result.url, public_id: result.public_id });
          }
        );
        stream.end(pdfBuffer);
      });
      pdfUrl = cloudinaryResult.url;
    } catch (uploadError) {
      console.error("Failed to upload contract to Cloudinary:", uploadError);
    }

    // Update status
    if (!workspace.onboardingStatus) {
      workspace.onboardingStatus = {
        videoGenesisAccepted: true,
        contractSubmitted: false,
        meetingScheduled: false,
      };
    }
    workspace.onboardingStatus.contractSubmitted = true;
    workspace.contractData = { ...req.body, pdfUrl };
    await workspace.save();

    res.status(200).send({ message: "Contract submitted and email sent successfully." });
  } catch (error) {
    console.error("Error in submitContract:", error);
    res.status(500).send({ error: "Internal server error" });
  }
};

export const checkOnboardingStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { workspaceId } = req.params;

    const workspace = await WorkspaceModel.findById(workspaceId);
    if (!workspace) {
      return res.status(404).send({ error: "Workspace not found" });
    }

    res.status(200).send({
      onboardingStatus: workspace.onboardingStatus || {
        videoGenesisAccepted: false,
        contractSubmitted: false,
        meetingScheduled: false,
      },
      preNegotiatedContract: workspace.preNegotiatedContract || null
    });
  } catch (error) {
    console.error("Error in checkOnboardingStatus:", error);
    res.status(500).send({ error: "Internal server error" });
  }
};

export const markMeetingScheduled = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { workspaceId } = req.params;

    const workspace = await WorkspaceModel.findById(workspaceId);
    if (!workspace) {
      res.status(404).send({ error: "Workspace not found" });
      return;
    }

    if (!workspace.onboardingStatus) {
      workspace.onboardingStatus = {
        videoGenesisAccepted: true,
        contractSubmitted: true,
        meetingScheduled: false,
      };
    }
    workspace.onboardingStatus.meetingScheduled = true;
    await workspace.save();

    res.status(200).send({ message: "Meeting marked as scheduled." });
  } catch (error) {
    console.error("Error in markMeetingScheduled:", error);
    res.status(500).send({ error: "Internal server error" });
  }
};

export const downloadContract = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { workspaceId } = req.params;

    const workspace = await WorkspaceModel.findById(workspaceId);
    if (!workspace || !workspace.contractData) {
      res.status(404).send({ error: "Contract not found" });
      return;
    }

    const pdfBuffer = await onboardingService.generateContractPDF(workspace.contractData);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="contrato_${workspaceId}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error("Error in downloadContract:", error);
    res.status(500).send({ error: "Internal server error" });
  }
};
