/**
 * agency-report.ts
 * Reporte profesional — Bakano Ads Agency
 * Modelo de negocio: cierre por WhatsApp (no e-commerce)
 * KPI principal: Conversaciones iniciadas + Costo por Conversación
 * Cruza: Meta Ads (tiempo real) + Facturación Diaria (MongoDB)
 * Período: Feb 1 – Abr 9, 2026
 *
 * Uso: npx ts-node scripts/agency-report.ts
 */

import "dotenv/config";
import mongoose from "mongoose";
import axios from "axios";
import fs from "fs";
import path from "path";

// ─── Constantes ────────────────────────────────────────────────────────────────
const GRAPH_URL   = "https://graph.facebook.com/v22.0";
const TIME_RANGE  = { since: "2026-02-01", until: "2026-04-09" };
const REPORT_PATH = path.join(__dirname, "../AGENCY_REPORT.md");

// Umbrales de costo por conversación saludables (en USD)
// Ajustar según vertical del cliente
const CPL_THRESHOLDS = { excellent: 3, good: 7, warning: 15 };

// Action types que representan conversiones reales para negocios WhatsApp
const CONV_ACTIONS = [
  "onsite_conversion.messaging_conversation_started_7d",
  "onsite_conversion.total_messaging_connection",
  "onsite_conversion.messaging_first_reply",
  "messaging_conversation_started_7d",
  "lead",
  "contact",
  "omni_initiated_checkout",
];

// ─── Tipos ─────────────────────────────────────────────────────────────────────
interface WorkspaceDoc {
  _id: mongoose.Types.ObjectId;
  name: string;
  isActive: boolean;
  metaAds?: {
    accessToken: string;
    pageAccessToken?: string;
    pageId?: string;
    pageName?: string;
    adAccountId?: string;
    adAccountName?: string;
    lastSyncedAt?: Date;
  };
  brandProfile?: {
    tipoNegocio?: string;
    vertical?: string;
    trafficDirection?: string;
  };
  createdAt: Date;
}

interface BillingEntry {
  workspaceId: mongoose.Types.ObjectId;
  date: Date;
  amount: number;
  metaSpend: number;
  roas: number;
  userName: string;
  notes?: string;
}

interface BillingSummary {
  totalRevenue: number;
  totalMetaSpendRecorded: number;
  diasReportados: number;
  entries: BillingEntry[];
  byMonth: Record<string, { revenue: number; spend: number; days: number }>;
}

interface ActionValue { action_type: string; value: string; }

interface AdInsightRow {
  ad_id: string;
  ad_name: string;
  campaign_name: string;
  adset_name?: string;
  spend: string;
  impressions: string;
  clicks: string;
  cpc?: string;
  cpm?: string;
  reach?: string;
  frequency?: string;
  actions?: ActionValue[];
  action_values?: ActionValue[];
  cost_per_action_type?: ActionValue[];
  effective_status: string;
}

interface DailyRow {
  date_start: string;
  spend: string;
  clicks: string;
  impressions: string;
  actions?: ActionValue[];
}

interface PlatformRow { publisher_platform: string; spend: string; }

interface ConvBreakdown {
  messaging: number;
  leads: number;
  contacts: number;
  checkouts: number;
  total: number;
  primaryType: string; // which type dominates
}

interface MetaSummary {
  totalSpend: number;
  totalImpressions: number;
  totalClicks: number;
  totalReach: number;
  avgFrequency: number;
  convBreakdown: ConvBreakdown;
  totalConversions: number;
  costPerConversion: number;
  avgCpc: number;
  avgCpm: number;
  ctr: number;
  activeAds: number;
  pausedAds: number;
  campaigns: string[];
  // e-commerce (secondary, most clients won't have this)
  purchases: number;
  purchaseValue: number;
  roasPixel: number;
}

interface ClientResult {
  workspace: WorkspaceDoc;
  metaStatus: "ok" | "error" | "no_token" | "no_account";
  metaError?: string;
  insights?: AdInsightRow[];
  dailySpend?: DailyRow[];
  platformBreakdown?: PlatformRow[];
  metaSummary?: MetaSummary;
  billing?: BillingSummary;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
const n   = (v: string | number | undefined) => parseFloat(String(v ?? "0")) || 0;
const fmt = (v: number, d = 2) => v.toFixed(d);

function fmtUSD(v: number): string {
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtK(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(0);
}

function getAction(actions: ActionValue[] | undefined, type: string) {
  return n(actions?.find(a => a.action_type === type)?.value);
}

function getTotalConversions(actions: ActionValue[] | undefined): ConvBreakdown {
  const messaging = CONV_ACTIONS.slice(0, 4).reduce((s, t) => s + getAction(actions, t), 0);
  const leads     = getAction(actions, "lead");
  const contacts  = getAction(actions, "contact");
  const checkouts = getAction(actions, "omni_initiated_checkout");

  // De-duplicate: messaging is the most specific, leads/contacts may overlap
  // Use messaging first; if 0, fall back to leads/contacts
  const total = messaging > 0 ? messaging
    : leads > 0 ? leads
    : contacts > 0 ? contacts
    : checkouts;

  const primaryType = messaging > 0 ? "Conversaciones WhatsApp/Messenger"
    : leads > 0 ? "Leads"
    : contacts > 0 ? "Contactos"
    : checkouts > 0 ? "Checkouts iniciados"
    : "Sin conversiones registradas";

  return { messaging, leads, contacts, checkouts, total, primaryType };
}

function cplIcon(cpl: number, hasConv: boolean): string {
  if (!hasConv || cpl === 0) return "⚪";
  if (cpl <= CPL_THRESHOLDS.excellent) return "🟢";
  if (cpl <= CPL_THRESHOLDS.good)      return "🟡";
  if (cpl <= CPL_THRESHOLDS.warning)   return "🟠";
  return "🔴";
}

function cplLabel(cpl: number, hasConv: boolean): string {
  if (!hasConv || cpl === 0) return "Sin conversiones";
  if (cpl <= CPL_THRESHOLDS.excellent) return "Excelente";
  if (cpl <= CPL_THRESHOLDS.good)      return "Bueno";
  if (cpl <= CPL_THRESHOLDS.warning)   return "Mejorable";
  return "Caro — optimizar";
}

function monthKey(date: Date): string {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── Meta API ──────────────────────────────────────────────────────────────────
async function fetchInsights(adAccountId: string, token: string) {
  const tr = JSON.stringify(TIME_RANGE);

  const [aggRes, dailyRes, adsRes] = await Promise.all([
    axios.get(`${GRAPH_URL}/act_${adAccountId}/insights`, {
      params: {
        access_token: token,
        level: "ad",
        fields: [
          "ad_id", "ad_name", "adset_name", "campaign_name",
          "spend", "impressions", "clicks", "cpc", "cpm", "reach", "frequency",
          "actions", "action_values", "cost_per_action_type", "purchase_roas",
        ].join(","),
        time_range: tr,
        limit: 500,
      },
    }),
    axios.get(`${GRAPH_URL}/act_${adAccountId}/insights`, {
      params: {
        access_token: token,
        level: "account",
        fields: "spend,clicks,impressions,actions,date_start",
        time_range: tr,
        time_increment: 1,
        limit: 500,
      },
    }),
    axios.get(`${GRAPH_URL}/act_${adAccountId}/ads`, {
      params: { access_token: token, fields: "id,effective_status", limit: 500 },
    }).catch(() => ({ data: { data: [] } })),
  ]);

  const statusMap: Record<string, string> = {};
  for (const ad of adsRes.data.data || []) statusMap[ad.id] = ad.effective_status;

  const insights: AdInsightRow[] = (aggRes.data.data || []).map((row: any) => ({
    ...row,
    effective_status: statusMap[row.ad_id] ?? "UNKNOWN",
  }));

  return { insights, dailySpend: dailyRes.data.data || [] as DailyRow[] };
}

async function fetchPlatformBreakdown(adAccountId: string, token: string): Promise<PlatformRow[]> {
  try {
    const res = await axios.get(`${GRAPH_URL}/act_${adAccountId}/insights`, {
      params: {
        access_token: token, level: "account", fields: "spend",
        breakdowns: "publisher_platform", time_range: JSON.stringify(TIME_RANGE),
      },
    });
    return res.data.data || [];
  } catch { return []; }
}

function buildMetaSummary(insights: AdInsightRow[]): MetaSummary {
  let totalSpend = 0, totalImpressions = 0, totalClicks = 0, totalReach = 0;
  let totalFreqWeighted = 0, totalConvs = 0;
  let purchases = 0, purchaseValue = 0, weightedRoasPixel = 0;
  let activeAds = 0, pausedAds = 0;
  const campaignSet = new Set<string>();

  // Aggregate per campaign to avoid double-counting conversations
  const campaignConvMap = new Map<string, number>();

  for (const row of insights) {
    const spend = n(row.spend);
    totalSpend       += spend;
    totalImpressions += n(row.impressions);
    totalClicks      += n(row.clicks);
    totalReach       += n(row.reach);
    totalFreqWeighted += n(row.frequency) * spend;

    // Conversions: aggregate at campaign level to avoid double-counting per ad
    const conv = getTotalConversions(row.actions);
    const prev = campaignConvMap.get(row.campaign_name) || 0;
    campaignConvMap.set(row.campaign_name, Math.max(prev, conv.total));

    // E-commerce pixel (secondary)
    purchases    += getAction(row.actions, "purchase") + getAction(row.actions, "offsite_conversion.fb_pixel_purchase");
    purchaseValue += getAction(row.action_values, "purchase") + getAction(row.action_values, "offsite_conversion.fb_pixel_purchase");
    if (row.purchase_roas?.length) weightedRoasPixel += n(row.purchase_roas[0]?.value) * spend;

    if (row.effective_status === "ACTIVE") activeAds++;
    else if (["PAUSED","CAMPAIGN_PAUSED","ADSET_PAUSED"].includes(row.effective_status)) pausedAds++;
    if (row.campaign_name) campaignSet.add(row.campaign_name);
  }

  // Sum campaign-level conversations (less double-counting)
  for (const v of campaignConvMap.values()) totalConvs += v;

  // Fallback: if campaign aggregation gives 0, sum directly from rows
  if (totalConvs === 0) {
    for (const row of insights) {
      totalConvs += getTotalConversions(row.actions).total;
    }
  }

  const roasPixel = purchaseValue > 0 && totalSpend > 0 ? purchaseValue / totalSpend
    : totalSpend > 0 ? weightedRoasPixel / totalSpend : 0;

  return {
    totalSpend, totalImpressions, totalClicks, totalReach,
    avgFrequency: totalSpend > 0 ? totalFreqWeighted / totalSpend : 0,
    convBreakdown: getTotalConversions(
      insights.flatMap(r => r.actions || []).reduce((acc: ActionValue[], a) => {
        const ex = acc.find(x => x.action_type === a.action_type);
        if (ex) ex.value = String(n(ex.value) + n(a.value));
        else acc.push({ ...a });
        return acc;
      }, [])
    ),
    totalConversions: totalConvs,
    costPerConversion: totalConvs > 0 ? totalSpend / totalConvs : 0,
    avgCpc: totalClicks > 0 ? totalSpend / totalClicks : 0,
    avgCpm: totalImpressions > 0 ? (totalSpend / totalImpressions) * 1000 : 0,
    ctr: totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0,
    activeAds, pausedAds,
    campaigns: Array.from(campaignSet),
    purchases, purchaseValue, roasPixel,
  };
}

// ─── Billing ───────────────────────────────────────────────────────────────────
async function getAllBilling(db: mongoose.mongo.Db): Promise<Map<string, BillingSummary>> {
  const entries = await db.collection("dailybillingentries").find({
    date: { $gte: new Date("2026-02-01T00:00:00Z"), $lt: new Date("2026-04-10T00:00:00Z") },
  }).toArray() as unknown as BillingEntry[];

  const map = new Map<string, BillingSummary>();
  for (const e of entries) {
    const key = e.workspaceId.toString();
    if (!map.has(key)) map.set(key, { totalRevenue: 0, totalMetaSpendRecorded: 0, diasReportados: 0, entries: [], byMonth: {} });
    const s = map.get(key)!;
    s.totalRevenue += e.amount;
    s.totalMetaSpendRecorded += e.metaSpend;
    s.diasReportados++;
    s.entries.push(e);
    const mk = monthKey(new Date(e.date));
    if (!s.byMonth[mk]) s.byMonth[mk] = { revenue: 0, spend: 0, days: 0 };
    s.byMonth[mk].revenue += e.amount;
    s.byMonth[mk].spend   += e.metaSpend;
    s.byMonth[mk].days++;
  }
  return map;
}

// ─── Markdown builders ─────────────────────────────────────────────────────────
function execSummary(results: ClientResult[]): string {
  const ok          = results.filter(r => r.metaStatus === "ok" && r.metaSummary);
  const withConvs   = ok.filter(r => r.metaSummary!.totalConversions > 0);
  const withBilling = results.filter(r => r.billing && r.billing.diasReportados > 0);

  const totalSpend    = ok.reduce((s, r) => s + r.metaSummary!.totalSpend, 0);
  const totalConvs    = ok.reduce((s, r) => s + r.metaSummary!.totalConversions, 0);
  const totalRevenue  = withBilling.reduce((s, r) => s + (r.billing?.totalRevenue || 0), 0);
  const avgCPL        = totalConvs > 0 ? totalSpend / totalConvs : 0;
  const revenuePerConv = totalConvs > 0 && totalRevenue > 0 ? totalRevenue / totalConvs : 0;

  let md = `## 📊 Resumen Ejecutivo\n\n`;
  md += `> **Nota metodológica:** Estos clientes cierran ventas por WhatsApp. `;
  md += `El KPI principal es **Conversaciones iniciadas** y **Costo por Conversación (CPL)**. `;
  md += `Meta no puede trackear el cierre final (ese ocurre en WhatsApp), pero sí mide cuántas personas inician contacto.\n\n`;

  md += `| Métrica | Valor |\n|---|---|\n`;
  md += `| Total clientes con Meta Ads | **${results.length}** |\n`;
  md += `| Con datos en tiempo real | **${ok.length}** |\n`;
  md += `| Con conversaciones registradas en Meta | **${withConvs.length}** |\n`;
  md += `| Con facturación diaria ingresada | **${withBilling.length}** |\n`;
  md += `| 💰 Gasto total Meta (Feb–Abr) | **${fmtUSD(totalSpend)}** |\n`;
  md += `| 💬 Total conversaciones generadas | **${fmtK(totalConvs)}** |\n`;
  md += `| 📩 CPL promedio agencia | **${fmtUSD(avgCPL)}** |\n`;
  md += `| 🏦 Facturación total reportada | **${fmtUSD(totalRevenue)}** |\n`;
  if (revenuePerConv > 0) {
    md += `| 💵 Ingreso por conversación (aprox.) | **${fmtUSD(revenuePerConv)}** |\n`;
  }
  md += `\n`;

  return md;
}

function masterTable(results: ClientResult[]): string {
  const sorted = [...results].sort((a, b) => {
    if (a.metaStatus !== "ok" && b.metaStatus === "ok") return 1;
    if (a.metaStatus === "ok" && b.metaStatus !== "ok") return -1;
    return (b.metaSummary?.totalSpend || 0) - (a.metaSummary?.totalSpend || 0);
  });

  let md = `## 📋 Tabla Maestra — Vista Rápida\n\n`;
  md += `| # | Cliente | Gasto | Conversaciones | CPL | Facturación | Días Bill. | Ads Act. | Estado |\n`;
  md += `|---|---------|-------|---------------|-----|------------|-----------|---------|--------|\n`;

  sorted.forEach((r, i) => {
    if (r.metaStatus !== "ok" || !r.metaSummary) {
      const errLabel = r.metaStatus === "error" ? "❌ Token inválido" : "⚠️ Sin cuenta";
      const rev = r.billing ? fmtUSD(r.billing.totalRevenue) : "—";
      const dias = r.billing?.diasReportados || 0;
      md += `| ${i + 1} | ${r.workspace.name} | — | — | — | ${rev} | ${dias > 0 ? `${dias}d` : "—"} | — | ${errLabel} |\n`;
      return;
    }

    const ms   = r.metaSummary;
    const bil  = r.billing;
    const icon = cplIcon(ms.costPerConversion, ms.totalConversions > 0);
    const lbl  = cplLabel(ms.costPerConversion, ms.totalConversions > 0);
    const rev  = bil && bil.totalRevenue > 0 ? fmtUSD(bil.totalRevenue) : "Sin datos";
    const dias = bil?.diasReportados || 0;
    const cpl  = ms.costPerConversion > 0 ? fmtUSD(ms.costPerConversion) : "—";
    const convs = ms.totalConversions > 0 ? ms.totalConversions.toFixed(0) : "0 ⚠️";

    md += `| ${i + 1} | ${r.workspace.name} | ${fmtUSD(ms.totalSpend)} | ${convs} | ${cpl} | ${rev} | ${dias > 0 ? `${dias}d` : "—"} | ${ms.activeAds} | ${icon} ${lbl} |\n`;
  });

  md += `\n`;
  return md;
}

function clientDetail(r: ClientResult, idx: number): string {
  const ws  = r.workspace;
  const ms  = r.metaSummary;
  const bil = r.billing;

  let md = `---\n\n## ${idx}. ${ws.name}\n\n`;
  md += `> **Cuenta:** ${ws.metaAds?.adAccountName || ws.metaAds?.adAccountId || "—"}`;
  md += ` | **Página:** ${ws.metaAds?.pageName || "—"}`;
  if (ws.brandProfile?.vertical) md += ` | **Vertical:** ${ws.brandProfile.vertical}`;
  if (ws.brandProfile?.trafficDirection) md += ` | **Tráfico:** ${ws.brandProfile.trafficDirection}`;
  md += `\n\n`;

  if (r.metaStatus !== "ok" || !ms) {
    md += `### ❌ Error de conexión Meta Ads\n\n`;
    const safe = (r.metaError || "").replace(/(EAAa?[A-Za-z0-9]+)/g, "[TOKEN]");
    md += `**Causa:** ${safe.substring(0, 250)}\n\n`;
    md += `**Acción requerida:** El cliente debe reconectar su cuenta Meta desde la plataforma.\n\n`;
    if (bil && bil.diasReportados > 0) {
      md += billingBlock(bil);
    }
    return md;
  }

  // ── Calificación
  const icon = cplIcon(ms.costPerConversion, ms.totalConversions > 0);
  const lbl  = cplLabel(ms.costPerConversion, ms.totalConversions > 0);
  const revenuePerConv = bil && bil.totalRevenue > 0 && ms.totalConversions > 0
    ? bil.totalRevenue / ms.totalConversions : 0;

  md += `### ${icon} Calificación: **${lbl}**`;
  if (ms.costPerConversion > 0) md += ` — CPL: ${fmtUSD(ms.costPerConversion)}`;
  md += `\n\n`;

  // ── KPIs principales
  md += `#### 🔢 KPIs Principales\n\n`;
  md += `| KPI | Valor |\n|---|---|\n`;
  md += `| 💰 Gasto Meta | **${fmtUSD(ms.totalSpend)}** |\n`;
  md += `| 💬 Conversaciones iniciadas | **${ms.totalConversions > 0 ? ms.totalConversions.toFixed(0) : "0 — revisar configuración"}** |\n`;
  if (ms.totalConversions > 0) {
    md += `| 📩 Costo por conversación (CPL) | **${fmtUSD(ms.costPerConversion)}** |\n`;
    md += `| 🎯 Tipo de conversión principal | **${ms.convBreakdown.primaryType}** |\n`;
  }
  if (bil && bil.totalRevenue > 0) {
    md += `| 🏦 Facturación registrada | **${fmtUSD(bil.totalRevenue)}** |\n`;
    if (revenuePerConv > 0) {
      md += `| 💵 Ingreso por conversación | **${fmtUSD(revenuePerConv)}** |\n`;
    }
  }
  md += `| 👁️ Impresiones | **${fmtK(ms.totalImpressions)}** |\n`;
  md += `| 🖱️ Clicks al link | **${fmtK(ms.totalClicks)}** |\n`;
  md += `| 📊 CTR | **${fmt(ms.ctr)}%** |\n`;
  md += `| 💲 CPC (clic) | **${fmtUSD(ms.avgCpc)}** |\n`;
  md += `| 📡 CPM | **${fmtUSD(ms.avgCpm)}** |\n`;
  md += `| 🔁 Frecuencia promedio | **${fmt(ms.avgFrequency)}x** |\n`;
  md += `| 👥 Alcance | **${fmtK(ms.totalReach)}** |\n`;
  md += `| 🟢 Ads activos | **${ms.activeAds}** |\n`;
  md += `| ⏸️ Ads pausados | **${ms.pausedAds}** |\n`;
  if (bil) {
    md += `| 📅 Días billing registrados | **${bil.diasReportados}** |\n`;
  }
  md += `\n`;

  // ── Desglose conversiones
  if (ms.convBreakdown.messaging > 0 || ms.convBreakdown.leads > 0) {
    md += `#### 💬 Desglose de Conversiones\n\n`;
    md += `| Tipo | Cantidad |\n|---|---|\n`;
    if (ms.convBreakdown.messaging > 0) md += `| WhatsApp / Messenger (7d) | **${ms.convBreakdown.messaging.toFixed(0)}** |\n`;
    if (ms.convBreakdown.leads > 0)     md += `| Leads (formulario) | **${ms.convBreakdown.leads.toFixed(0)}** |\n`;
    if (ms.convBreakdown.contacts > 0)  md += `| Contactos | **${ms.convBreakdown.contacts.toFixed(0)}** |\n`;
    if (ms.convBreakdown.checkouts > 0) md += `| Checkouts iniciados | **${ms.convBreakdown.checkouts.toFixed(0)}** |\n`;
    md += `\n`;
  }

  // ── Facturación
  if (bil && bil.diasReportados > 0) {
    md += billingBlock(bil);
  } else {
    md += `> ⚠️ **Sin facturación diaria registrada** en el período. Solicitar al cliente que ingrese sus datos de venta para calcular el valor real por conversación.\n\n`;
  }

  // ── Plataformas
  if (r.platformBreakdown && r.platformBreakdown.length > 0) {
    md += `#### 📱 Distribución por Plataforma\n\n`;
    md += `| Plataforma | Gasto |\n|---|---|\n`;
    for (const p of r.platformBreakdown) {
      const name = p.publisher_platform === "facebook" ? "Facebook"
        : p.publisher_platform === "instagram" ? "Instagram"
        : p.publisher_platform === "audience_network" ? "Audience Network"
        : p.publisher_platform;
      md += `| ${name} | ${fmtUSD(n(p.spend))} |\n`;
    }
    md += `\n`;
  }

  // ── Campañas
  if (ms.campaigns.length > 0 && r.insights) {
    const campMap = new Map<string, { spend: number; impressions: number; clicks: number; convs: number; ads: number }>();
    for (const row of r.insights) {
      const cur = campMap.get(row.campaign_name) || { spend: 0, impressions: 0, clicks: 0, convs: 0, ads: 0 };
      campMap.set(row.campaign_name, {
        spend:       cur.spend + n(row.spend),
        impressions: cur.impressions + n(row.impressions),
        clicks:      cur.clicks + n(row.clicks),
        convs:       cur.convs + getTotalConversions(row.actions).total,
        ads:         cur.ads + 1,
      });
    }

    md += `#### 🎯 Campañas\n\n`;
    md += `| Campaña | Gasto | Conversaciones | CPL | CTR | Ads |\n`;
    md += `|---------|-------|---------------|-----|-----|-----|\n`;
    for (const [name, d] of campMap) {
      const cpl  = d.convs > 0 ? fmtUSD(d.spend / d.convs) : "—";
      const ctr  = d.impressions > 0 ? `${((d.clicks / d.impressions) * 100).toFixed(1)}%` : "—";
      const convLabel = d.convs > 0 ? d.convs.toFixed(0) : "0";
      md += `| ${name.substring(0, 48)} | ${fmtUSD(d.spend)} | ${convLabel} | ${cpl} | ${ctr} | ${d.ads} |\n`;
    }
    md += `\n`;
  }

  // ── Gasto diario Meta (últimos 14 días)
  if (r.dailySpend && r.dailySpend.length > 0) {
    md += `#### 📅 Gasto Diario Meta (últimos 14 días)\n\n`;
    md += `| Fecha | Gasto | Clicks | Conv. diarias |\n|-------|-------|--------|---------------|\n`;
    for (const day of r.dailySpend.slice(-14)) {
      const dayConvs = getTotalConversions(day.actions).total;
      md += `| ${day.date_start} | ${fmtUSD(n(day.spend))} | ${n(day.clicks).toFixed(0)} | ${dayConvs > 0 ? dayConvs.toFixed(0) : "—"} |\n`;
    }
    md += `\n`;
  }

  // ── Plan de acción
  md += actionPlan(ms, bil, r.workspace);

  return md;
}

function billingBlock(bil: BillingSummary): string {
  let md = `#### 🏦 Facturación por Mes\n\n`;
  md += `| Mes | Facturación | Gasto Meta (registrado) | Días |\n`;
  md += `|-----|------------|------------------------|------|\n`;

  for (const mk of Object.keys(bil.byMonth).sort()) {
    const m = bil.byMonth[mk];
    const [y, mo] = mk.split("-");
    const mName = new Date(parseInt(y), parseInt(mo) - 1, 1)
      .toLocaleString("es-EC", { month: "long", year: "numeric" });
    md += `| ${mName} | ${fmtUSD(m.revenue)} | ${fmtUSD(m.spend)} | ${m.days} |\n`;
  }
  md += `| **TOTAL** | **${fmtUSD(bil.totalRevenue)}** | **${fmtUSD(bil.totalMetaSpendRecorded)}** | **${bil.diasReportados}** |\n\n`;

  const recent = [...bil.entries]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 5);
  if (recent.length > 0) {
    md += `**Últimas entradas registradas:**\n\n`;
    md += `| Fecha | Facturación | Gasto Meta | Ingresado por |\n`;
    md += `|-------|------------|------------|---------------|\n`;
    for (const e of recent) {
      md += `| ${new Date(e.date).toLocaleDateString("es-EC")} | ${fmtUSD(e.amount)} | ${fmtUSD(e.metaSpend)} | ${e.userName} |\n`;
    }
    md += `\n`;
  }
  return md;
}

function actionPlan(ms: MetaSummary, bil: BillingSummary | undefined, ws: WorkspaceDoc): string {
  const actions: string[] = [];
  const spend = ms.totalSpend;
  const convs = ms.totalConversions;
  const cpl   = ms.costPerConversion;

  if (spend === 0) {
    actions.push("⚪ **Sin gasto en el período.** Verificar si las campañas están activas. Si el cliente hizo pausa, coordinar reactivación.");
  } else if (convs === 0) {
    actions.push("🚨 **CRÍTICO: 0 conversaciones registradas en Meta** — esto NO significa que las campañas van mal.");
    actions.push("   El problema es de **configuración de tracking**, no de performance:");
    actions.push("   1. Verificar que el botón de WhatsApp esté configurado como evento de conversión en Meta Ads Manager.");
    actions.push("   2. En el Ad Set → Optimización, asegurarse de seleccionar **\"Mensajes iniciados\"** o **\"Conversaciones\"** como objetivo.");
    actions.push("   3. Instalar el **Pixel de Meta** con el evento `Contact` o usar la API de Conversiones (CAPI) para reportar cierres.");
    actions.push("   4. Mientras tanto, usar la facturación diaria como fuente de verdad del rendimiento real.");
  } else {
    if (cpl <= CPL_THRESHOLDS.excellent) {
      actions.push(`✅ **CPL excelente** (${fmtUSD(cpl)} por conversación). Escalar presupuesto en los ads con mejor CPL.`);
    } else if (cpl <= CPL_THRESHOLDS.good) {
      actions.push(`🟡 **CPL bueno** (${fmtUSD(cpl)}). Buscar el 20% de ads con mejor CPL y darles más presupuesto.`);
    } else if (cpl <= CPL_THRESHOLDS.warning) {
      actions.push(`🟠 **CPL alto** (${fmtUSD(cpl)}). Revisar creativos y segmentación. Pausar ads con CPL > ${fmtUSD(CPL_THRESHOLDS.warning)}.`);
    } else {
      actions.push(`🔴 **CPL crítico** (${fmtUSD(cpl)}). Cada conversación cuesta demasiado. Rediseñar campaña urgente.`);
    }
  }

  if (ms.avgFrequency > 3 && spend > 50) {
    actions.push(`🔄 **Frecuencia alta** (${fmt(ms.avgFrequency)}x) — la misma audiencia ve los anuncios demasiadas veces. Ampliar audiencia o rotar creativos.`);
  }

  if (ms.ctr < 0.8 && spend > 50) {
    actions.push(`📉 **CTR bajo** (${fmt(ms.ctr)}%) — los anuncios no captan atención. Probar nuevos formatos: video corto, testimonios, oferta directa.`);
  }

  if (ms.activeAds === 0 && spend > 0) {
    actions.push(`⚠️ **Sin ads activos actualmente** pero hubo gasto en el período. Verificar si hay campañas pausadas o en revisión.`);
  }

  if (bil && bil.diasReportados < 15 && spend > 100) {
    actions.push(`📝 **Solo ${bil.diasReportados} días de facturación registrados** (de ~68 días del período). Insistir al cliente para registrar diariamente — es el único dato real de cierre que tenemos.`);
  }

  if (!bil || bil.diasReportados === 0) {
    actions.push(`📊 **Sin facturación registrada.** Implementar rutina semanal de ingreso de datos con el cliente para poder medir el valor real generado.`);
  }

  let md = `#### 💡 Plan de Acción\n\n`;
  for (const a of actions) {
    md += a.startsWith("   ") ? `  ${a.trimStart()}\n` : `- ${a}\n`;
  }
  md += `\n`;
  return md;
}

// ─── DB ────────────────────────────────────────────────────────────────────────
async function getWorkspaces(db: mongoose.mongo.Db): Promise<WorkspaceDoc[]> {
  return db.collection("workspaces").find(
    { "metaAds.adAccountId": { $exists: true, $ne: null, $ne: "" } },
    {
      projection: {
        name: 1, isActive: 1, metaAds: 1,
        "brandProfile.vertical": 1, "brandProfile.tipoNegocio": 1,
        "brandProfile.trafficDirection": 1,
        createdAt: 1,
      }
    }
  ).toArray() as unknown as WorkspaceDoc[];
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.DB_URI) { console.error("❌ DB_URI no definida"); process.exit(1); }

  console.log("🔌 Conectando a MongoDB...");
  await mongoose.connect(process.env.DB_URI);
  const db = mongoose.connection.db!;
  console.log("✅ Conectado.\n");

  console.log("🔍 Cargando workspaces + facturación...");
  const [workspaces, billingMap] = await Promise.all([
    getWorkspaces(db),
    getAllBilling(db),
  ]);
  console.log(`📦 ${workspaces.length} workspaces con Meta Ads | 🏦 ${billingMap.size} con facturación\n`);

  const results: ClientResult[] = [];

  for (let i = 0; i < workspaces.length; i++) {
    const ws      = workspaces[i];
    const label   = `[${i + 1}/${workspaces.length}] ${ws.name}`;
    const billing = billingMap.get(ws._id.toString());

    if (!ws.metaAds?.accessToken) {
      console.log(`⚠️  ${label} — Sin token`);
      results.push({ workspace: ws, metaStatus: "no_token", billing });
      continue;
    }
    if (!ws.metaAds?.adAccountId) {
      console.log(`⚠️  ${label} — Sin adAccountId`);
      results.push({ workspace: ws, metaStatus: "no_account", billing });
      continue;
    }

    console.log(`📡 ${label}`);
    try {
      const adAccountId = ws.metaAds.adAccountId.replace(/^act_/, "");
      const token       = ws.metaAds.accessToken;

      const [{ insights, dailySpend }, platformBreakdown] = await Promise.all([
        fetchInsights(adAccountId, token),
        fetchPlatformBreakdown(adAccountId, token),
      ]);

      const metaSummary = buildMetaSummary(insights);
      console.log(`   ✅ Gasto: ${fmtUSD(metaSummary.totalSpend)} | Convs: ${metaSummary.totalConversions.toFixed(0)} | CPL: ${metaSummary.costPerConversion > 0 ? fmtUSD(metaSummary.costPerConversion) : "—"} | Billing: ${billing ? `${fmtUSD(billing.totalRevenue)} (${billing.diasReportados}d)` : "sin datos"}`);

      results.push({ workspace: ws, metaStatus: "ok", insights, dailySpend, platformBreakdown, metaSummary, billing });
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || err.message || String(err);
      console.log(`   ❌ ${msg.substring(0, 80)}`);
      results.push({ workspace: ws, metaStatus: "error", metaError: msg, billing });
    }

    if (i < workspaces.length - 1) await sleep(200);
  }

  // ── Build report
  console.log("\n📝 Generando reporte...");

  const now = new Date().toLocaleString("es-EC", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: "America/Guayaquil",
  });

  let report = `# 🏢 Reporte Agencia Bakano Ads\n`;
  report += `## Modelo WhatsApp: Meta Ads × Conversaciones × Facturación\n\n`;
  report += `> **Período:** 1 Febrero 2026 → 9 Abril 2026\n`;
  report += `> **Generado:** ${now} (Ecuador)\n`;
  report += `> **Metodología:** KPI principal = Conversaciones iniciadas (WhatsApp/Messenger). `;
  report += `El pixel de compra no aplica para este modelo de negocio.\n\n`;

  report += execSummary(results);
  report += masterTable(results);
  report += `\n---\n\n# 🔎 Ficha por Cliente\n\n`;

  const sorted = [...results].sort((a, b) => {
    if (a.metaStatus !== "ok" && b.metaStatus === "ok") return 1;
    if (a.metaStatus === "ok" && b.metaStatus !== "ok") return -1;
    return (b.metaSummary?.totalSpend || 0) - (a.metaSummary?.totalSpend || 0);
  });

  sorted.forEach((r, i) => { report += clientDetail(r, i + 1); });

  report += `\n---\n\n## 📌 Nota Profesional: Cómo medir correctamente clientes WhatsApp\n\n`;
  report += `Los clientes que cierran ventas por WhatsApp tienen un problema estructural de tracking en Meta:\n\n`;
  report += `1. **El Pixel de Meta no ve el cierre de venta** (ocurre en WhatsApp, fuera del dominio)\n`;
  report += `2. **Meta sí puede medir conversaciones iniciadas** — pero debe estar configurado como objetivo de campaña\n`;
  report += `3. **Solución de corto plazo:** Usar la facturación diaria de la plataforma Bakano como fuente de verdad\n`;
  report += `4. **Solución de largo plazo:** Implementar Meta CAPI (Conversions API) enviando eventos de "contacto" o "lead calificado" desde el backend cuando el cliente cierra en WhatsApp\n`;
  report += `5. **Quick win:** En cada Ad Set, cambiar objetivo de optimización a **"Conversaciones"** o **"Mensajes"** para que Meta optimice hacia eso\n\n`;
  report += `*Generado por Bakano Ads Agency Tools · Meta Graph API v22.0 + MongoDB*\n`;

  fs.writeFileSync(REPORT_PATH, report, "utf8");
  console.log(`\n✅ Reporte: ${REPORT_PATH}`);
  console.log(`📊 ${results.filter(r => r.metaStatus === "ok").length}/${results.length} con datos Meta`);
  console.log(`💬 ${results.filter(r => (r.metaSummary?.totalConversions || 0) > 0).length} con conversaciones registradas`);
  console.log(`🏦 ${results.filter(r => r.billing && r.billing.diasReportados > 0).length} con facturación`);

  await mongoose.disconnect();
}

main().catch(err => { console.error("❌", err.message); process.exit(1); });
