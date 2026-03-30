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
};

export default models;
