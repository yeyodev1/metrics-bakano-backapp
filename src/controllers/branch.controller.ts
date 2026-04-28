import type { Request, Response, NextFunction } from "express";
import { Types } from "mongoose";
import models from "../models";

// Helper for status codes
const HttpStatusCode = {
  Ok: 200,
  Created: 201,
  BadRequest: 400,
  NotFound: 404,
  InternalServerError: 500,
};

export async function getBranches(req: Request, res: Response) {
  try {
    const { workspaceId } = req.params;

    if (!Types.ObjectId.isValid(workspaceId)) {
      res.status(HttpStatusCode.BadRequest).send({
        message: "Invalid workspaceId.",
      });
      return;
    }

    const branches = await models.branches.find({
      workspaceId: new Types.ObjectId(workspaceId),
    }).sort({ name: 1 });

    res.status(HttpStatusCode.Ok).send({
      message: "Branches retrieved successfully.",
      branches,
    });
    return;
  } catch (error) {
    console.error("Error in getBranches:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "Error retrieving branches.",
    });
    return;
  }
}

export async function createBranch(req: Request, res: Response) {
  try {
    const { workspaceId } = req.params;
    const { name } = req.body;

    if (!Types.ObjectId.isValid(workspaceId)) {
      res.status(HttpStatusCode.BadRequest).send({
        message: "Invalid workspaceId.",
      });
      return;
    }

    if (!name || name.trim() === "") {
      res.status(HttpStatusCode.BadRequest).send({
        message: "Branch name is required.",
      });
      return;
    }

    const branch = await models.branches.create({
      name,
      workspaceId: new Types.ObjectId(workspaceId),
    });

    res.status(HttpStatusCode.Created).send({
      message: "Branch created successfully.",
      branch,
    });
    return;
  } catch (error) {
    console.error("Error in createBranch:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "Error creating branch.",
    });
    return;
  }
}

export async function updateBranch(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const { name, isActive } = req.body;

    if (!Types.ObjectId.isValid(id)) {
      res.status(HttpStatusCode.BadRequest).send({
        message: "Invalid branch ID.",
      });
      return;
    }

    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (isActive !== undefined) updateData.isActive = isActive;

    const branch = await models.branches.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true }
    );

    if (!branch) {
      res.status(HttpStatusCode.NotFound).send({
        message: "Branch not found.",
      });
      return;
    }

    res.status(HttpStatusCode.Ok).send({
      message: "Branch updated successfully.",
      branch,
    });
    return;
  } catch (error) {
    console.error("Error in updateBranch:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "Error updating branch.",
    });
    return;
  }
}

export async function deleteBranch(req: Request, res: Response) {
  try {
    const { id } = req.params;

    if (!Types.ObjectId.isValid(id)) {
      res.status(HttpStatusCode.BadRequest).send({
        message: "Invalid branch ID.",
      });
      return;
    }

    const branch = await models.branches.findByIdAndDelete(id);

    if (!branch) {
      res.status(HttpStatusCode.NotFound).send({
        message: "Branch not found.",
      });
      return;
    }

    res.status(HttpStatusCode.Ok).send({
      message: "Branch deleted successfully.",
    });
    return;
  } catch (error) {
    console.error("Error in deleteBranch:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "Error deleting branch.",
    });
    return;
  }
}
