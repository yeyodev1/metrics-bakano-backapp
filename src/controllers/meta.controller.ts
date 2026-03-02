import type { Request, Response, NextFunction } from "express";
import { metaService } from "../services/meta.service";
import { HttpStatusCode } from "axios";
import models from "../models";

/**
 * Controller to handle Meta integration requests
 */
export async function authenticateMeta(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { shortToken, workspaceId } = req.body;

    if (!shortToken) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Meta short token is required." });
      return;
    }

    // Exchange for long-lived token
    const longToken = await metaService.exchangeToken(shortToken);

    // List available pages for user to select
    const pages = await metaService.listUserPages(longToken);

    res.status(HttpStatusCode.Ok).send({
      message: "Meta authenticated successfully. Please choose a page.",
      longToken,
      pages,
    });
    return;
  } catch (error) {
    next(error);
  }
}

export async function saveMetaIntegration(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { workspaceId, pageId, pageName, accessToken, adAccountId, adAccountName } = req.body;

    if (!workspaceId || !pageId || !accessToken) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid integration data provided." });
      return;
    }

    const workspace = await metaService.saveIntegration(workspaceId, {
      accessToken,
      pageId,
      pageName,
      adAccountId,
      adAccountName,
    });

    res.status(HttpStatusCode.Ok).send({
      message: "Meta integration saved successfully.",
      workspace,
    });
    return;
  } catch (error) {
    next(error);
  }
}

export async function getAdAccounts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { workspaceId } = req.params;
    const workspace = await models.workspaces.findById(workspaceId);

    if (!workspace || !workspace.metaAds?.accessToken) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Workspace not integrated with Meta Ads." });
      return;
    }

    const accounts = await metaService.listAdAccounts(workspace.metaAds.accessToken);
    res.status(HttpStatusCode.Ok).send({
      message: "Ad accounts retrieved successfully.",
      accounts,
    });
  } catch (error) {
    next(error);
  }
}

export async function getAdsInsights(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { workspaceId } = req.params;
    const workspace = await models.workspaces.findById(workspaceId);

    // Prefer passed explicitly from query or fallback to workspace saved one
    const adAccountId = (req.query.adAccountId as string) || workspace?.metaAds?.adAccountId;

    if (!workspace || !workspace.metaAds?.accessToken || !adAccountId) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Meta integration or Ad account missing." });
      return;
    }

    const insights = await metaService.getAdInsights(adAccountId, workspace.metaAds.accessToken);
    res.status(HttpStatusCode.Ok).send({
      message: "Ads insights retrieved successfully.",
      insights,
    });
  } catch (error) {
    next(error);
  }
}
