import type { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { Types } from "mongoose";
import { AuthRequest } from "../types/AuthRequest";
import models from "../models";
import { facturacionPrivadaService } from "../services/facturacionPrivada.service";

function esEquipo(req: AuthRequest): boolean {
  return req.user?.role === "superadmin" || (req.user as any)?.isInternal === true;
}

/** Va después de workspaceAccessMiddleware en todo lo que muestra ventas. */
export async function facturacionVisibleMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = String(req.params.workspaceId || "");
    if (await facturacionPrivadaService.puedeVer(req.user as any, workspaceId)) {
      next();
      return;
    }
    res.status(HttpStatusCode.Forbidden).send({
      message: "La facturación de este entorno es privada: solo la ven las personas que eligió el administrador.",
      codigo: "FACTURACION_PRIVADA",
    });
  } catch (error) {
    next(error);
  }
}

/** Usuarios del cliente en el entorno (los que se pueden elegir). */
async function usuariosDelCliente(workspaceId: string) {
  const ws = new Types.ObjectId(workspaceId);
  const usuarios = await models.users
    .find({
      isActive: true,
      isInternal: { $ne: true },
      role: { $ne: "superadmin" },
      $or: [{ "workspaces.workspaceId": ws }, { workspaceId: ws }],
    })
    .select("name lastName email workspaces workspaceId role")
    .lean();
  return usuarios.map((u: any) => ({
    id: String(u._id),
    nombre: [u.name, u.lastName].filter(Boolean).join(" ") || u.email,
    email: u.email,
    rol: u.workspaces?.find((w: any) => String(w.workspaceId) === workspaceId)?.role ?? (u.role === "admin" ? "admin" : "colaborador"),
  }));
}

/** Quién puede cambiarla: el equipo, o un admin del entorno que la ve. */
async function puedeEditar(req: AuthRequest, workspaceId: string): Promise<boolean> {
  if (esEquipo(req)) return true;
  const user: any = await models.users.findById(req.user?._id).select("workspaces workspaceId role").lean();
  const esAdmin =
    user?.workspaces?.some((w: any) => String(w.workspaceId) === workspaceId && w.role === "admin") ||
    (String(user?.workspaceId) === workspaceId && user?.role === "admin");
  return Boolean(esAdmin) && (await facturacionPrivadaService.puedeVer(req.user as any, workspaceId));
}

export async function getFacturacionPrivada(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = String(req.params.workspaceId);
    const [cfg, puedoVer, editar] = await Promise.all([
      facturacionPrivadaService.config(workspaceId),
      facturacionPrivadaService.puedeVer(req.user as any, workspaceId),
      puedeEditar(req, workspaceId),
    ]);
    const usuarios = editar ? await usuariosDelCliente(workspaceId) : [];
    res.status(HttpStatusCode.Ok).send({
      activa: cfg.activa,
      puedoVer,
      puedoEditar: editar,
      ...(editar ? { visiblePara: cfg.visiblePara, usuarios } : {}),
    });
  } catch (error) {
    next(error);
  }
}

export async function putFacturacionPrivada(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = String(req.params.workspaceId);
    if (!(await puedeEditar(req, workspaceId))) {
      res.status(HttpStatusCode.Forbidden).send({ message: "Solo un administrador que ve la facturación puede cambiar quién la ve." });
      return;
    }
    const activa = req.body?.activa === true;
    const pedidos: string[] = Array.isArray(req.body?.visiblePara) ? req.body.visiblePara.map(String) : [];
    const validos = new Set((await usuariosDelCliente(workspaceId)).map((u) => u.id));
    const visiblePara = new Set(pedidos.filter((id) => validos.has(id)));
    // Quien la vuelve privada desde el cliente no se puede dejar afuera a sí mismo.
    if (activa && !esEquipo(req) && req.user?._id) visiblePara.add(String(req.user._id));
    if (activa && !visiblePara.size) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Elige al menos una persona del cliente que pueda ver la facturación." });
      return;
    }
    const quien: any = await models.users.findById(req.user?._id).select("name lastName email").lean();
    await models.workspaces.updateOne(
      { _id: workspaceId },
      {
        $set: {
          facturacionPrivada: {
            activa,
            visiblePara: [...visiblePara].map((id) => new Types.ObjectId(id)),
            porNombre: [quien?.name, quien?.lastName].filter(Boolean).join(" ") || quien?.email,
            en: new Date(),
          },
        },
      }
    );
    res.status(HttpStatusCode.Ok).send({ activa, visiblePara: [...visiblePara] });
  } catch (error) {
    next(error);
  }
}
