import { Request, Response, NextFunction } from "express";
import { WorkspaceModel } from "../models/workspace.model";

export const handleMetaSchedulingWebhook = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const payload = req.body;

    // Based on the prompt: check assigned_agent_name == "Deni"
    // The exact structure of the payload depends on Calendly/HubSpot. Let's assume a generic shape or a specific field in the body.
    const assignedAgentName = payload?.assigned_agent_name || payload?.event?.assigned_agent_name || payload?.payload?.assigned_agent_name;
    const workspaceId = payload?.workspaceId || payload?.tracking?.workspaceId || req.query.workspaceId;

    if (assignedAgentName === "Deni") {
      // Find workspace and update meetingScheduled status if workspaceId is provided
      if (workspaceId) {
        const workspace = await WorkspaceModel.findById(workspaceId);
        if (workspace) {
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
        }
      } else {
        // If workspaceId is not in the payload, we might need another way to identify it, 
        // e.g. email match. For simplicity, we assume workspaceId is passed as query parameter in the webhook URL.
      }
    }

    res.status(200).send({ message: "Webhook received successfully." });
  } catch (error) {
    console.error("Error in handleMetaSchedulingWebhook:", error);
    res.status(500).send({ error: "Internal server error" });
  }
};
