import { UserModel } from "./user.model";
import { WorkspaceModel } from "./workspace.model";
import { PlanningModel } from "./planning.model";
import { SurveyModel } from "./survey.model";
import { SurveyAssignmentModel } from "./surveyAssignment.model";
import { SurveyResponseModel } from "./surveyResponse.model";
import { VideoPlanningModel } from "./videoPlanning.model";
import { ClientMeetingModel } from "./clientMeeting.model";
import { NotificationModel } from "./notification.model";
import { DailyBillingEntryModel } from "./dailyBilling.model";
import { TeamKpiRecordModel } from "./teamKpiRecord.model";
import { VisitLogModel } from "./visitLog.model";
import { SalesDailySummaryModel } from "./salesDailySummary.model";
import { TumeseroUsageModel } from "./tumeseroUsage.model";
import { BranchModel } from "./branch.model";
import { EvaluationModel } from "./evaluation.model";

const models = {
  users: UserModel,
  workspaces: WorkspaceModel,
  planning: PlanningModel,
  surveys: SurveyModel,
  surveyAssignments: SurveyAssignmentModel,
  surveyResponses: SurveyResponseModel,
  videoPlanning: VideoPlanningModel,
  clientMeetings: ClientMeetingModel,
  notifications: NotificationModel,
  dailyBilling: DailyBillingEntryModel,
  teamKpiRecords: TeamKpiRecordModel,
  visitLogs: VisitLogModel,
  salesDailySummary: SalesDailySummaryModel,
  tumeseroUsage: TumeseroUsageModel,
  branches: BranchModel,
  evaluations: EvaluationModel,
};

export default models;
