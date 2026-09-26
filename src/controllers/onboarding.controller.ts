import { Request, Response, NextFunction } from "express";
import { WorkspaceModel } from "../models/workspace.model";
import { onboardingService } from "../services/onboarding.service";
import { resendService } from "../services/resend.service";
import cloudinary from "../config/cloudinary";
import { BAKANO_LEGAL, CONTRATO_VERSION_ACTUAL, PAUTA_MINIMA, TITULO_CONTRATO, clausulasContrato } from "../services/contratoTexto";

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
        resourcesCompleted: false,
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
    const workspace = await WorkspaceModel.findById(workspaceId);
    if (!workspace) {
      return res.status(404).send({ error: "Workspace not found" });
    }

    // Lo que el cliente dio por Telegram manda sobre lo que llega del
    // navegador; la razon social de Bakano y la version las pone el servidor.
    const guardado = (workspace.contractData || {}) as Record<string, any>;
    const datos = {
      ...req.body,
      ...guardado,
      clientSignatureBase64: req.body.clientSignatureBase64,
      rucBakano: BAKANO_LEGAL.ruc,
      version: CONTRATO_VERSION_ACTUAL,
    };
    const { email, representanteCliente } = datos;

    if (!(Number(datos.presupuestoPauta) >= PAUTA_MINIMA)) {
      return res.status(400).send({ error: `Falta la inversión mensual en pauta (mínimo $${PAUTA_MINIMA}).` });
    }

    const pdfBuffer = await onboardingService.generateContractPDF(datos);

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
        resourcesCompleted: false,
        meetingScheduled: false,
      };
    }
    workspace.onboardingStatus.contractSubmitted = true;
    workspace.contractData = { ...datos, pdfUrl, firmadoEn: new Date() };
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
        resourcesCompleted: false,
        meetingScheduled: false,
      },
      preNegotiatedContract: workspace.preNegotiatedContract || null,
      // Los datos del contrato los llena el cliente por Telegram: la pantalla
      // web solo lee, muestra y recibe la firma.
      contractData: workspace.contractData || null,
      // El texto que se firma lo arma el servidor: asi la vista previa y el
      // PDF no pueden decir cosas distintas.
      contrato: {
        titulo: TITULO_CONTRATO,
        clausulas: clausulasContrato({ ...(workspace.preNegotiatedContract || {}), ...(workspace.contractData || {}) }),
        bakano: BAKANO_LEGAL,
      },
      workspaceName: workspace.name,
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
        resourcesCompleted: false,
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

export const markResourcesCompleted = async (req: Request, res: Response, next: NextFunction) => {
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
        resourcesCompleted: false,
        meetingScheduled: false,
      };
    }
    workspace.onboardingStatus.resourcesCompleted = true;
    await workspace.save();

    res.status(200).send({ message: "Resources step completed." });
  } catch (error) {
    console.error("Error in markResourcesCompleted:", error);
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

    const pdfBuffer = await onboardingService.generateContractPDF(workspace.contractData, {
      firmado: Boolean(workspace.onboardingStatus?.contractSubmitted),
      borrador: !workspace.onboardingStatus?.contractSubmitted,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="contrato_${workspaceId}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error("Error in downloadContract:", error);
    res.status(500).send({ error: "Internal server error" });
  }
};
