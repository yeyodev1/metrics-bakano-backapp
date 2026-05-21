import cron from "node-cron";
import models from "../models";
import { resendService } from "../services/resend.service";
import { billingService } from "../services/billing.service";

export function initBillingCrons() {
  // 10AM Ecuador (UTC-5) = 15:00 UTC
  cron.schedule("0 15 * * *", async () => {
    console.log("[BillingCron] Running 10AM Ecuador reminder...");
    await runDailyBillingReminder("10AM");
  });

  // 7PM Ecuador (UTC-5) = 00:00 UTC
  cron.schedule("0 0 * * *", async () => {
    console.log("[BillingCron] Running 7PM Ecuador reminder...");
    await runDailyBillingReminder("7PM");
  });

  console.log("[BillingCron] Daily billing crons initialized.");
}

async function runDailyBillingReminder(slot: "10AM" | "7PM") {
  try {
    // Get today normalized in Ecuador time
    const today = billingService.normalizeDateToEcuador(new Date());

    // Get all active workspaces
    const workspaces = await models.workspaces.find({ isActive: true }).lean();

    for (const workspace of workspaces) {
      try {
        // Get all external (non-internal) users with access to this workspace
        const users = await models.users
          .find({
            isActive: true,
            isInternal: { $ne: true },
            $or: [
              { workspaceId: workspace._id },
              { "workspaces.workspaceId": workspace._id },
            ],
          })
          .lean();

        if (users.length === 0) continue;

        // Get day summary for this workspace
        const daySummary = await billingService.getDaySummary(
          workspace._id.toString(),
          today
        );

        for (const user of users) {
          try {
            // Check if this user has already filled for today
            const userEntry = daySummary.entries.find(
              (e: any) => e.userId.toString() === user._id.toString()
            );
            const hasFilled = !!userEntry;

            await resendService.sendDailyBillingReminder({
              to: user.email,
              recipientName: user.name || user.email,
              workspaceName: workspace.name,
              workspaceId: workspace._id.toString(),
              hasFilled,
              filledAmount: userEntry?.amount,
              totalDayAmount: daySummary.totalAmount,
              date: today,
            });
          } catch (userError: any) {
            console.error(
              `[BillingCron] Failed to send reminder to ${user.email}:`,
              userError.message
            );
          }
        }
      } catch (workspaceError: any) {
        console.error(
          `[BillingCron] Error processing workspace ${workspace.name}:`,
          workspaceError.message
        );
      }
    }

    console.log(`[BillingCron] ${slot} reminder completed.`);
  } catch (error: any) {
    console.error(`[BillingCron] Error in ${slot} reminder:`, error);
  }
}
