import { Schema, model, Document, Types } from "mongoose";

// ── Enums ──────────────────────────────────────────────────────────────────
export type EstadoIdea = "APROBADO" | "POR_REVISAR" | "RECHAZADO";
export type EstadoProduccion = "GRABADO" | "POR_GRABAR" | "RECHAZADO";
export type EstadoEdicion = "EDITADO" | "POR_EDITAR" | "RECHAZADO";
export type EstadoPublicacion = "PROGRAMADO" | "PUBLICADO" | "POR_PUBLICAR" | "-";
export type ClienteAprobacion = "PENDIENTE" | "APROBADO" | "RECHAZADO";
export type TipoGuion = "TOFU" | "MOFU" | "BOFU";

// ── GuionIA subdocument ────────────────────────────────────────────────────
export interface IGuionIA {
  conceptoVisual: string;
  gancho: string;
  textoPantalla: string;
  /** Hook 2 aparte, solo cuando se generó con doble hook separado. */
  hook2?: string;
  cuerpo: string;
  /**
   * Cierre por defecto. Se mantiene por los guiones que ya estaban guardados
   * antes de que existieran los dos finales.
   */
  cta: string;
  /** Cierre suave para el feed: comentar, guardar, seguir. */
  ctaFeed?: string;
  /** Cierre duro para pauta: una sola acción comercial. */
  ctaAds?: string;
  broll: string;
  generadoEn?: Date;
  contextoMes?: {
    productoMes?: string;
    ofertaEspecial?: string;
    referenciasAdicionales?: string;
  };
}

// ── ScriptMeta subdocument ─────────────────────────────────────────────────
/** Where the script is meant to run. Feed and ads need different structures. */
export type ObjetivoGuion = "feed" | "anuncio";
export type HookType =
  | "pregunta"
  | "dato"
  | "testimonio"
  | "polemica"
  | "pov"
  | "problema"
  | "oferta";
export type FormatoContenido = "reel" | "carrusel" | "estatico" | "historia";

/**
 * Structural attributes of a script. Without these there is nothing to group
 * performance by — "which kind of script works best" is unanswerable.
 */
export interface IScriptMeta {
  objetivo?: ObjetivoGuion;
  hookType?: HookType;
  formato?: FormatoContenido;
  duracionSeg?: number;
  /** The high-ticket checklist: what the script actually contains. */
  elementos?: {
    testimonio?: boolean;
    autoridad?: boolean;
    oferta?: boolean;
    ctaExplicito?: boolean;
    problemaNecesidad?: boolean;
  };
  clasificadoPor?: "ia" | "humano";
  clasificadoEn?: Date;
}

export interface IVideoItemMetrics {
  views?: number;
  reach?: number;
  impressions?: number;
  likes?: number;
  comments?: number;
  saved?: number;
  shares?: number;
  /** Taps to the profile from this post — organic lead-intent proxy. */
  profileVisits?: number;
  /** Follows attributed to this post — organic lead-intent proxy. */
  follows?: number;
  adSpend?: number;
  /** Real leads from Meta Ads (`actions[action_type=lead]`). */
  adLeads?: number;
  adROAS?: number;
  lastSyncedAt?: Date;
}

// ── VideoItem subdocument ──────────────────────────────────────────────────
export interface IVideoItem {
  _id: Types.ObjectId;
  numero: number;
  tema: string;
  descripcion?: string;
  tipo?: string;
  linkEjemplo?: string;
  recursos?: string;
  lugarGrabacion?: string;
  guion?: string;
  tipoGuion?: TipoGuion;
  scriptMeta?: IScriptMeta;
  guionIA?: IGuionIA;
  casoUsoRef?: number;
  estadoIdea: EstadoIdea;
  estadoProduccion: EstadoProduccion;
  edicion: EstadoEdicion;
  estadoPublicacion: EstadoPublicacion;
  comentario?: string;
  clienteAprobacion: ClienteAprobacion;
  motivoRechazo?: string;
  /** Categoria estructurada del ultimo rechazo, para poder contar motivos. */
  motivoCategoria?: string;
  /**
   * Responsables del item. Sin esto un rechazo no se puede atribuir a nadie:
   * se estampan solos (quien guarda el guion / quien marca EDITADO) y el PM
   * puede corregirlos via PATCH.
   */
  guionPorId?: Types.ObjectId;
  guionPorNombre?: string;
  editorPorId?: Types.ObjectId;
  editorPorNombre?: string;
  linkVideo?: string;
  fechaPublicacion?: Date;
  copyPublicacion?: string;
  order: number;
  // Instagram / Facebook Published Media Linking & Metrics
  igMediaId?: string;
  igPermalink?: string;
  metaAdId?: string;
  metrics?: IVideoItemMetrics;
  // Instagram scheduling
  igContainerId?: string;
  igScheduleStatus?: 'SCHEDULED' | 'FAILED';
  igScheduleError?: string;
  // Facebook scheduling
  fbPostId?: string;
  fbScheduleStatus?: 'SCHEDULED' | 'FAILED';
  fbScheduleError?: string;
}

const GuionIASchema = new Schema(
  {
    conceptoVisual: { type: String, trim: true, default: "" },
    gancho: { type: String, trim: true, default: "" },
    textoPantalla: { type: String, trim: true, default: "" },
    hook2: { type: String, trim: true, default: "" },
    cuerpo: { type: String, trim: true, default: "" },
    cta: { type: String, trim: true, default: "" },
    ctaFeed: { type: String, trim: true, default: "" },
    ctaAds: { type: String, trim: true, default: "" },
    broll: { type: String, trim: true, default: "" },
    generadoEn: { type: Date },
    contextoMes: {
      productoMes: { type: String, trim: true },
      ofertaEspecial: { type: String, trim: true },
      referenciasAdicionales: { type: String, trim: true },
    },
  },
  { _id: false }
);

const ScriptMetaSchema = new Schema(
  {
    objetivo: { type: String, enum: ["feed", "anuncio"] },
    hookType: {
      type: String,
      enum: ["pregunta", "dato", "testimonio", "polemica", "pov", "problema", "oferta"],
    },
    formato: { type: String, enum: ["reel", "carrusel", "estatico", "historia"] },
    duracionSeg: { type: Number },
    elementos: {
      testimonio: { type: Boolean, default: false },
      autoridad: { type: Boolean, default: false },
      oferta: { type: Boolean, default: false },
      ctaExplicito: { type: Boolean, default: false },
      problemaNecesidad: { type: Boolean, default: false },
    },
    clasificadoPor: { type: String, enum: ["ia", "humano"] },
    clasificadoEn: { type: Date },
  },
  { _id: false }
);

const VideoItemSchema = new Schema<IVideoItem>(
  {
    numero: { type: Number, required: true },
    tema: { type: String, required: true, trim: true },
    descripcion: { type: String, trim: true },
    tipo: { type: String, trim: true },
    linkEjemplo: { type: String, trim: true },
    recursos: { type: String, trim: true },
    lugarGrabacion: { type: String, trim: true },
    guion: { type: String },
    tipoGuion: {
      type: String,
      enum: ["TOFU", "MOFU", "BOFU"],
    },
    scriptMeta: { type: ScriptMetaSchema },
    guionIA: { type: GuionIASchema },
    estadoIdea: {
      type: String,
      enum: ["APROBADO", "POR_REVISAR", "RECHAZADO"],
      default: "POR_REVISAR",
    },
    estadoProduccion: {
      type: String,
      enum: ["GRABADO", "POR_GRABAR", "RECHAZADO"],
      default: "POR_GRABAR",
    },
    edicion: {
      type: String,
      enum: ["EDITADO", "POR_EDITAR", "RECHAZADO"],
      default: "POR_EDITAR",
    },
    estadoPublicacion: {
      type: String,
      enum: ["PROGRAMADO", "PUBLICADO", "POR_PUBLICAR", "-"],
      default: "POR_PUBLICAR",
    },
    comentario: { type: String, trim: true },
    clienteAprobacion: {
      type: String,
      enum: ["PENDIENTE", "APROBADO", "RECHAZADO"],
      default: "PENDIENTE",
    },
    motivoRechazo: { type: String, trim: true },
    motivoCategoria: { type: String, trim: true },
    guionPorId: { type: Schema.Types.ObjectId, ref: "User" },
    guionPorNombre: { type: String, trim: true },
    editorPorId: { type: Schema.Types.ObjectId, ref: "User" },
    editorPorNombre: { type: String, trim: true },
    linkVideo: { type: String, trim: true },
    fechaPublicacion: { type: Date },
    copyPublicacion: { type: String, trim: true },
    order: { type: Number, default: 0 },
    casoUsoRef: { type: Number },
    igMediaId: { type: String, trim: true },
    igPermalink: { type: String, trim: true },
    metaAdId: { type: String, trim: true },
    metrics: {
      views: { type: Number, default: 0 },
      reach: { type: Number, default: 0 },
      impressions: { type: Number, default: 0 },
      likes: { type: Number, default: 0 },
      comments: { type: Number, default: 0 },
      saved: { type: Number, default: 0 },
      shares: { type: Number, default: 0 },
      profileVisits: { type: Number, default: 0 },
      follows: { type: Number, default: 0 },
      adSpend: { type: Number, default: 0 },
      adLeads: { type: Number, default: 0 },
      adROAS: { type: Number, default: 0 },
      lastSyncedAt: { type: Date },
    },
    igContainerId: { type: String, trim: true },
    igScheduleStatus: { type: String, enum: ['SCHEDULED', 'FAILED'] },
    igScheduleError: { type: String, trim: true },
    fbPostId: { type: String, trim: true },
    fbScheduleStatus: { type: String, enum: ['SCHEDULED', 'FAILED'] },
    fbScheduleError: { type: String, trim: true },
  },
  { _id: true }
);

// ── VideoPlanning document ─────────────────────────────────────────────────
/** Un intento de aviso al cliente, con su resultado. */
export interface INotificacionPlanning {
  canal: "whatsapp" | "email";
  enviadoEn: Date;
  porNombre?: string;
  exito: boolean;
  error?: string;
  /** Solo email: lo reporta el webhook de Resend, si esta configurado. */
  abiertoEn?: Date;
  clicEn?: Date;
  proveedorId?: string;
}

export interface IVideoPlanning extends Document {
  planningEntryId: Types.ObjectId;
  workspaceId: Types.ObjectId;
  items: IVideoItem[];
  /**
   * Historial de avisos. Se conserva entero aunque se reabra el ciclo: sirve
   * para responder "cuantas veces le escribimos antes de que contestara".
   */
  notificaciones: INotificacionPlanning[];
  /**
   * Mientras este en false no se puede volver a notificar. Se cierra al
   * aprobar o rechazar y se reabre al mandar una planificacion nueva: sin
   * esto el recordatorio seguiria saliendo despues de que el cliente respondio.
   */
  notificacionAbierta: boolean;
  /**
   * Cuando empezo el ciclo actual de avisos. Los avisos anteriores siguen en
   * el historial, asi que sin esta fecha no se puede saber si el que se va a
   * mandar es el primero DE ESTE ciclo o ya es recordatorio.
   */
  cicloIniciadoEn?: Date;
  /** El ciclo actual arranca por una revision, no por un envio nuevo. */
  cicloEsRevision?: boolean;
  /**
   * El equipo de contenido da por lista la planificacion para el cliente.
   * Es la llave del boton "Notificar al cliente": las fechas de publicacion
   * se ponen despues, al editar cada video, asi que "todo con fecha" no
   * sirve como senal de terminado.
   */
  listaParaCliente: boolean;
  listaMarcadaEn?: Date;
  listaMarcadaPor?: Types.ObjectId;
  clienteAprobado: boolean;
  clienteAprobadoAt?: Date;
  clienteAprobadoPor?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const VideoPlanningSchema = new Schema<IVideoPlanning>(
  {
    planningEntryId: {
      type: Schema.Types.ObjectId,
      ref: "Planning",
      required: true,
      unique: true,
    },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    items: { type: [VideoItemSchema], default: [] },
    notificaciones: {
      type: [
        {
          canal: { type: String, enum: ["whatsapp", "email"], required: true },
          enviadoEn: { type: Date, default: Date.now },
          porNombre: { type: String, trim: true },
          exito: { type: Boolean, default: true },
          error: { type: String, trim: true },
          abiertoEn: { type: Date },
          clicEn: { type: Date },
          proveedorId: { type: String, trim: true },
        },
      ],
      default: [],
    },
    notificacionAbierta: {
      type: Boolean,
      default: true,
    },
    cicloIniciadoEn: { type: Date, default: Date.now },
    cicloEsRevision: { type: Boolean, default: false },
    listaParaCliente: { type: Boolean, default: false },
    listaMarcadaEn: { type: Date },
    listaMarcadaPor: { type: Schema.Types.ObjectId, ref: "User" },
    clienteAprobado: { type: Boolean, default: false },
    clienteAprobadoAt: { type: Date },
    clienteAprobadoPor: { type: Schema.Types.ObjectId, ref: "User" },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

VideoPlanningSchema.index({ workspaceId: 1 });
VideoPlanningSchema.index({ workspaceId: 1, "items.fechaPublicacion": 1 });

export const VideoPlanningModel = model<IVideoPlanning>(
  "VideoPlanning",
  VideoPlanningSchema
);
