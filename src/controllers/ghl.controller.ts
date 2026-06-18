import { Request, Response } from "express";
import { HttpStatusCode } from "axios";
import { ghlService } from "../services/ghl.service";

class GhlController {
  async getWorkspaceMeetings(req: Request, res: Response) {
    try {
      const { workspaceId } = req.params;
      const { startDate, endDate } = req.query;

      if (!workspaceId) {
        res.status(HttpStatusCode.BadRequest).send({ message: "El ID del espacio de trabajo es requerido." });
        return;
      }
      if (!startDate || !endDate) {
        res.status(HttpStatusCode.BadRequest).send({ message: "Se requieren las fechas startDate y endDate." });
        return;
      }

      const startDateStr = Array.isArray(startDate) ? startDate[0] : startDate;
      const endDateStr = Array.isArray(endDate) ? endDate[0] : endDate;

      const meetings = await ghlService.getMeetingsForWorkspace(
        workspaceId as string,
        startDateStr as string,
        endDateStr as string
      );

      res.status(HttpStatusCode.Ok).send({
        message: "Meetings retrieved successfully.",
        meetings
      });
      return;
    } catch (error: any) {
      console.error("Error in getWorkspaceMeetings:", error);
      res.status(HttpStatusCode.InternalServerError).send({
        message: "An error occurred while retrieving meetings."
      });
      return;
    }
  }
}

export const ghlController = new GhlController();
