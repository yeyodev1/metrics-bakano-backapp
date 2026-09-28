import { Router } from "express";
import { acceptVideoResponsibilities, submitContract, checkOnboardingStatus, markMeetingScheduled, markResourcesCompleted, downloadContract, contractEmailStatus, resendContractEmail } from "../controllers/onboarding.controller";

export const onboardingRouter = Router();

onboardingRouter.get("/:workspaceId", checkOnboardingStatus);
onboardingRouter.get("/:workspaceId/contract.pdf", downloadContract);
onboardingRouter.post("/:workspaceId/step1", acceptVideoResponsibilities);
onboardingRouter.post("/:workspaceId/step2", submitContract);
onboardingRouter.get("/:workspaceId/contract-email", contractEmailStatus);
onboardingRouter.post("/:workspaceId/contract-email", resendContractEmail);
onboardingRouter.post("/:workspaceId/step-resources", markResourcesCompleted);
onboardingRouter.post("/:workspaceId/step3", markMeetingScheduled);
