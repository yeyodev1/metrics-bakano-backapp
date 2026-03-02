import type { Request, Response, NextFunction } from "express";
import { metaService } from "../services/meta.service";
import { HttpStatusCode } from "axios";

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
