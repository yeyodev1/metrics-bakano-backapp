import { UserModel } from "./user.model";
import { WorkspaceModel } from "./workspace.model";
import { PlanningModel } from "./planning.model";
import { VideoPlanningModel } from "./videoPlanning.model";
import { NotificationModel } from "./notification.model";
import { DailyBillingEntryModel } from "./dailyBilling.model";
import { TeamKpiRecordModel } from "./teamKpiRecord.model";
import { VisitLogModel } from "./visitLog.model";
import { SalesDailySummaryModel } from "./salesDailySummary.model";
import { TumeseroUsageModel } from "./tumeseroUsage.model";
import { BranchModel } from "./branch.model";
import { EvaluationModel } from "./evaluation.model";
import { FlorindaDailySalesModel } from "./florindaDailySales.model";
import { SalesBookingRequestModel } from "./salesBookingRequest.model";
import { SalesAppointmentModel } from "./salesAppointment.model";
import { MetaGlobalIntegrationModel } from "./metaGlobalIntegration.model";
import { VideoMetricSnapshotModel } from "./videoMetricSnapshot.model";
import { EngramModel } from "./engram.model";
import { ScriptFeedbackModel } from "./scriptFeedback.model";

const models = {
  users: UserModel,
  workspaces: WorkspaceModel,
  planning: PlanningModel,
  videoPlanning: VideoPlanningModel,
  notifications: NotificationModel,
  dailyBilling: DailyBillingEntryModel,
  teamKpiRecords: TeamKpiRecordModel,
  visitLogs: VisitLogModel,
  salesDailySummary: SalesDailySummaryModel,
  tumeseroUsage: TumeseroUsageModel,
  branches: BranchModel,
  evaluations: EvaluationModel,
  florindaDailySales: FlorindaDailySalesModel,
  salesBookingRequests: SalesBookingRequestModel,
  salesAppointments: SalesAppointmentModel,
  metaGlobalIntegration: MetaGlobalIntegrationModel,
  videoMetricSnapshots: VideoMetricSnapshotModel,
  engrams: EngramModel,
  scriptFeedback: ScriptFeedbackModel,
};

export default models;
