import { Types } from "mongoose";
import models from "../models";
import { CustomError } from "../errors/customError.error";
import { WorkspaceService } from "./workspace.service";

const workspaceService = new WorkspaceService();

export interface FinanceWorkspaceImage {
  name: string;
  url: string;
  categoria: string;
  tipo?: string;
}

export interface FinanceWorkspace {
  _id: string;
  name: string;
  isActive: boolean;
  adminId: string | null;
  adminName: string | null;
  adminEmail: string | null;
  adminPhotoUrl: string | null;
  createdAt: Date | null;
  /** Imagen principal para mostrar en finanzas: logo del cliente, o la foto de la página de Meta. */
  imageUrl: string | null;
  /** Logo subido en recursos (categoria "logo"). */
  logoUrl: string | null;
  /** Foto de la página de Facebook conectada. */
  pictureUrl: string | null;
  /** Galería: logos y línea gráfica. */
  images: FinanceWorkspaceImage[];
  pageName: string | null;
  instagramAccountName: string | null;
  tipoNegocio: string | null;
  vertical: string | null;
}

type LeanResource = {
  nombre?: string;
  url?: string;
  tipo?: string;
  categoria?: string;
};

type LeanWorkspace = {
  _id: Types.ObjectId;
  name: string;
  isActive?: boolean;
  createdAt?: Date;
  adminId?:
    | { _id: Types.ObjectId; name?: string; email?: string; photoUrl?: string }
    | Types.ObjectId
    | null;
  metaAds?: { pictureUrl?: string; pageName?: string; instagramAccountName?: string };
  resources?: LeanResource[];
  brandProfile?: { tipoNegocio?: string; vertical?: string; archivos?: LeanResource[] } | null;
};

const FINANCE_PROJECTION = {
  name: 1,
  isActive: 1,
  adminId: 1,
  createdAt: 1,
  "metaAds.pictureUrl": 1,
  "metaAds.pageName": 1,
  "metaAds.instagramAccountName": 1,
  resources: 1,
  "brandProfile.tipoNegocio": 1,
  "brandProfile.vertical": 1,
  "brandProfile.archivos": 1,
} as const;

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|svg|avif)(\?|$)/i;

function isImage(resource: LeanResource): boolean {
  if (!resource.url) return false;
  if (resource.tipo && resource.tipo.startsWith("image/")) return true;
  return IMAGE_EXT.test(resource.url);
}

function collectImages(workspace: LeanWorkspace): FinanceWorkspaceImage[] {
  const pool = [...(workspace.resources ?? []), ...(workspace.brandProfile?.archivos ?? [])];

  return pool
    .filter(isImage)
    .filter((r) => r.categoria !== "otro" || pool.length <= 4)
    .slice(0, 12)
    .map((r) => ({
      name: r.nombre ?? "Recurso",
      url: r.url as string,
      categoria: r.categoria ?? "otro",
      tipo: r.tipo,
    }));
}

function mapWorkspace(workspace: LeanWorkspace): FinanceWorkspace {
  const admin = workspace.adminId && !(workspace.adminId instanceof Types.ObjectId)
    ? (workspace.adminId as {
        _id: Types.ObjectId;
        name?: string;
        email?: string;
        photoUrl?: string;
      })
    : null;

  const adminId = admin
    ? admin._id.toString()
    : workspace.adminId
      ? workspace.adminId.toString()
      : null;

  const images = collectImages(workspace);
  const logoUrl = images.find((i) => i.categoria === "logo")?.url ?? null;
  const pictureUrl = workspace.metaAds?.pictureUrl ?? null;

  return {
    _id: workspace._id.toString(),
    name: workspace.name,
    isActive: workspace.isActive ?? false,
    adminId,
    adminName: admin?.name ?? null,
    adminEmail: admin?.email ?? null,
    adminPhotoUrl: admin?.photoUrl ?? null,
    createdAt: workspace.createdAt ?? null,
    imageUrl: logoUrl ?? pictureUrl ?? images[0]?.url ?? null,
    logoUrl,
    pictureUrl,
    images,
    pageName: workspace.metaAds?.pageName ?? null,
    instagramAccountName: workspace.metaAds?.instagramAccountName ?? null,
    tipoNegocio: workspace.brandProfile?.tipoNegocio ?? null,
    vertical: workspace.brandProfile?.vertical ?? null,
  };
}

/**
 * Nombre reducido a su esencia para comparar: sin mayúsculas, sin tildes y con
 * los espacios colapsados. "CASA MIA" y "CASA MÍA" son el mismo negocio; la
 * tilde bastó para que el alta de finanzas creara un workspace duplicado en
 * producción (13-14 ago 2026, 13 duplicados).
 */
function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Crea el espacio de un cliente recién dado de alta en finanzas.
 *
 * Es idempotente a propósito: si ya existe uno con ese nombre lo devuelve en
 * vez de fallar. El alta de cliente en finanzas no debe romperse porque alguien
 * creara el espacio antes a mano, y devolver el existente es lo que permite
 * vincularlo igual.
 */
export async function createWorkspaceForFinance(name: string): Promise<{
  workspace: FinanceWorkspace;
  created: boolean;
}> {
  const clean = String(name ?? "").trim();
  if (clean.length < 2) {
    throw new CustomError("El nombre del espacio es obligatorio.", 400);
  }

  // La colación no cubre tildes ni espacios internos, así que el match exacto
  // por regex se queda corto. Se comparan todos los nombres normalizados en
  // memoria: son ~130 workspaces, no vale un índice especial.
  const target = normalizeName(clean);
  const candidates = await models.workspaces.find({}, { name: 1 }).lean();
  const match = candidates.find((w) => normalizeName(String(w.name ?? "")) === target);

  const existing = match
    ? await models.workspaces
        .findById(match._id, FINANCE_PROJECTION)
        .populate({ path: "adminId", select: "name email photoUrl" })
        .lean()
    : null;

  if (existing) {
    return { workspace: mapWorkspace(existing as unknown as LeanWorkspace), created: false };
  }

  const created = await workspaceService.createWorkspace({ name: clean });
  const fresh = await models.workspaces
    .findById(created._id, FINANCE_PROJECTION)
    .populate({ path: "adminId", select: "name email photoUrl" })
    .lean();

  return { workspace: mapWorkspace(fresh as unknown as LeanWorkspace), created: true };
}

export async function listWorkspacesForFinance(): Promise<FinanceWorkspace[]> {
  const workspaces = await models.workspaces
    .find({}, FINANCE_PROJECTION)
    .populate({ path: "adminId", select: "name email photoUrl" })
    .sort({ name: 1 })
    .lean();

  return (workspaces as unknown as LeanWorkspace[]).map(mapWorkspace);
}

export async function getWorkspaceForFinance(workspaceId: string): Promise<FinanceWorkspace> {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new CustomError("Identificador de workspace inválido.", 400);
  }

  const workspace = await models.workspaces
    .findById(workspaceId, FINANCE_PROJECTION)
    .populate({ path: "adminId", select: "name email photoUrl" })
    .lean();

  if (!workspace) {
    throw new CustomError("Workspace no encontrado.", 404);
  }

  return mapWorkspace(workspace as unknown as LeanWorkspace);
}

export async function setWorkspaceActiveForFinance(
  workspaceId: string,
  isActive: boolean,
  reason?: string
): Promise<FinanceWorkspace> {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new CustomError("Identificador de workspace inválido.", 400);
  }

  // Desactivar exige motivo. Finanzas lo manda como `reason`; si por lo que sea
  // no llega, se registra uno genérico antes que dejar el corte sin hacer: el
  // cliente moroso tiene que quedar cerrado igual, y el motivo se ve en el log.
  const motivo = (reason ?? "").trim() || "Desactivado desde Finanzas (sin motivo indicado)";

  try {
    await workspaceService.toggleWorkspaceActive(workspaceId, isActive, {
      motivo,
      porNombre: "Finanzas",
    });
  } catch (error: any) {
    if (error?.message === "NOT_FOUND") {
      throw new CustomError("Workspace no encontrado.", 404);
    }
    if (error?.message === "INVALID_ID") {
      throw new CustomError("Identificador de workspace inválido.", 400);
    }
    if (error?.message === "MOTIVO_REQUERIDO") {
      throw new CustomError("Indica por qué se desactiva el entorno (reason).", 400);
    }
    throw error;
  }

  console.log(`[finance] workspace ${workspaceId} -> isActive=${isActive} (${reason ?? "sin motivo"})`);

  return getWorkspaceForFinance(workspaceId);
}
