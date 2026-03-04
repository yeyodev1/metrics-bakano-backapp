import axios from "axios";
import models from "../models";

/**
 * Service to handle Meta (Facebook/Instagram) Ads API interactions
 */
export class MetaService {
  private get appId() { return process.env.META_APP_ID; }
  private get appSecret() { return process.env.META_APP_SECRET; }
  private readonly graphUrl = "https://graph.facebook.com/v22.0";

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
      const response = await axios.get(`${this.graphUrl}/me/adaccounts`, {
        params: {
          access_token: accessToken,
          fields: "name,account_id,account_status,currency",
        },
      });
      return response.data.data;
    } catch (error: any) {
      const metaError = error.response?.data || error.message;
      console.error("Meta List AdAccounts Error:", metaError);
      throw new Error(`Failed to list Facebook Ad Accounts. Meta Error: ${JSON.stringify(metaError)}`);
    }
  }

  async getAdInsights(adAccountId: string, accessToken: string, datePreset: string = "this_month") {
    try {
      // 1. Get Aggregated Insights
      const aggregatedResponse = await axios.get(`${this.graphUrl}/act_${adAccountId}/insights`, {
        params: {
          access_token: accessToken,
          level: "ad",
          fields: "ad_id,ad_name,campaign_name,spend,impressions,clicks,cpc,cpm,reach,actions,action_values,cost_per_action_type,purchase_roas",
          date_preset: datePreset,
        },
      });

      // 2. Get Daily Insights for Time Series Chart
      const dailyResponse = await axios.get(`${this.graphUrl}/act_${adAccountId}/insights`, {
        params: {
          access_token: accessToken,
          level: "account",
          fields: "spend,clicks,impressions,actions,date_start",
          date_preset: datePreset,
          time_increment: 1,
        },
      });

      return {
        insights: aggregatedResponse.data.data,
        dailySpend: dailyResponse.data.data || []
      };
    } catch (error: any) {
      const metaError = error.response?.data || error.message;
      console.error("Meta Ads Insights Error:", metaError);
      throw new Error(`Failed to fetch Ads insights. Meta Error: ${JSON.stringify(metaError)}`);
    }
  }

  /**
   * Gets spend by platform (Facebook vs Instagram) for the ad account
   */
  async getSpendByPlatform(adAccountId: string, accessToken: string, datePreset: string = "this_month") {
    try {
      const response = await axios.get(`${this.graphUrl}/act_${adAccountId}/insights`, {
        params: {
          access_token: accessToken,
          level: "account",
          fields: "spend",
          breakdowns: "publisher_platform",
          date_preset: datePreset,
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
  async getAdsSpendByPlatform(adAccountId: string, accessToken: string, datePreset: string = "this_month") {
    try {
      const response = await axios.get(`${this.graphUrl}/act_${adAccountId}/insights`, {
        params: {
          access_token: accessToken,
          level: "ad",
          fields: "ad_id,spend",
          breakdowns: "publisher_platform",
          date_preset: datePreset,
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
          console.warn(`[MetaService] Could not derive page access token for page ${pageId}. Using user token for page calls.`);
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
          console.warn(`[MetaService] IG info fetch with user token failed. Trying page token...`);
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
          console.log(`[MetaService] IG media fetched successfully via user token for page ${pageId}.`);
        } catch (e) {
          console.warn(`[MetaService] IG media fetch (user token, full fields) failed. Trying next strategy...`);
        }

        // Strategy 2: User Access Token with minimal fields
        if (!success) {
          try {
            recentPostsIg = await tryFetchMedia(userAccessToken, minimalFields);
            success = true;
            console.log(`[MetaService] IG media fetched via user token (minimal fields) for page ${pageId}.`);
          } catch (e) {
            console.warn(`[MetaService] IG media fetch (user token, minimal fields) failed. Trying page token...`);
          }
        }

        // Strategy 3: Page Access Token with full fields
        if (!success) {
          try {
            recentPostsIg = await tryFetchMedia(fbToken, mediaFields);
            success = true;
            console.log(`[MetaService] IG media fetched via page token for page ${pageId}.`);
          } catch (e) {
            console.warn(`[MetaService] IG media fetch (page token, full fields) failed. Trying minimal fields...`);
          }
        }

        // Strategy 4: Page Access Token with minimal fields
        if (!success) {
          try {
            recentPostsIg = await tryFetchMedia(fbToken, minimalFields);
            success = true;
            console.log(`[MetaService] IG media fetched via page token (minimal fields) for page ${pageId}.`);
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
}

export const metaService = new MetaService();
