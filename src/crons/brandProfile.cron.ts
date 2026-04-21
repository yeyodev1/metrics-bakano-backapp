import cron from "node-cron";
import { Types } from "mongoose";
import models from "../models";
import { resendService } from "../services/resend.service";
import { _notifyAllStakeholders, getBrandProfileCompletionScore } from "../controllers/brandProfile.controller";

export function initBrandProfileCrons() {
  // Daily at 9AM Ecuador (UTC-5) = 14:00 UTC
  cron.schedule(
    "0 14 * * *",
    async () => {
      console.log("[brand-profile-cron] Checking incomplete brand profiles...");
      try {
        const workspaces = await models.workspaces
          .find({ brandProfileInviteSentAt: { $exists: true, $ne: null }, isActive: true })
          .lean();

        const appUrl = process.env.APP_URL || "https://metrics.bakano.ec";

        for (const ws of workspaces) {
          const score = getBrandProfileCompletionScore(ws.brandProfile);
          if (score >= 100) continue;

          const wsId = (ws._id as Types.ObjectId).toString();

          // In-app notifications for internal + external
          await _notifyAllStakeholders(wsId, ws.name, score);

          // Email reminders to external clients
          const clients = await models.users
            .find({
              isInternal: false,
              role: { $ne: "superadmin" },
              "workspaces.workspaceId": new Types.ObjectId(wsId),
              isActive: true,
            })
            .lean();

          for (const client of clients) {
            resendService
              .sendBrandProfileInvite({
                to: client.email,
                recipientName: client.name,
                workspaceName: ws.name,
                brandProfileUrl: `${appUrl}/app/workspaces/${wsId}/brand-profile`,
                completionScore: score,
              })
              .catch((err) =>
                console.error("[brand-profile-cron] email error:", err?.message)
              );
          }
        }

        console.log(
          `[brand-profile-cron] Processed ${workspaces.length} workspace(s).`
        );
      } catch (err) {
        console.error("[brand-profile-cron] error:", err);
      }
    },
    { timezone: "UTC" }
  );

  console.log(
    "[brand-profile-cron] Daily reminder registered at 14:00 UTC (9AM Ecuador)."
  );
}
