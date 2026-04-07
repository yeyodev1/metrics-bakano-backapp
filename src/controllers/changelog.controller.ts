import type { Response } from "express";
import path from "path";
import fs from "fs";
import { AuthRequest } from "../types/AuthRequest";
import { resendService } from "../services/resend.service";
import models from "../models";

function loadChangelog() {
  const filePath = path.join(__dirname, "../data/changelog.json");
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as { versions: ChangelogVersion[] };
}

export interface ChangelogChange {
  type: "new" | "improved" | "fix" | "removed";
  text: string;
}

export interface ChangelogVersion {
  version: string;
  date: string;
  title: string;
  summary: string;
  changes: ChangelogChange[];
}

/**
 * GET /api/changelog
 * Returns the full changelog (all versions). Auth required.
 */
export async function getChangelog(req: AuthRequest, res: Response): Promise<void> {
  try {
    const changelog = loadChangelog();
    res.status(200).json(changelog);
  } catch (error) {
    console.error("[ChangelogController] getChangelog error:", error);
    res.status(500).json({ message: "Error al leer el changelog." });
  }
}

/**
 * POST /api/changelog/send
 * Sends the latest version changelog email to all active users. Superadmin only.
 * Body: { versionIndex?: number } — defaults to 0 (latest)
 */
export async function sendChangelog(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { versionIndex = 0 } = req.body;
    const changelog = loadChangelog();
    const version = changelog.versions[versionIndex];

    if (!version) {
      res.status(404).json({ message: "Versión no encontrada en el changelog." });
      return;
    }

    const users = await models.users.find({ isActive: true }).lean();

    if (!users.length) {
      res.status(200).json({ message: "No hay usuarios activos para notificar.", sent: 0 });
      return;
    }

    const results = await Promise.allSettled(
      users.map((user) =>
        resendService.sendChangelogEmail({
          to: user.email,
          recipientName: user.name || user.email,
          version,
        })
      )
    );

    const sent = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;

    console.log(`[ChangelogController] Changelog v${version.version} sent to ${sent}/${users.length} users`);

    res.status(200).json({
      message: `Changelog enviado exitosamente.`,
      version: version.version,
      sent,
      failed,
      total: users.length,
    });
  } catch (error) {
    console.error("[ChangelogController] sendChangelog error:", error);
    res.status(500).json({ message: "Error al enviar el changelog." });
  }
}
