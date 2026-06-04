import { Router } from "express";
import { acceptVideoResponsibilities, submitContract, checkOnboardingStatus, markMeetingScheduled, downloadContract } from "../controllers/onboarding.controller";

export const onboardingRouter = Router();

onboardingRouter.get("/:workspaceId", checkOnboardingStatus);
onboardingRouter.get("/:workspaceId/contract.pdf", downloadContract);
onboardingRouter.post("/:workspaceId/step1", acceptVideoResponsibilities);
onboardingRouter.post("/:workspaceId/step2", submitContract);
onboardingRouter.post("/:workspaceId/step3", markMeetingScheduled);
