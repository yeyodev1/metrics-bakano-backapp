import axios from "axios";
import models from "../models";

/**
 * Service to handle Meta (Facebook/Instagram) Ads API interactions
 */
export class MetaService {
  private get appId() { return process.env.META_APP_ID; }
  private get appSecret() { return process.env.META_APP_SECRET; }
  private readonly graphUrl = "https://graph.facebook.com/v19.0";

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
   * Lists pages owned by the user
   */
  async listUserPages(userAccessToken: string) {
    try {
      const response = await axios.get(`${this.graphUrl}/me/accounts`, {
        params: { access_token: userAccessToken },
      });
      return response.data.data; // Array of pages with their own access_tokens
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
    pageId: string;
    pageName: string;
    adAccountId?: string;
    adAccountName?: string;
  }) {
    const workspace = await models.workspaces.findByIdAndUpdate(
      workspaceId,
      {
        metaAds: {
          ...data,
          lastSyncedAt: new Date(),
        },
      },
      { new: true }
    );

    if (!workspace) throw new Error("Workspace not found.");
    return workspace;
  }
}

export const metaService = new MetaService();
