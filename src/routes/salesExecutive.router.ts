import { Router, type NextFunction, type Response } from "express";
import { getSalesBookingFormById, getSalesBookingForms, getUpcomingSalesMeetings } from "../controllers/salesExecutive.controller";
import { authMiddleware } from "../middlewares/auth.middleware";
import type { AuthRequest } from "../types/AuthRequest";
import models from "../models";

const salesExecutiveRouter = Router();

async function salesExecutiveAccess(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const user = await models.users.findById(req.user?._id).select("role isInternal internalRole isActive").lean();
  if (user?.isActive && (user.role === "superadmin" || (user.isInternal && user.internalRole === "sales_executive"))) {
    next();
    return;
  }
  res.status(403).json({ message: "Acceso exclusivo para el ejecutivo de ventas." });
}

salesExecutiveRouter.use(authMiddleware, salesExecutiveAccess);
salesExecutiveRouter.get("/upcoming-meetings", getUpcomingSalesMeetings);
salesExecutiveRouter.get("/booking-forms", getSalesBookingForms);
salesExecutiveRouter.get("/booking-forms/:formId", getSalesBookingFormById);

export default salesExecutiveRouter;
