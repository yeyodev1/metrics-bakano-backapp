import type { Request, Response, NextFunction } from "express";
import { metaService } from "../services/meta.service";
import { HttpStatusCode } from "axios";
import models from "../models";
import { AuthRequest } from "../types/AuthRequest";

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
    const { workspaceId, pageId, pageName, accessToken, pageAccessToken, adAccountId, adAccountName } = req.body;

    if (!workspaceId || !pageId || !accessToken) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid integration data provided." });
      return;
    }

    const workspace = await metaService.saveIntegration(workspaceId, {
      accessToken,
      pageAccessToken,
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

    // Prefer the centrally-managed global token (workspace-level tokens are often expired).
    const globalToken = await metaService.getGlobalAccessToken().catch(() => null);
    const token = globalToken || workspace?.metaAds?.accessToken;

    if (!workspace || !token || !adAccountId) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Meta integration or Ad account missing." });
      return;
    }

    // Date range: prefer explicit since/until, fallback to datePreset
    const since = req.query.since as string | undefined;
    const until = req.query.until as string | undefined;
    const datePreset = (req.query.datePreset as string) || "this_month";
    const timeRange = since && until ? { since, until } : undefined;

    const [insightsRes, spendByPlatform, adsSpendByPlatform] = await Promise.all([
      metaService.getAdInsights(adAccountId, token, datePreset, timeRange),
      metaService.getSpendByPlatform(adAccountId, token, datePreset, timeRange).catch(() => []),
      metaService.getAdsSpendByPlatform(adAccountId, token, datePreset, timeRange).catch(() => []),
    ]);

    res.status(HttpStatusCode.Ok).send({
      message: "Ads insights retrieved successfully.",
      insights: insightsRes.insights,
      dailySpend: insightsRes.dailySpend,
      spendByPlatform,
      adsSpendByPlatform,
    });
  } catch (error) {
    next(error);
  }
}

export async function getOrganicInsights(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { workspaceId } = req.params;
    const workspace = await models.workspaces.findById(workspaceId);

    const userAccessToken = workspace?.metaAds?.accessToken;
    const pageAccessToken = workspace?.metaAds?.pageAccessToken;

    if (!workspace || !userAccessToken || !workspace.metaAds?.pageId) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Meta integration missing or no Page connected." });
      return;
    }

    const { pageInfo, igInfo, recentPosts, recentPostsIg } = await metaService.getOrganicInsights(
      workspace.metaAds.pageId,
      userAccessToken,
      pageAccessToken
    );

    res.status(HttpStatusCode.Ok).send({
      message: "Organic insights retrieved successfully.",
      pageInfo,
      igInfo,
      recentPosts,
      recentPostsIg,
    });
  } catch (error) {
    next(error);
  }
}

export async function autoMatchGlobalAccounts(_req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await metaService.autoMatchGlobalAccounts();
    res.status(HttpStatusCode.Ok).send({ message: "Mapeo automático completado.", ...result });
  } catch (error) {
    next(error);
  }
}

export async function getGlobalOAuthUrl(_req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(HttpStatusCode.Ok).send({ authUrl: await metaService.getOAuthUrl() });
  } catch (error) {
    next(error);
  }
}

export async function completeGlobalOAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    if (!code || !state) throw new Error("Facebook no devolvió los datos de autorización requeridos.");
    await metaService.completeOAuth(code, state);
    const appUrl = process.env.APP_URL || "https://testing-storybrand-frontend.bakano.ec";
    res.redirect(`${appUrl}/app/superadmin/meta-integrations?meta=connected`);
  } catch (error) {
    next(error);
  }
}

export async function getGlobalConnectionStatus(_req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(HttpStatusCode.Ok).send(await metaService.getGlobalConnectionStatus());
  } catch (error) {
    next(error);
  }
}

export async function getPendingGlobalAccounts(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.max(Number(req.query.limit) || 10, 1);
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const result = await metaService.getPendingGlobalAccounts(page, limit, search);
    res.status(HttpStatusCode.Ok).send(result);
  } catch (error) {
    next(error);
  }
}

export async function getLinkedGlobalAccounts(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.max(Number(req.query.limit) || 10, 1);
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const result = await metaService.getLinkedGlobalAccounts(page, limit, search);
    res.status(HttpStatusCode.Ok).send(result);
  } catch (error) {
    next(error);
  }
}

export async function getAllGlobalAccounts(_req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await metaService.getAllGlobalAccounts();
    res.status(HttpStatusCode.Ok).send(result);
  } catch (error) {
    next(error);
  }
}

export async function manuallyLinkGlobalAccount(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { workspaceId, adAccountId, instagramAccountId } = req.body;
    if (!workspaceId || typeof workspaceId !== "string") {
      res.status(HttpStatusCode.BadRequest).send({ message: "workspaceId es requerido." });
      return;
    }
    const workspace = await metaService.manuallyLinkGlobalAccount(workspaceId, { adAccountId, instagramAccountId });
    res.status(HttpStatusCode.Ok).send({ message: "Cuenta Meta vinculada correctamente.", workspace });
  } catch (error) {
    next(error);
  }
}

export async function refreshGlobalTokens(_req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const refreshedWorkspaces = await metaService.refreshLinkedWorkspaceTokens();
    res.status(HttpStatusCode.Ok).send({
      message: `Tokens actualizados en ${refreshedWorkspaces} workspace(s) vinculado(s).`,
      refreshedWorkspaces,
    });
  } catch (error) {
    next(error);
  }
}

export async function unlinkGlobalAccount(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { workspaceId, type } = req.body;
    if (!workspaceId || typeof workspaceId !== "string") {
      res.status(HttpStatusCode.BadRequest).send({ message: "workspaceId es requerido." });
      return;
    }
    if (type !== "ad_account" && type !== "instagram") {
      res.status(HttpStatusCode.BadRequest).send({ message: "Tipo inválido." });
      return;
    }
    const workspace = await metaService.unlinkGlobalAccount(workspaceId, type);
    res.status(HttpStatusCode.Ok).send({ message: "Cuenta desvinculada correctamente.", workspace });
  } catch (error) {
    next(error);
  }
}

export async function getUnifiedDashboard(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const since = req.query.since as string | undefined;
    const until = req.query.until as string | undefined;
    const dashboard = await metaService.getUnifiedDashboard(
      req.params.workspaceId as string,
      (req.query.datePreset as string) || "this_month",
      since && until ? { since, until } : undefined
    );
    res.status(HttpStatusCode.Ok).send(dashboard);
  } catch (error) {
    next(error);
  }
}
