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
          fields: "spend,date_start",
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
  async getOrganicInsights(pageId: string, accessToken: string) {
    try {
      let finalToken = accessToken;

      // Intentar obtener el page_access_token por si el token provisto es de usuario antiguo
      try {
        const tokenCheck = await axios.get(`${this.graphUrl}/${pageId}`, {
          params: {
            access_token: accessToken,
            fields: "access_token"
          }
        });
        if (tokenCheck.data?.access_token) {
          finalToken = tokenCheck.data.access_token;
        }
      } catch (e) {
        console.warn(`Could not verify page_access_token for page ${pageId}, proceeding with original token.`);
      }

      // 1. Get basic page info (followers, likes)
      const pageInfoResponse = await axios.get(`${this.graphUrl}/${pageId}`, {
        params: {
          access_token: finalToken,
          fields: "fan_count,followers_count,name,instagram_business_account",
        },
      });

      // 2. Get latest 5 posts
      const postsResponse = await axios.get(`${this.graphUrl}/${pageId}/published_posts`, {
        params: {
          access_token: finalToken,
          fields: "message,created_time,permalink_url,full_picture,shares",
          limit: 5,
        },
      });

      // 3. Get Instagram Info if linked
      let igInfo = null;
      if (pageInfoResponse.data.instagram_business_account) {
        try {
          const igId = pageInfoResponse.data.instagram_business_account.id;
          const igResponse = await axios.get(`${this.graphUrl}/${igId}`, {
            params: {
              access_token: finalToken,
              fields: "followers_count,media_count,username,profile_picture_url"
            }
          });
          igInfo = igResponse.data;
        } catch (igError) {
          console.warn(`Could not fetch Instagram data for page ${pageId}`);
        }
      }

      // 4. Get latest 5 Instagram posts (if IG is linked)
      let recentPostsIg = [];
      if (igInfo && pageInfoResponse.data.instagram_business_account) {
        try {
          const igId = pageInfoResponse.data.instagram_business_account.id;
          const igMediaResponse = await axios.get(`${this.graphUrl}/${igId}/media`, {
            params: {
              access_token: finalToken,
              fields: "id,caption,media_url,permalink,timestamp,like_count,comments_count",
              limit: 5,
            },
          });
          recentPostsIg = igMediaResponse.data?.data || [];
        } catch (igMediaError: any) {
          console.warn(`Could not fetch Instagram media for page ${pageId}`, igMediaError.response?.data || igMediaError.message);
        }
      }

      return {
        pageInfo: pageInfoResponse.data,
        igInfo: igInfo,
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
