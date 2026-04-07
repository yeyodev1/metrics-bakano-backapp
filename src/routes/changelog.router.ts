import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { superadminMiddleware } from "../middlewares/superadmin.middleware";
import { getChangelog, sendChangelog } from "../controllers/changelog.controller";

const changelogRouter = Router();

// GET — any authenticated user can see the changelog
changelogRouter.get("/", authMiddleware, getChangelog);

// POST /send — superadmin only
changelogRouter.post("/send", authMiddleware, superadminMiddleware, sendChangelog);

export default changelogRouter;
