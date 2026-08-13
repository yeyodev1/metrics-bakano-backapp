import axios from "axios";
import crypto from "crypto";
import models from "../models";
import { CustomError } from "../errors/customError.error";
import { extractLeadActions } from "../utils/metaActions";

type MetaAccount = {
  id: string;
  name: string;
  accountId?: string;
  username?: string;
  currency?: string;
  profilePictureUrl?: string;
  businessName?: string;
  pageId?: string;
  pageName?: string;
};

type PendingMetaAccount = MetaAccount & { type: "ad_account" | "instagram" };

/**
 * Service to handle Meta (Facebook/Instagram) Ads API interactions
 */
export class MetaService {
  private get appId() {
    const envId = process.env.META_APP_ID;
    if (envId && envId !== "1331158525733899") return envId;
    return "1465122391696717";
  }
  private get appSecret() {
    const envId = process.env.META_APP_ID;
    if (envId && envId !== "1331158525733899" && process.env.META_APP_SECRET) return process.env.META_APP_SECRET;
    return "fff549713dadc13ff813bca9f549db55";
  }
  private get oauthRedirectUri() {
    return process.env.META_OAUTH_REDIRECT_URI || "https://testing-storybrand-backapp.bakano.ec/api/meta/global/oauth/callback";
  }
  private readonly graphUrl = "https://graph.facebook.com/v22.0";

  /**
   * Resumen compacto de la actividad publicitaria de un entorno.
   *
   * El panel de trafficker mostraba solo gasto y facturacion: un cliente con
   * campanas corriendo se veia igual que uno parado, porque el gasto del mes
   * puede ser cero por muchas razones. Esto responde la pregunta real: quien
   * tiene anuncios ACTIVOS ahora mismo y como van.
   */
  async getAdsActivity(
    workspaceId: string,
    year: number,
    month: number
  ): Promise<{
    conectado: boolean;
    activos: number;
    pausados: number;
    impresiones: number;
    clics: number;
    gasto: number;
    ctr: number | null;
    cpc: number | null;
    error?: string;
  }> {
    const vacio = {
      conectado: false,
      activos: 0,
      pausados: 0,
      impresiones: 0,
      clics: 0,
      gasto: 0,
      ctr: null,
      cpc: null,
    };

    const workspace: any = await models.workspaces.findById(workspaceId).lean();
    const adAccountId = workspace?.metaAds?.adAccountId;
    const token = workspace?.metaAds?.accessToken;
    if (!adAccountId || !token) return vacio;

    const desde = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
    const hasta = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);

    try {
      const [estados, metricas] = await Promise.all([
        axios.get(`${this.graphUrl}/act_${adAccountId}/ads`, {
          params: { access_token: token, fields: "effective_status", limit: 500 },
        }),
        axios.get(`${this.graphUrl}/act_${adAccountId}/insights`, {
          params: {
            access_token: token,
            time_range: JSON.stringify({ since: desde, until: hasta }),
            fields: "spend,impressions,clicks",
          },
        }),
      ]);

      const filas = estados.data?.data ?? [];
      const activos = filas.filter((a: any) => a.effective_status === "ACTIVE").length;

      const m = metricas.data?.data?.[0] ?? {};
      const impresiones = Number(m.impressions || 0);
      const clics = Number(m.clicks || 0);
      const gasto = Number(m.spend || 0);

      return {
        conectado: true,
        activos,
        pausados: filas.length - activos,
        impresiones,
        clics,
        gasto,
        ctr: impresiones > 0 ? (clics / impresiones) * 100 : null,
        cpc: clics > 0 ? gasto / clics : null,
      };
    } catch (error: any) {
      // Un entorno sin permisos no puede tumbar la lista entera: se devuelve el
      // motivo y la fila lo muestra en vez de quedarse en blanco.
      return { ...vacio, conectado: true, error: this.explicarErrorMeta(error.response?.data) };
    }
  }


  /**
   * Permisos que el token tiene concedidos de verdad.
   *
   * Pedir un scope en el login no garantiza tenerlo: el usuario puede
   * desmarcarlo, y ads_read sobre cuentas de terceros exige Acceso Avanzado
   * aprobado en la revision de la app. Sin esto, la unica pista era un error
   * 500 con el JSON crudo de Meta.
   */
  async getGrantedPermissions(accessToken: string): Promise<{
    concedidos: string[];
    rechazados: string[];
  }> {
    try {
      const { data } = await axios.get(`${this.graphUrl}/me/permissions`, {
        params: { access_token: accessToken },
      });
      const filas: Array<{ permission: string; status: string }> = data?.data ?? [];
      return {
        concedidos: filas.filter((f) => f.status === "granted").map((f) => f.permission),
        rechazados: filas.filter((f) => f.status !== "granted").map((f) => f.permission),
      };
    } catch {
      return { concedidos: [], rechazados: [] };
    }
  }

  /**
   * Traduce el error de Meta a algo accionable.
   *
   * El codigo 200 con "has NOT grant ads_management or ads_read" NO se arregla
   * tocando los scopes del codigo: ads_read ya se pide. Significa una de tres
   * cosas, y ninguna se resuelve desde aqui.
   */
  explicarErrorMeta(metaError: any): string {
    const codigo = metaError?.error?.code;
    const mensaje: string = metaError?.error?.message ?? "";

    if (codigo === 200 && /ads_management|ads_read/.test(mensaje)) {
      return [
        "Meta no autoriza leer esta cuenta publicitaria.",
        "Revisa, en este orden:",
        "1) que quien conecto tenga un rol asignado sobre esa cuenta en el Business Manager;",
        "2) que la app tenga Acceso Avanzado a ads_read aprobado (con Acceso Estandar solo funcionan las cuentas propias);",
        "3) que la conexion se haya hecho DESPUES de agregar ads_read: un token viejo no gana permisos solo, hay que volver a conectar.",
      ].join(" ");
    }

    if (codigo === 190) {
      return "La conexion con Meta caduco o fue revocada. Hay que volver a conectar la cuenta.";
    }

    return mensaje || "Error desconocido de Meta.";
  }


  private get encryptionKey() {
    const secret = process.env.META_TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET;
    if (!secret) {
      throw new CustomError("Falta META_TOKEN_ENCRYPTION_KEY o JWT_SECRET para proteger la conexión de Meta.", 503);
    }
    return crypto.createHash("sha256").update(secret).digest();
  }

  private requireOAuthConfig() {
    const missing: string[] = [];
    if (!this.appId) missing.push("META_APP_ID");
    if (!this.appSecret) missing.push("META_APP_SECRET");
    if (!this.oauthRedirectUri) missing.push("META_OAUTH_REDIRECT_URI");

    if (missing.length > 0) {
      throw new CustomError(`La conexión con Facebook requiere configurar: ${missing.join(", ")}.`, 503);
    }
    return { appId: this.appId!, appSecret: this.appSecret!, redirectUri: this.oauthRedirectUri! };
  }

  private encrypt(value: string) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
  }

  private decrypt(value: string) {
    const [ivValue, tagValue, encryptedValue] = value.split(".");
    if (!ivValue || !tagValue || !encryptedValue) throw new CustomError("La conexión almacenada de Meta no es válida.", 500);
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]).toString("utf8");
  }

  async getOAuthUrl() {
    const { appId, redirectUri } = this.requireOAuthConfig();
    const payload = Buffer.from(JSON.stringify({ issuedAt: Date.now(), nonce: crypto.randomBytes(16).toString("hex") })).toString("base64url");
    const signature = crypto.createHmac("sha256", this.encryptionKey).update(payload).digest("base64url");
    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      state: `${payload}.${signature}`,
      response_type: "code",
      scope: "public_profile,business_management,ads_read,pages_show_list,pages_read_engagement,instagram_basic",
    });
    return `https://www.facebook.com/v22.0/dialog/oauth?${params}`;
  }

  async completeOAuth(code: string, state: string) {
    const [payload, signature] = state.split(".");
    const expectedSignature = crypto.createHmac("sha256", this.encryptionKey).update(payload || "").digest("base64url");
    if (!payload || !signature || signature.length !== expectedSignature.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      throw new CustomError("La validación de la conexión con Facebook expiró o no es válida.", 400);
    }
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { issuedAt: number };
    if (Date.now() - decoded.issuedAt > 10 * 60 * 1000) {
      throw new CustomError("La validación de la conexión con Facebook expiró. Intenta conectarte nuevamente.", 400);
    }
    const { appId, appSecret, redirectUri } = this.requireOAuthConfig();
    try {
      const shortTokenResponse = await axios.get(`${this.graphUrl}/oauth/access_token`, { params: { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code } });
      const longTokenResponse = await axios.get(`${this.graphUrl}/oauth/access_token`, { params: { grant_type: "fb_exchange_token", client_id: appId, client_secret: appSecret, fb_exchange_token: shortTokenResponse.data.access_token } });
      const token = longTokenResponse.data.access_token;
      const profileResponse = await axios.get(`${this.graphUrl}/me`, { params: { access_token: token, fields: "id,name" } });
      const expiresAt = longTokenResponse.data.expires_in ? new Date(Date.now() + Number(longTokenResponse.data.expires_in) * 1000) : undefined;
      await models.metaGlobalIntegration.findOneAndUpdate(
        { key: "facebook-profile" },
        { $set: { encryptedAccessToken: this.encrypt(token), facebookUserId: profileResponse.data.id, facebookUserName: profileResponse.data.name, expiresAt } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      // Refresh all linked workspaces with fresh tokens derived from the new global connection.
      const refreshed = await this.refreshLinkedWorkspaceTokens(token).catch((err) => {
        console.error("[MetaService] refreshLinkedWorkspaceTokens failed:", err?.message || err);
        return 0;
      });

      return { name: profileResponse.data.name, expiresAt, refreshedWorkspaces: refreshed };
    } catch (error: any) {
      throw this.metaError(error, "No fue posible conectar el perfil de Facebook.");
    }
  }

  /**
   * Refreshes every linked workspace with fresh tokens derived from the freshly
   * reconnected global admin profile. Updates the user access token, a fresh page
   * access token (when a pageId is present), and the profile picture.
   * Returns the number of workspaces refreshed.
   */
  async refreshLinkedWorkspaceTokens(freshGlobalToken?: string): Promise<number> {
    const token = freshGlobalToken || (await this.getGlobalAccessToken());

    // Build a map of pageId -> fresh page access token from the admin's pages.
    const pageTokenMap = new Map<string, { accessToken: string; name?: string; pictureUrl?: string; igId?: string; igUsername?: string; igName?: string; igPicture?: string }>();
    try {
      const pages = await this.fetchAllPaginated<any>(`${this.graphUrl}/me/accounts`, {
        access_token: token,
        fields: "id,name,access_token,picture{url},instagram_business_account{id,username,profile_picture_url,name}",
        limit: 100,
      });
      for (const page of pages) {
        if (page.id) {
          const ig = page.instagram_business_account;
          pageTokenMap.set(page.id, {
            accessToken: page.access_token,
            name: page.name,
            pictureUrl: page.picture?.data?.url,
            igId: ig?.id,
            igUsername: ig?.username,
            igName: ig?.name,
            igPicture: ig?.profile_picture_url,
          });
        }
      }
    } catch (err: any) {
      console.error("[MetaService] Could not fetch admin pages for token refresh:", err?.response?.data || err?.message);
    }

    // Also build a map keyed by IG id (via managed pages) so we can resolve most
    // Instagram pictures WITHOUT a per-workspace API call.
    const igByIdFromPages = new Map<string, { pictureUrl?: string; username?: string; name?: string; pageId: string }>();
    for (const [pageId, data] of pageTokenMap.entries()) {
      if (data.igId) {
        igByIdFromPages.set(data.igId, { pictureUrl: data.igPicture, username: data.igUsername, name: data.igName, pageId });
      }
    }

    // Any workspace with any Meta linkage should be refreshed.
    const workspaces = await models.workspaces.find({
      $or: [
        { "metaAds.adAccountId": { $exists: true, $ne: null } },
        { "metaAds.instagramAccountId": { $exists: true, $ne: null } },
        { "metaAds.pageId": { $exists: true, $ne: null } },
        { "metaAds.accessToken": { $exists: true, $ne: null } },
      ],
    }).select("metaAds").lean();

    const now = new Date();

    // Build all updates. Only workspaces whose IG picture cannot be resolved from
    // managed pages need a live Graph call — those are done in parallel chunks.
    const bulkOps: any[] = [];
    const needsIgFetch: Array<{ id: any; igId: string; base: Record<string, unknown> }> = [];

    for (const ws of workspaces) {
      if (!ws.metaAds) continue;
      const update: Record<string, unknown> = {
        "metaAds.accessToken": token,
        "metaAds.lastSyncedAt": now,
      };

      // Refresh page access token + page picture if we manage this page.
      if (ws.metaAds.pageId && pageTokenMap.has(ws.metaAds.pageId)) {
        const pageData = pageTokenMap.get(ws.metaAds.pageId)!;
        if (pageData.accessToken) update["metaAds.pageAccessToken"] = pageData.accessToken;
        if (pageData.name) update["metaAds.pageName"] = pageData.name;
        if (pageData.pictureUrl) update["metaAds.pictureUrl"] = pageData.pictureUrl;
      }

      // Resolve IG picture/name from the managed pages map (no extra API call).
      if (ws.metaAds.instagramAccountId && igByIdFromPages.has(ws.metaAds.instagramAccountId)) {
        const ig = igByIdFromPages.get(ws.metaAds.instagramAccountId)!;
        if (ig.pictureUrl) update["metaAds.pictureUrl"] = ig.pictureUrl;
        if (ig.username || ig.name) {
          update["metaAds.instagramAccountName"] = ig.username ? `@${ig.username}` : (ig.name || ws.metaAds.instagramAccountId);
        }
      } else if (ws.metaAds.instagramAccountId) {
        // Not covered by a managed page — needs a live fetch (done in parallel below).
        needsIgFetch.push({ id: ws._id, igId: ws.metaAds.instagramAccountId, base: update });
      }

      // Fallback picture from Facebook Page graph avatar.
      if (!update["metaAds.pictureUrl"] && !ws.metaAds.pictureUrl && ws.metaAds.pageId) {
        update["metaAds.pictureUrl"] = `https://graph.facebook.com/${ws.metaAds.pageId}/picture?type=normal`;
      }

      bulkOps.push({ updateOne: { filter: { _id: ws._id }, update: { $set: update } } });
    }

    // Resolve remaining IG pictures in parallel (chunked) to stay within serverless limits.
    const CHUNK = 12;
    for (let i = 0; i < needsIgFetch.length; i += CHUNK) {
      const slice = needsIgFetch.slice(i, i + CHUNK);
      await Promise.allSettled(
        slice.map(async (item) => {
          try {
            const igRes = await axios.get(`${this.graphUrl}/${item.igId}`, {
              params: { access_token: token, fields: "id,name,username,profile_picture_url" },
              timeout: 8000,
            });
            if (igRes.data?.profile_picture_url) item.base["metaAds.pictureUrl"] = igRes.data.profile_picture_url;
            if (igRes.data?.username || igRes.data?.name) {
              item.base["metaAds.instagramAccountName"] = igRes.data.username ? `@${igRes.data.username}` : (igRes.data.name || item.igId);
            }
          } catch {
            // Non-blocking; keep prior picture/name.
          }
        })
      );
    }

    if (bulkOps.length > 0) {
      await models.workspaces.bulkWrite(bulkOps, { ordered: false });
    }

    return bulkOps.length;
  }

  async getGlobalConnectionStatus() {
    const integration = await models.metaGlobalIntegration.findOne({ key: "facebook-profile" }).lean();
    if (!integration) return { connected: false };
    return { connected: true, name: integration.facebookUserName, expiresAt: integration.expiresAt, expired: !!integration.expiresAt && integration.expiresAt <= new Date() };
  }

  async getGlobalAccessToken() {
    const integration = await models.metaGlobalIntegration.findOne({ key: "facebook-profile" }).lean();
    if (!integration) throw new CustomError("Conecta primero el perfil de Facebook que administra los portafolios de clientes.", 503);
    if (integration.expiresAt && integration.expiresAt <= new Date()) throw new CustomError("La conexión de Facebook expiró. Reconecta el perfil administrador.", 401);
    return this.decrypt(integration.encryptedAccessToken);
  }

  private metaError(error: any, fallback: string): CustomError {
    if (error instanceof CustomError) return error;
    const meta = error.response?.data?.error;
    const status = error.response?.status;
    console.error("Meta Graph API error:", meta || error.message);

    if (status === 401 || status === 403 || meta?.code === 190 || meta?.code === 10) {
      return new CustomError("Meta rechazó las credenciales o permisos de la integración global.", 502);
    }
    if (status === 429 || meta?.code === 4 || meta?.code === 17 || meta?.code === 32) {
      return new CustomError("Meta limitó temporalmente la consulta. Inténtalo nuevamente en unos minutos.", 429);
    }
    return new CustomError(meta?.message || error.message || fallback, 502);
  }

  private normalizeName(value: string) {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\b(official|oficial|ecuador|ec|ads|facebook|instagram|ig|grupo|corp|inc|llc|la|el|los|las|de|del|s|a)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private similarity(left: string, right: string) {
    const a = this.normalizeName(left);
    const b = this.normalizeName(right);
    if (!a || !b) return 0;

    const aNoSpace = a.replace(/\s+/g, "");
    const bNoSpace = b.replace(/\s+/g, "");

    // Exact or space-less match
    if (a === b || (aNoSpace.length >= 3 && aNoSpace === bNoSpace)) return 1.0;

    // Direct containment (ignoring spaces)
    if (aNoSpace.length >= 3 && bNoSpace.length >= 3 && (bNoSpace.includes(aNoSpace) || aNoSpace.includes(bNoSpace))) {
      return 0.95;
    }

    if (a.length >= 3 && b.length >= 3 && (b.includes(a) || a.includes(b))) {
      return 0.9;
    }

    const leftWords = new Set(a.split(" ").filter((w) => w.length > 1));
    const rightWords = new Set(b.split(" ").filter((w) => w.length > 1));
    if (leftWords.size === 0 || rightWords.size === 0) return 0;

    const intersection = [...leftWords].filter((word) => rightWords.has(word)).length;
    const minWords = Math.min(leftWords.size, rightWords.size);
    const overlapRatio = intersection / minWords;

    if (overlapRatio === 1) return 0.85;

    const union = new Set([...leftWords, ...rightWords]).size;
    const jaccard = intersection / union;

    return Math.max(jaccard, overlapRatio * 0.7);
  }

  private async getBusinessAccounts() {
    const accessToken = await this.getGlobalAccessToken();
    try {
      const [adAccounts, pages, businesses] = await Promise.all([
        this.fetchAllPaginated<any>(`${this.graphUrl}/me/adaccounts`, {
          access_token: accessToken,
          fields: "id,account_id,name,account_status,currency,business{id,name}",
          limit: 100,
        }).catch(() => []),
        this.fetchAllPaginated<any>(`${this.graphUrl}/me/accounts`, {
          access_token: accessToken,
          fields: "id,name,business{id,name},picture{url},instagram_business_account{id,username,profile_picture_url,name}",
          limit: 100,
        }).catch(() => []),
        this.fetchAllPaginated<any>(`${this.graphUrl}/me/businesses`, {
          access_token: accessToken,
          fields: "id,name,instagram_accounts{id,username,profile_picture_url,name},client_instagram_accounts{id,username,profile_picture_url,name},adaccounts{id,account_id,name,currency}",
          limit: 100,
        }).catch(() => []),
      ]);

      const seenInstagramIds = new Set<string>();
      const instagramAccounts: (MetaAccount & { searchTerms?: string })[] = [];

      for (const page of pages) {
        const instagram = page.instagram_business_account;
        if (instagram && instagram.id && !seenInstagramIds.has(instagram.id)) {
          seenInstagramIds.add(instagram.id);
          const displayName = instagram.username ? `@${instagram.username}` : (instagram.name || page.name || instagram.id);
          const businessName = page.business?.name || "";
          const pageName = page.name || "";
          const pageId = page.id || "";
          const profilePic = instagram.profile_picture_url || page.picture?.data?.url || (pageId ? `https://graph.facebook.com/${pageId}/picture?type=normal` : undefined);
          const searchTerms = [displayName, instagram.username, instagram.name, page.name, businessName].filter(Boolean).join(" ");
          instagramAccounts.push({
            id: instagram.id,
            name: displayName,
            username: instagram.username,
            profilePictureUrl: profilePic,
            pageId,
            pageName,
            businessName,
            searchTerms,
          });
        }
      }

      for (const business of businesses) {
        const bAccounts = [
          ...(business.instagram_accounts?.data || business.instagram_accounts || []),
          ...(business.client_instagram_accounts?.data || business.client_instagram_accounts || []),
        ];
        for (const instagram of bAccounts) {
          if (instagram && instagram.id && !seenInstagramIds.has(instagram.id)) {
            seenInstagramIds.add(instagram.id);
            const displayName = instagram.username ? `@${instagram.username}` : (instagram.name || business.name || instagram.id);
            const businessName = business.name || "";
            const searchTerms = [displayName, instagram.username, instagram.name, businessName].filter(Boolean).join(" ");
            instagramAccounts.push({
              id: instagram.id,
              name: displayName,
              username: instagram.username,
              profilePictureUrl: instagram.profile_picture_url,
              businessName,
              pageName: "",
              searchTerms,
            });
          }
        }
      }

      const seenAdAccountIds = new Set<string>(adAccounts.map((a: any) => a.account_id || a.id));
      const allAdAccounts = [...adAccounts];

      for (const business of businesses) {
        const bAds = business.adaccounts?.data || business.adaccounts || [];
        for (const account of bAds) {
          const accId = account.account_id || account.id?.replace(/^act_/, "");
          if (accId && !seenAdAccountIds.has(accId)) {
            seenAdAccountIds.add(accId);
            allAdAccounts.push({
              id: account.id || `act_${accId}`,
              account_id: accId,
              name: account.name || accId,
              currency: account.currency,
              business: { id: business.id, name: business.name },
            });
          }
        }
      }

      return {
        adAccounts: allAdAccounts.map((account) => {
          const businessName = account.business?.name || "";
          const displayName = account.name || account.account_id || account.id;
          const searchTerms = [displayName, businessName, account.account_id].filter(Boolean).join(" ");
          return {
            id: account.id,
            accountId: account.account_id || account.id.replace(/^act_/, ""),
            name: displayName,
            currency: account.currency,
            businessName,
            searchTerms,
          };
        }) as (MetaAccount & { searchTerms?: string })[],
        instagramAccounts,
      };
    } catch (error: any) {
      throw this.metaError(error, "No fue posible listar las cuentas disponibles para el perfil de Facebook conectado.");
    }
  }

  async getAllGlobalAccounts() {
    const [{ adAccounts, instagramAccounts }, linkedWorkspaces] = await Promise.all([
      this.getBusinessAccounts(),
      models.workspaces.find({}).select("name metaAds").lean(),
    ]);

    const adToWorkspaceMap = new Map<string, { id: string; name: string }>();
    const igToWorkspaceMap = new Map<string, { id: string; name: string }>();

    for (const ws of linkedWorkspaces) {
      if (ws.metaAds?.adAccountId) {
        adToWorkspaceMap.set(ws.metaAds.adAccountId, { id: ws._id.toString(), name: ws.name });
      }
      if (ws.metaAds?.instagramAccountId) {
        igToWorkspaceMap.set(ws.metaAds.instagramAccountId, { id: ws._id.toString(), name: ws.name });
      }
    }

    const allAdAccounts = adAccounts.map((account) => ({
      ...account,
      type: "ad_account" as const,
      linkedWorkspace: account.accountId ? adToWorkspaceMap.get(account.accountId) || null : null,
    }));

    const allInstagramAccounts = instagramAccounts.map((account) => ({
      ...account,
      type: "instagram" as const,
      linkedWorkspace: igToWorkspaceMap.get(account.id) || null,
    }));

    return {
      adAccounts: allAdAccounts,
      instagramAccounts: allInstagramAccounts,
    };
  }

  async autoMatchGlobalAccounts() {
    const [{ adAccounts, instagramAccounts }, workspaces] = await Promise.all([
      this.getBusinessAccounts(),
      models.workspaces.find({ isActive: true }).select("name metaAds").lean(),
    ]);

    const matches: Array<{ workspaceId: string; workspaceName: string; type: string; accountName: string; score: number }> = [];
    const matchedAdIds = new Set<string>();
    const matchedInstagramIds = new Set<string>();

    for (const workspace of workspaces) {
      const bestAd = adAccounts
        .filter((account) => !matchedAdIds.has(account.id))
        .map((account) => ({ account, score: this.similarity(workspace.name, account.searchTerms || account.name) }))
        .sort((a, b) => b.score - a.score)[0];
      const bestInstagram = instagramAccounts
        .filter((account) => !matchedInstagramIds.has(account.id))
        .map((account) => ({ account, score: this.similarity(workspace.name, account.searchTerms || `${account.name} ${account.username || ""}`) }))
        .sort((a, b) => b.score - a.score)[0];

      const update: Record<string, unknown> = { "metaAds.lastSyncedAt": new Date() };
      if (bestAd && bestAd.score >= 0.55 && !workspace.metaAds?.adAccountId) {
        update["metaAds.adAccountId"] = bestAd.account.accountId;
        update["metaAds.adAccountName"] = bestAd.account.name;
        matchedAdIds.add(bestAd.account.id);
        matches.push({ workspaceId: workspace._id.toString(), workspaceName: workspace.name, type: "ad_account", accountName: bestAd.account.name, score: bestAd.score });
      }
      if (bestInstagram && bestInstagram.score >= 0.55 && !workspace.metaAds?.instagramAccountId) {
        update["metaAds.instagramAccountId"] = bestInstagram.account.id;
        update["metaAds.instagramAccountName"] = bestInstagram.account.name;
        if (bestInstagram.account.profilePictureUrl) {
          update["metaAds.pictureUrl"] = bestInstagram.account.profilePictureUrl;
        }
        matchedInstagramIds.add(bestInstagram.account.id);
        matches.push({ workspaceId: workspace._id.toString(), workspaceName: workspace.name, type: "instagram", accountName: bestInstagram.account.name, score: bestInstagram.score });
      }
      if (Object.keys(update).length > 1) {
        await models.workspaces.findByIdAndUpdate(workspace._id, { $set: update });
      }
    }

    return { matches, ...(await this.getPendingGlobalAccounts(1, 10, undefined, { adAccounts, instagramAccounts })) };
  }

  async getPendingGlobalAccounts(page = 1, limit = 10, search?: string | any, knownAccounts?: Awaited<ReturnType<MetaService["getBusinessAccounts"]>>) {
    let searchStr: string | undefined = undefined;
    let accountsObj = knownAccounts;

    if (typeof search === "string") {
      searchStr = search;
    } else if (typeof search === "object" && search !== null && !knownAccounts) {
      accountsObj = search;
    }

    const { adAccounts, instagramAccounts } = accountsObj || await this.getBusinessAccounts();
    const linkedWorkspaces = await models.workspaces.find({}).select("metaAds.adAccountId metaAds.instagramAccountId").lean();
    const linkedAdAccounts = new Set(linkedWorkspaces.map((workspace) => workspace.metaAds?.adAccountId).filter(Boolean));
    const linkedInstagramAccounts = new Set(linkedWorkspaces.map((workspace) => workspace.metaAds?.instagramAccountId).filter(Boolean));
    let pending: PendingMetaAccount[] = [
      ...adAccounts.filter((account) => !linkedAdAccounts.has(account.accountId)).map((account) => ({ ...account, type: "ad_account" as const })),
      ...instagramAccounts.filter((account) => !linkedInstagramAccounts.has(account.id)).map((account) => ({ ...account, type: "instagram" as const })),
    ];

    if (typeof searchStr === "string" && searchStr.trim()) {
      const q = searchStr.toLowerCase().trim();
      pending = pending.filter(
        (acc) =>
          acc.name.toLowerCase().includes(q) ||
          (acc.username && acc.username.toLowerCase().includes(q)) ||
          (acc.pageName && acc.pageName.toLowerCase().includes(q)) ||
          (acc.businessName && acc.businessName.toLowerCase().includes(q)) ||
          (acc.accountId && acc.accountId.toLowerCase().includes(q))
      );
    }

    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const safePage = Math.max(page, 1);
    const start = (safePage - 1) * safeLimit;
    return {
      pending: pending.slice(start, start + safeLimit),
      pagination: { page: safePage, limit: safeLimit, total: pending.length, totalPages: Math.max(Math.ceil(pending.length / safeLimit), 1) },
    };
  }

  async getLinkedGlobalAccounts(page = 1, limit = 10, search?: string) {
    this.syncLinkedWorkspacePictures().catch(() => {});
    const [{ adAccounts, instagramAccounts }, linkedWorkspaces] = await Promise.all([
      this.getBusinessAccounts(),
      models.workspaces.find({}).select("name metaAds").lean(),
    ]);

    const adToWorkspaceMap = new Map<string, { id: string; name: string }>();
    const igToWorkspaceMap = new Map<string, { id: string; name: string }>();

    for (const ws of linkedWorkspaces) {
      if (ws.metaAds?.adAccountId) {
        adToWorkspaceMap.set(ws.metaAds.adAccountId, { id: ws._id.toString(), name: ws.name });
      }
      if (ws.metaAds?.instagramAccountId) {
        igToWorkspaceMap.set(ws.metaAds.instagramAccountId, { id: ws._id.toString(), name: ws.name });
      }
    }

    type LinkedMetaAccount = PendingMetaAccount & { workspaceId: string; workspaceName: string };
    let linked: LinkedMetaAccount[] = [];

    for (const account of adAccounts) {
      const ws = account.accountId ? adToWorkspaceMap.get(account.accountId) : undefined;
      if (ws) {
        linked.push({ ...account, type: "ad_account", workspaceId: ws.id, workspaceName: ws.name });
      }
    }

    for (const account of instagramAccounts) {
      const ws = igToWorkspaceMap.get(account.id);
      if (ws) {
        linked.push({ ...account, type: "instagram", workspaceId: ws.id, workspaceName: ws.name });
      }
    }

    const foundAdAccountIds = new Set(linked.filter((a) => a.type === "ad_account").map((a) => a.accountId));
    const foundIgAccountIds = new Set(linked.filter((a) => a.type === "instagram").map((a) => a.id));

    for (const ws of linkedWorkspaces) {
      if (ws.metaAds?.adAccountId && !foundAdAccountIds.has(ws.metaAds.adAccountId)) {
        linked.push({
          id: ws.metaAds.adAccountId,
          accountId: ws.metaAds.adAccountId,
          name: ws.metaAds.adAccountName || ws.metaAds.adAccountId,
          type: "ad_account",
          workspaceId: ws._id.toString(),
          workspaceName: ws.name,
        });
      }
      if (ws.metaAds?.instagramAccountId && !foundIgAccountIds.has(ws.metaAds.instagramAccountId)) {
        linked.push({
          id: ws.metaAds.instagramAccountId,
          name: ws.metaAds.instagramAccountName || ws.metaAds.instagramAccountId,
          type: "instagram",
          workspaceId: ws._id.toString(),
          workspaceName: ws.name,
        });
      }
    }

    if (typeof search === "string" && search.trim()) {
      const q = search.toLowerCase().trim();
      linked = linked.filter(
        (acc) =>
          acc.name.toLowerCase().includes(q) ||
          acc.workspaceName.toLowerCase().includes(q) ||
          (acc.username && acc.username.toLowerCase().includes(q)) ||
          (acc.pageName && acc.pageName.toLowerCase().includes(q)) ||
          (acc.businessName && acc.businessName.toLowerCase().includes(q)) ||
          (acc.accountId && acc.accountId.toLowerCase().includes(q))
      );
    }

    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const safePage = Math.max(page, 1);
    const start = (safePage - 1) * safeLimit;

    return {
      linked: linked.slice(start, start + safeLimit),
      pagination: { page: safePage, limit: safeLimit, total: linked.length, totalPages: Math.max(Math.ceil(linked.length / safeLimit), 1) },
    };
  }

  async manuallyLinkGlobalAccount(workspaceId: string, data: { adAccountId?: string; instagramAccountId?: string }) {
    if (!data.adAccountId && !data.instagramAccountId) {
      throw new CustomError("Selecciona al menos una cuenta de Meta para vincular.", 400);
    }
    const workspace = await models.workspaces.findById(workspaceId);
    if (!workspace) throw new CustomError("Workspace no encontrado.", 404);

    let token: string | null = null;
    try {
      token = await this.getGlobalAccessToken();
    } catch {
      // Non-blocking
    }

    const update: Record<string, unknown> = { "metaAds.lastSyncedAt": new Date() };

    if (data.adAccountId) {
      const cleanAdAccountId = data.adAccountId.replace(/^act_/, "");
      let adName = cleanAdAccountId;

      if (token) {
        try {
          const adRes = await axios.get(`${this.graphUrl}/act_${cleanAdAccountId}`, {
            params: { access_token: token, fields: "id,account_id,name,currency" },
          });
          if (adRes.data?.name) {
            adName = adRes.data.name;
          }
        } catch {
          // Fallback to clean ID
        }
      }

      await models.workspaces.updateMany(
        { _id: { $ne: workspaceId }, "metaAds.adAccountId": cleanAdAccountId },
        { $unset: { "metaAds.adAccountId": "", "metaAds.adAccountName": "" } }
      );

      update["metaAds.adAccountId"] = cleanAdAccountId;
      update["metaAds.adAccountName"] = adName;
    }

    if (data.instagramAccountId) {
      let igName = data.instagramAccountId;
      let pictureUrl: string | undefined = undefined;

      if (token) {
        try {
          const igRes = await axios.get(`${this.graphUrl}/${data.instagramAccountId}`, {
            params: { access_token: token, fields: "id,name,username,profile_picture_url" },
          });
          if (igRes.data) {
            if (igRes.data.profile_picture_url) pictureUrl = igRes.data.profile_picture_url;
            if (igRes.data.username || igRes.data.name) {
              igName = igRes.data.username ? `@${igRes.data.username}` : (igRes.data.name || data.instagramAccountId);
            }
          }
        } catch {
          // Fallback to ID
        }
      }

      await models.workspaces.updateMany(
        { _id: { $ne: workspaceId }, "metaAds.instagramAccountId": data.instagramAccountId },
        { $unset: { "metaAds.instagramAccountId": "", "metaAds.instagramAccountName": "" } }
      );

      update["metaAds.instagramAccountId"] = data.instagramAccountId;
      update["metaAds.instagramAccountName"] = igName;
      if (pictureUrl) {
        update["metaAds.pictureUrl"] = pictureUrl;
      }
    }

    if (workspace.metaAds?.pageId && !update["metaAds.pictureUrl"]) {
      update["metaAds.pictureUrl"] = `https://graph.facebook.com/${workspace.metaAds.pageId}/picture?type=normal`;
    }

    const updated = await models.workspaces.findByIdAndUpdate(workspaceId, { $set: update }, { new: true });
    this.syncLinkedWorkspacePictures().catch(() => {});
    return updated;
  }

  async syncLinkedWorkspacePictures() {
    try {
      const token = await this.getGlobalAccessToken();
      if (!token) return;

      const workspaces = await models.workspaces.find({ "metaAds": { $exists: true } });

      for (const ws of workspaces) {
        if (!ws.metaAds) continue;
        const update: Record<string, unknown> = {};

        if (ws.metaAds.instagramAccountId && !ws.metaAds.pictureUrl) {
          try {
            const igRes = await axios.get(`${this.graphUrl}/${ws.metaAds.instagramAccountId}`, {
              params: { access_token: token, fields: "id,name,username,profile_picture_url" },
            });
            if (igRes.data?.profile_picture_url) {
              update["metaAds.pictureUrl"] = igRes.data.profile_picture_url;
            }
            if (igRes.data?.username || igRes.data?.name) {
              update["metaAds.instagramAccountName"] = igRes.data.username ? `@${igRes.data.username}` : (igRes.data.name || ws.metaAds.instagramAccountId);
            }
          } catch {
            // Ignore individual IG fetch error
          }
        }

        if (!update["metaAds.pictureUrl"] && !ws.metaAds.pictureUrl && ws.metaAds.pageId) {
          update["metaAds.pictureUrl"] = `https://graph.facebook.com/${ws.metaAds.pageId}/picture?type=normal`;
        }

        if (Object.keys(update).length > 0) {
          await models.workspaces.findByIdAndUpdate(ws._id, { $set: update });
        }
      }
    } catch {
      // Non-blocking sync
    }
  }

  async unlinkGlobalAccount(workspaceId: string, type: "ad_account" | "instagram") {
    const workspace = await models.workspaces.findById(workspaceId);
    if (!workspace) throw new CustomError("Workspace no encontrado.", 404);

    const update: Record<string, unknown> = { "metaAds.lastSyncedAt": new Date() };
    if (type === "ad_account") {
      update["metaAds.adAccountId"] = null;
      update["metaAds.adAccountName"] = null;
    } else {
      update["metaAds.instagramAccountId"] = null;
      update["metaAds.instagramAccountName"] = null;
    }
    return models.workspaces.findByIdAndUpdate(workspaceId, { $set: update }, { new: true });
  }

  async getUnifiedDashboard(workspaceId: string, datePreset = "this_month", timeRange?: { since: string; until: string }) {
    const workspace = await models.workspaces.findById(workspaceId).select("name metaAds").lean();
    if (!workspace) throw new CustomError("Workspace no encontrado.", 404);
    const accessToken = await this.getGlobalAccessToken();
    const adAccountId = workspace.metaAds?.adAccountId;
    const instagramAccountId = workspace.metaAds?.instagramAccountId;
    if (!adAccountId && !instagramAccountId) {
      throw new CustomError("Este workspace aún no tiene cuentas globales de Meta vinculadas.", 400);
    }

    const [ads, organic] = await Promise.all([
      adAccountId ? this.getGlobalAdsDashboard(adAccountId, accessToken, datePreset, timeRange) : Promise.resolve(null),
      instagramAccountId ? this.getGlobalInstagramVideos(instagramAccountId, accessToken) : Promise.resolve(null),
    ]);
    return { workspace: { id: workspace._id.toString(), name: workspace.name }, ads, organic };
  }

  private async getGlobalAdsDashboard(adAccountId: string, accessToken: string, datePreset: string, timeRange?: { since: string; until: string }) {
    try {
      const [summaryResponse, campaignsResponse] = await Promise.all([
        axios.get(`${this.graphUrl}/act_${adAccountId}/insights`, { params: { access_token: accessToken, level: "account", fields: "spend,reach,impressions,clicks,cpc,cpm,actions,cost_per_action_type", ...this.dateParams(datePreset, timeRange) } }),
        axios.get(`${this.graphUrl}/act_${adAccountId}/insights`, { params: { access_token: accessToken, level: "campaign", fields: "campaign_id,campaign_name,spend,reach,impressions,clicks,cpc,cpm,actions,cost_per_action_type", ...this.dateParams(datePreset, timeRange), limit: 100 } }),
      ]);
      const summary = summaryResponse.data.data?.[0] || {};
      const cost = (summary.cost_per_action_type || []).find((item: any) => ["lead", "purchase", "offsite_conversion.fb_pixel_purchase"].includes(item.action_type)) || summary.cost_per_action_type?.[0];
      return {
        summary: { spend: Number(summary.spend || 0), reach: Number(summary.reach || 0), impressions: Number(summary.impressions || 0), clicks: Number(summary.clicks || 0), cpc: Number(summary.cpc || 0), cpm: Number(summary.cpm || 0), costPerResult: Number(cost?.value || 0), resultType: cost?.action_type || null },
        campaigns: (campaignsResponse.data.data || []).map((campaign: any) => ({ id: campaign.campaign_id, name: campaign.campaign_name, spend: Number(campaign.spend || 0), reach: Number(campaign.reach || 0), impressions: Number(campaign.impressions || 0), clicks: Number(campaign.clicks || 0), cpc: Number(campaign.cpc || 0), cpm: Number(campaign.cpm || 0) })),
      };
    } catch (error: any) {
      throw this.metaError(error, "No fue posible obtener las métricas publicitarias de Meta.");
    }
  }

  /** Max media pulled when listing a profile's videos (4 pages of 50). */
  private static readonly IG_MEDIA_MAX = 200;
  private static readonly IG_MEDIA_PAGE_SIZE = 50;

  /**
   * Walk the `/media` edge following `paging.next`.
   *
   * A single page of 25 hid every reel older than the last few weeks, so
   * anything published earlier could never be linked to its script.
   */
  private async fetchAllInstagramMedia(
    instagramAccountId: string,
    accessToken: string,
    max = MetaService.IG_MEDIA_MAX
  ): Promise<any[]> {
    const fields =
      "id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count";

    const collected: any[] = [];
    let url: string | null = `${this.graphUrl}/${instagramAccountId}/media`;
    let params: Record<string, any> | undefined = {
      access_token: accessToken,
      fields,
      limit: MetaService.IG_MEDIA_PAGE_SIZE,
    };

    while (url && collected.length < max) {
      const response: any = await axios.get(url, params ? { params } : undefined);
      collected.push(...(response.data?.data || []));

      // `paging.next` is a fully-formed URL with the cursor and token baked in.
      url = response.data?.paging?.next || null;
      params = undefined;
    }

    return collected.slice(0, max);
  }

  /** How many insight requests run at once. Graph throttles aggressively. */
  private static readonly INSIGHTS_CONCURRENCY = 5;

  private static baseVideo(video: any) {
    return {
      id: video.id,
      caption: video.caption || "",
      mediaUrl: video.media_url || video.thumbnail_url || null,
      thumbnailUrl: video.thumbnail_url || video.media_url || null,
      permalink: video.permalink,
      timestamp: video.timestamp,
      likes: Number(video.like_count || 0),
      comments: Number(video.comments_count || 0),
      reach: 0,
      impressions: 0,
      views: 0,
      saved: 0,
      shares: 0,
    };
  }

  /**
   * Attach per-media insights, in small concurrent batches.
   *
   * When the app lacks `instagram_manage_insights`, Graph answers error #10 for
   * every single media. Firing one request per video then means hundreds of
   * guaranteed failures, which stalls the request past the serverless timeout
   * and the caller ends up with no reels at all. So the first permission error
   * stops the insight pass and the videos are returned with zeroed metrics —
   * listing reels must keep working even when metrics are unavailable.
   */
  private async attachInsights(videos: any[], accessToken: string) {
    const results: any[] = [];
    let insightsBlocked = false;

    for (let i = 0; i < videos.length; i += MetaService.INSIGHTS_CONCURRENCY) {
      const batch = videos.slice(i, i + MetaService.INSIGHTS_CONCURRENCY);

      const settled = await Promise.all(
        batch.map(async (video: any) => {
          const base = MetaService.baseVideo(video);
          if (insightsBlocked) return base;

          try {
            // `views` is the v22 native metric; `plays` only survives on older media.
            const res = await axios.get(`${this.graphUrl}/${video.id}/insights`, {
              params: {
                access_token: accessToken,
                metric: "views,reach,saved,shares,total_interactions",
              },
            });
            const values = Object.fromEntries(
              (res.data.data || []).map((m: any) => [m.name, m.values?.[0]?.value ?? m.value ?? 0])
            );
            return {
              ...base,
              reach: Number(values.reach || 0),
              impressions: Number(values.impressions || 0),
              views: Number(values.views ?? values.plays ?? 0),
              saved: Number(values.saved || 0),
              shares: Number(values.shares || 0),
            };
          } catch (error: any) {
            // #10 = the app itself lacks the permission; retrying per video is pointless.
            if (error.response?.data?.error?.code === 10) {
              if (!insightsBlocked) {
                console.warn(
                  "[MetaService] Instagram insights unavailable for this app " +
                    "(missing instagram_manage_insights). Returning reels without metrics."
                );
              }
              insightsBlocked = true;
            }
            return base;
          }
        })
      );

      results.push(...settled);
    }

    return results;
  }

  /**
   * One page of published videos, newest first.
   *
   * The reel picker used to load the whole feed (163 media for a large account,
   * ~9s) just to let someone pick one. This walks Graph's own cursor instead,
   * so the modal opens immediately and loads more on demand.
   */
  async getInstagramMediaPage(
    workspaceId: string,
    options: { limit?: number; after?: string } = {}
  ): Promise<{ reels: any[]; nextCursor: string | null; accountName: string | null }> {
    const workspace: any = await models.workspaces
      .findById(workspaceId)
      .select("metaAds")
      .lean();

    const igId = workspace?.metaAds?.instagramAccountId;
    if (!igId) return { reels: [], nextCursor: null, accountName: null };

    const token =
      workspace.metaAds?.accessToken || (await this.getGlobalAccessToken().catch(() => null));
    if (!token) return { reels: [], nextCursor: null, accountName: null };

    const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);

    try {
      // Graph returns mixed media, so ask for a bit more than requested to
      // still fill a page after filtering out photos.
      const res = await axios.get(`${this.graphUrl}/${igId}/media`, {
        params: {
          access_token: token,
          fields:
            "id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count",
          limit: limit * 2,
          ...(options.after ? { after: options.after } : {}),
        },
      });

      const data: any[] = res.data?.data ?? [];
      const videos = data.filter(
        (m) => m.media_type === "VIDEO" || m.media_product_type === "REELS"
      );

      return {
        reels: videos.slice(0, limit).map((v) => MetaService.baseVideo(v)),
        nextCursor: res.data?.paging?.cursors?.after ?? null,
        accountName: workspace.metaAds?.instagramAccountName ?? null,
      };
    } catch (error: any) {
      throw this.metaError(error, "No fue posible obtener los Reels de Instagram.");
    }
  }

  /**
   * One page of ads from the workspace's ad account, with lifetime insights.
   *
   * Linking an ad used to mean pasting its numeric id by hand. This lets the
   * picker show name, thumbnail, spend and results so the right one is
   * recognizable.
   */
  async getAdsPage(
    workspaceId: string,
    options: { limit?: number; after?: string } = {}
  ): Promise<{ ads: any[]; nextCursor: string | null; adAccountName: string | null }> {
    const workspace: any = await models.workspaces
      .findById(workspaceId)
      .select("metaAds")
      .lean();

    const adAccountId = workspace?.metaAds?.adAccountId;
    if (!adAccountId) return { ads: [], nextCursor: null, adAccountName: null };

    const token =
      workspace.metaAds?.accessToken || (await this.getGlobalAccessToken().catch(() => null));
    if (!token) return { ads: [], nextCursor: null, adAccountName: null };

    const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);

    try {
      const res = await axios.get(`${this.graphUrl}/act_${adAccountId}/ads`, {
        params: {
          access_token: token,
          limit,
          ...(options.after ? { after: options.after } : {}),
          fields:
            "id,name,effective_status,created_time," +
            "creative{thumbnail_url,effective_object_story_id}," +
            "insights.date_preset(maximum){spend,impressions,reach,clicks,actions,purchase_roas}",
        },
      });

      const ads = (res.data?.data ?? []).map((ad: any) => {
        const insights = ad.insights?.data?.[0] ?? {};
        return {
          id: ad.id,
          name: ad.name || "Sin nombre",
          status: ad.effective_status ?? null,
          createdTime: ad.created_time ?? null,
          thumbnailUrl: ad.creative?.thumbnail_url ?? null,
          // Ties the ad back to the organic post it promotes, when it has one.
          storyId: ad.creative?.effective_object_story_id ?? null,
          spend: Number(insights.spend || 0),
          impressions: Number(insights.impressions || 0),
          reach: Number(insights.reach || 0),
          clicks: Number(insights.clicks || 0),
          leads: extractLeadActions(insights.actions),
          roas: Number(insights.purchase_roas?.[0]?.value || 0),
        };
      });

      return {
        ads,
        nextCursor: res.data?.paging?.cursors?.after ?? null,
        adAccountName: workspace.metaAds?.adAccountName ?? null,
      };
    } catch (error: any) {
      throw this.metaError(error, "No fue posible obtener los anuncios de Meta Ads.");
    }
  }

  private async getGlobalInstagramVideos(instagramAccountId: string, accessToken: string) {
    try {
      const profileResponse = await axios.get(`${this.graphUrl}/${instagramAccountId}`, { params: { access_token: accessToken, fields: "username,followers_count,media_count,profile_picture_url" } });
      const media = await this.fetchAllInstagramMedia(instagramAccountId, accessToken);
      const videos = media.filter((media: any) => media.media_type === "VIDEO" || media.media_product_type === "REELS");

      const videosWithInsights = await this.attachInsights(videos, accessToken);
      return { profile: profileResponse.data, videos: videosWithInsights };
    } catch (error: any) {
      throw this.metaError(error, "No fue posible obtener las métricas orgánicas de Instagram.");
    }
  }

  /**
   * Exchanges a short-lived user token for a long-lived one (60 days)
   * Then optionally swaps it for a permanent Page Access Token
   */
  async exchangeToken(shortToken: string): Promise<string> {
    try {
      if (!this.appId || !this.appSecret) {
        throw new Error("Meta App Credentials are not configured in backend environments.");
      }

      const response = await axios.get(`${this.graphUrl}/oauth/access_token`, {
        params: {
          grant_type: "fb_exchange_token",
          client_id: this.appId,
          client_secret: this.appSecret,
          fb_exchange_token: shortToken,
        },
      });

      return response.data.access_token;
    } catch (error: any) {
      console.error("Meta Token Exchange Error:", error.response?.data || error.message);
      throw new Error("Failed to exchange Meta access token.");
    }
  }

  /**
   * Internal helper to fetch all pages of a Meta Graph API collection
   */
  private async fetchAllPaginated<T>(url: string, params: Record<string, any>): Promise<T[]> {
    let allData: T[] = [];
    let nextUrl: string | null = null;

    try {
      // First page
      const response = await axios.get(url, { params });
      allData = [...allData, ...response.data.data];
      nextUrl = response.data.paging?.next || null;

      // Subsequent pages
      while (nextUrl) {
        const nextResponse = await axios.get(nextUrl);
        allData = [...allData, ...nextResponse.data.data];
        nextUrl = nextResponse.data.paging?.next || null;
      }

      return allData;
    } catch (error: any) {
      if (!url.includes('/me/businesses')) {
        console.error(`Meta Pagination Error for URL ${url}:`, error.response?.data || error.message);
      }
      throw error;
    }
  }

  /**
   * Lists pages owned by the user
   */
  async listUserPages(userAccessToken: string) {
    try {
      const pages = await this.fetchAllPaginated<any>(`${this.graphUrl}/me/accounts`, {
        access_token: userAccessToken,
        fields: "id,name,access_token,category,category_list,tasks,picture{url}",
        limit: 100
      });
      return pages;
    } catch (error: any) {
      console.error("Meta List Pages Error:", error.response?.data || error.message);
      throw new Error("Failed to list Facebook Pages.");
    }
  }

  /**
   * Updates workspace with Meta integration data
   */
  async saveIntegration(workspaceId: string, data: {
    accessToken: string;
    pageAccessToken?: string;
    pageId: string;
    pageName: string;
    adAccountId?: string;
    adAccountName?: string;
  }) {
    // Dynamically build the update object to only update provided fields
    const updateQuery: Record<string, any> = {
      "metaAds.lastSyncedAt": new Date(),
    };

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        updateQuery[`metaAds.${key}`] = value;
      }
    }

    const workspace = await models.workspaces.findByIdAndUpdate(
      workspaceId,
      { $set: updateQuery },
      { new: true }
    );

    if (!workspace) throw new Error("Workspace not found.");
    return workspace;
  }

  /**
   * Lists ad accounts owned by the user/business
   */
  async listAdAccounts(accessToken: string) {
    try {
      const accounts = await this.fetchAllPaginated<any>(`${this.graphUrl}/me/adaccounts`, {
        access_token: accessToken,
        fields: "name,account_id,account_status,currency",
        limit: 100
      });
      return accounts;
    } catch (error: any) {
      const metaError = error.response?.data || error.message;
      console.error("Meta List AdAccounts Error:", metaError);
      throw new Error(`Failed to list Facebook Ad Accounts. Meta Error: ${JSON.stringify(metaError)}`);
    }
  }

  private dateParams(datePreset: string, timeRange?: { since: string; until: string }) {
    return timeRange
      ? { time_range: JSON.stringify(timeRange) }
      : { date_preset: datePreset }
  }

  async getAdInsights(adAccountId: string, accessToken: string, datePreset: string = "this_month", timeRange?: { since: string; until: string }) {
    try {
      // 1. Get Aggregated Insights + Ad statuses (in parallel)
      const [aggregatedResponse, dailyResponse, adsStatusResponse] = await Promise.all([
        axios.get(`${this.graphUrl}/act_${adAccountId}/insights`, {
          params: {
            access_token: accessToken,
            level: "ad",
            fields: "ad_id,ad_name,campaign_name,spend,impressions,clicks,cpc,cpm,reach,actions,action_values,cost_per_action_type,purchase_roas",
            ...this.dateParams(datePreset, timeRange),
          },
        }),
        // 2. Get Daily Insights for Time Series Chart
        axios.get(`${this.graphUrl}/act_${adAccountId}/insights`, {
          params: {
            access_token: accessToken,
            level: "account",
            fields: "spend,clicks,impressions,actions,date_start",
            ...this.dateParams(datePreset, timeRange),
            time_increment: 1,
          },
        }),
        // 3. Get current effective_status per ad (not available in insights)
        axios.get(`${this.graphUrl}/act_${adAccountId}/ads`, {
          params: {
            access_token: accessToken,
            fields: "id,effective_status",
            limit: 500,
          },
        }).catch(() => ({ data: { data: [] } })),
      ]);

      // Build a status map: adId -> effective_status
      const statusMap: Record<string, string> = {};
      for (const ad of (adsStatusResponse.data.data || [])) {
        statusMap[ad.id] = ad.effective_status;
      }

      // Merge status into each insight row
      const insights = (aggregatedResponse.data.data || []).map((row: any) => ({
        ...row,
        effective_status: statusMap[row.ad_id] ?? 'UNKNOWN',
      }));

      return {
        insights,
        dailySpend: dailyResponse.data.data || []
      };
    } catch (error: any) {
      const metaError = error.response?.data || error.message;
      console.error("Meta Ads Insights Error:", metaError);
      throw new Error(this.explicarErrorMeta(metaError));
    }
  }

  /**
   * Gets spend by platform (Facebook vs Instagram) for the ad account
   */
  async getSpendByPlatform(adAccountId: string, accessToken: string, datePreset: string = "this_month", timeRange?: { since: string; until: string }) {
    try {
      const response = await axios.get(`${this.graphUrl}/act_${adAccountId}/insights`, {
        params: {
          access_token: accessToken,
          level: "account",
          fields: "spend",
          breakdowns: "publisher_platform",
          ...this.dateParams(datePreset, timeRange),
        },
      });
      return response.data.data;
    } catch (error: any) {
      const metaError = error.response?.data || error.message;
      console.error("Meta Platform Spend Error:", metaError);
      throw new Error(`Failed to fetch Platform Spend. Meta Error: ${JSON.stringify(metaError)}`);
    }
  }

  /**
   * Gets spend by platform for each Ad
   */
  async getAdsSpendByPlatform(adAccountId: string, accessToken: string, datePreset: string = "this_month", timeRange?: { since: string; until: string }) {
    try {
      const response = await axios.get(`${this.graphUrl}/act_${adAccountId}/insights`, {
        params: {
          access_token: accessToken,
          level: "ad",
          fields: "ad_id,spend",
          breakdowns: "publisher_platform",
          ...this.dateParams(datePreset, timeRange),
        },
      });
      return response.data.data;
    } catch (error: any) {
      const metaError = error.response?.data || error.message;
      console.error("Meta Ads Platform Spend Error:", metaError);
      throw new Error(`Failed to fetch Ads Platform Spend. Meta Error: ${JSON.stringify(metaError)}`);
    }
  }
  /**
   * Gets organic insights for the Facebook Page
   */
  async getOrganicInsights(pageId: string, userAccessToken: string, pageAccessToken?: string) {
    try {
      // Determine which token to use for Facebook Page calls.
      // The stored pageAccessToken is preferred; if not available, derive it from the user token.
      let pageToken = pageAccessToken || null;

      if (!pageToken) {
        try {
          const tokenCheck = await axios.get(`${this.graphUrl}/${pageId}`, {
            params: { access_token: userAccessToken, fields: "access_token" }
          });
          if (tokenCheck.data?.access_token) {
            pageToken = tokenCheck.data.access_token;
          }
        } catch (e) {
          // No log needed, will fallback to user token
        }
      }

      // Final FB page token: prefer derived/stored page token, fallback to user token
      const fbToken = pageToken || userAccessToken;

      // 1. Get basic page info (followers, likes)
      const pageInfoResponse = await axios.get(`${this.graphUrl}/${pageId}`, {
        params: {
          access_token: fbToken,
          fields: "fan_count,followers_count,name,instagram_business_account",
        },
      });

      // 2. Get latest 5 Facebook posts
      const postsResponse = await axios.get(`${this.graphUrl}/${pageId}/published_posts`, {
        params: {
          access_token: fbToken,
          fields: "message,created_time,permalink_url,full_picture,shares",
          limit: 5,
        },
      });

      // 3. Get Instagram basic info if linked
      let igInfo = null;
      if (pageInfoResponse.data.instagram_business_account) {
        const igId = pageInfoResponse.data.instagram_business_account.id;
        const igFields = "followers_count,media_count,username,profile_picture_url";

        // Try with user token first (IG permissions are tied to user, not page token)
        let igFetched = false;
        try {
          const igResponse = await axios.get(`${this.graphUrl}/${igId}`, {
            params: { access_token: userAccessToken, fields: igFields }
          });
          igInfo = igResponse.data;
          igFetched = true;
        } catch (e) {
          // Try page token next
        }

        if (!igFetched) {
          try {
            const igResponse = await axios.get(`${this.graphUrl}/${igId}`, {
              params: { access_token: fbToken, fields: igFields }
            });
            igInfo = igResponse.data;
          } catch (igError: any) {
            console.error(`[MetaService] All IG info fetches failed for page ${pageId}:`, igError.response?.data || igError.message);
          }
        }
      }

      // 4. Get latest 5 Instagram media posts (if IG is linked)
      // IMPORTANT: Instagram Graph API permissions (instagram_basic) are tied to the User Access Token.
      // The Page Access Token often lacks these scopes. Always try User Token first.
      let recentPostsIg: any[] = [];
      if (pageInfoResponse.data.instagram_business_account) {
        const igId = pageInfoResponse.data.instagram_business_account.id;
        const mediaFields = "id,caption,media_url,permalink,timestamp,like_count,comments_count";
        const minimalFields = "id,caption,media_url,permalink,timestamp";

        const tryFetchMedia = async (token: string, fields: string) => {
          const res = await axios.get(`${this.graphUrl}/${igId}/media`, {
            params: { access_token: token, fields, limit: 5 },
          });
          return res.data?.data || [];
        };

        let success = false;

        // Strategy 1: User Access Token with full fields (most likely to have IG permissions)
        try {
          recentPostsIg = await tryFetchMedia(userAccessToken, mediaFields);
          success = true;
        } catch (e) {
          // Try next strategy
        }

        // Strategy 2: User Access Token with minimal fields
        if (!success) {
          try {
            recentPostsIg = await tryFetchMedia(userAccessToken, minimalFields);
            success = true;
          } catch (e) {
            // Try page token
          }
        }

        // Strategy 3: Page Access Token with full fields
        if (!success) {
          try {
            recentPostsIg = await tryFetchMedia(fbToken, mediaFields);
            success = true;
          } catch (e) {
            // Try minimal fields
          }
        }

        // Strategy 4: Page Access Token with minimal fields
        if (!success) {
          try {
            recentPostsIg = await tryFetchMedia(fbToken, minimalFields);
            success = true;
          } catch (lastError: any) {
            console.error(`[MetaService] All IG media strategies failed for page ${pageId}:`, lastError.response?.data || lastError.message);
          }
        }
      }

      return {
        pageInfo: pageInfoResponse.data,
        igInfo,
        recentPosts: postsResponse.data.data || [],
        recentPostsIg,
      };
    } catch (error: any) {
      const metaError = error.response?.data || error.message;
      console.error("Meta Organic Insights Error:", metaError);
      throw new Error(`Failed to fetch Organic Insights. Meta Error: ${JSON.stringify(metaError)}`);
    }
  }

  /**
   * Schedules an Instagram post (image or Reel) via Content Publishing API.
   * scheduledAt must be >= 10 min and <= 75 days from now.
   * Returns the IG media container ID.
   */
  async scheduleInstagramPost(params: {
    pageId: string;
    userAccessToken: string;
    pageAccessToken?: string;
    mediaUrl: string;
    caption: string;
    scheduledAt: Date;
  }): Promise<{ containerId: string; igUserId: string }> {
    // 1. Resolve IG Business Account ID from the linked page
    const token = params.pageAccessToken || params.userAccessToken;
    const pageRes = await axios.get(`${this.graphUrl}/${params.pageId}`, {
      params: { fields: "instagram_business_account", access_token: token },
    });
    const igUserId: string | undefined = pageRes.data.instagram_business_account?.id;
    if (!igUserId) throw new Error("NO_IG_ACCOUNT");

    // 2. Validate scheduled time window
    const nowMs = Date.now();
    const scheduledMs = params.scheduledAt.getTime();
    if (scheduledMs < nowMs + 10 * 60 * 1000) throw new Error("SCHEDULE_TOO_SOON");
    if (scheduledMs > nowMs + 75 * 24 * 60 * 60 * 1000) throw new Error("SCHEDULE_TOO_FAR");
    const scheduledUnix = Math.floor(scheduledMs / 1000);

    // 3. Detect media type from URL
    const isVideo =
      /\/video\/upload\//i.test(params.mediaUrl) ||
      /\.(mp4|mov|avi|mkv|webm)(\?|$)/i.test(params.mediaUrl);

    // 4. Build container params
    const containerParams: Record<string, any> = {
      caption: params.caption || "",
      published: false,
      scheduled_publish_time: scheduledUnix,
      access_token: params.userAccessToken,
    };

    if (isVideo) {
      containerParams.media_type = "REELS";
      containerParams.video_url = params.mediaUrl;
    } else {
      containerParams.image_url = params.mediaUrl;
    }

    // 5. Create media container
    try {
      const containerRes = await axios.post(
        `${this.graphUrl}/${igUserId}/media`,
        null,
        { params: containerParams }
      );
      return { containerId: containerRes.data.id, igUserId };
    } catch (err: any) {
      const metaErr = err.response?.data?.error;
      const msg = metaErr
        ? `Meta ${metaErr.code}: ${metaErr.message}`
        : err.message;
      console.error("[MetaService] scheduleInstagramPost error:", metaErr || err.message);
      throw new Error(msg);
    }
  }

  /**
   * Schedules a Facebook Page post (video or photo) via Graph API.
   * Uses POST /{page-id}/videos for video, /{page-id}/photos for images.
   */
  async scheduleFacebookPost(params: {
    pageId: string;
    pageAccessToken: string;
    mediaUrl: string;
    caption: string;
    scheduledAt: Date;
  }): Promise<{ postId: string }> {
    const nowMs = Date.now();
    const scheduledMs = params.scheduledAt.getTime();
    if (scheduledMs < nowMs + 10 * 60 * 1000) throw new Error("SCHEDULE_TOO_SOON");
    if (scheduledMs > nowMs + 75 * 24 * 60 * 60 * 1000) throw new Error("SCHEDULE_TOO_FAR");
    const scheduledUnix = Math.floor(scheduledMs / 1000);

    const isVideo =
      /\/video\/upload\//i.test(params.mediaUrl) ||
      /\.(mp4|mov|avi|mkv|webm)(\?|$)/i.test(params.mediaUrl);

    try {
      if (isVideo) {
        const res = await axios.post(`${this.graphUrl}/${params.pageId}/videos`, null, {
          params: {
            file_url: params.mediaUrl,
            description: params.caption || "",
            published: false,
            scheduled_publish_time: scheduledUnix,
            access_token: params.pageAccessToken,
          },
        });
        return { postId: res.data.id };
      } else {
        const res = await axios.post(`${this.graphUrl}/${params.pageId}/photos`, null, {
          params: {
            url: params.mediaUrl,
            caption: params.caption || "",
            published: false,
            scheduled_publish_time: scheduledUnix,
            access_token: params.pageAccessToken,
          },
        });
        return { postId: res.data.id };
      }
    } catch (err: any) {
      const metaErr = err.response?.data?.error;
      const msg = metaErr
        ? `Meta ${metaErr.code}: ${metaErr.message}`
        : err.message;
      console.error("[MetaService] scheduleFacebookPost error:", metaErr || err.message);
      throw new Error(msg);
    }
  }
}


export const metaService = new MetaService();
