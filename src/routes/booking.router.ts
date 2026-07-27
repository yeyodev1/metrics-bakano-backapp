import { Router } from "express";
import { getSalesEligibility, getUpcomingSalesAppointment, submitSalesBookingRequest } from "../controllers/booking.controller";
import { authMiddleware } from "../middlewares/auth.middleware";
import { uploadDocument } from "../middlewares/upload.middleware";
import { workspaceAccessMiddleware } from "../middlewares/workspaceAccess.middleware";

const bookingRouter = Router();

bookingRouter.use(authMiddleware);
bookingRouter.get("/:workspaceId/sales-eligibility", workspaceAccessMiddleware, getSalesEligibility);
bookingRouter.get("/:workspaceId/upcoming-sales-appointment", workspaceAccessMiddleware, getUpcomingSalesAppointment);
bookingRouter.post("/:workspaceId/sales-request", workspaceAccessMiddleware, uploadDocument.array("evidence", 5), submitSalesBookingRequest);

export default bookingRouter;
