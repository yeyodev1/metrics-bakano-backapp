import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { superadminMiddleware } from "../middlewares/superadmin.middleware";
import {
  listSuperadmins, createSuperadmin, deleteSuperadmin,
  listInternalUsers, createInternalUser, deleteInternalUser,
} from "../controllers/admin.controller";

const adminRouter = Router();

// All admin routes require auth + superadmin role
adminRouter.use(authMiddleware, superadminMiddleware);

adminRouter.get("/superadmins", listSuperadmins);
adminRouter.post("/superadmins", createSuperadmin);
adminRouter.delete("/superadmins/:userId", deleteSuperadmin);

adminRouter.get("/internal-users", listInternalUsers);
adminRouter.post("/internal-users", createInternalUser);
adminRouter.delete("/internal-users/:userId", deleteInternalUser);

export default adminRouter;
