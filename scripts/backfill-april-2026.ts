/**
 * backfill-april-2026.ts
 *
 * Limpia y re-sincroniza datos para Boloncity
 * usando la lógica CORRECTA: conversión = estado_pago === "CONFIRMADO"
 *
 * Uso: npx ts-node scripts/backfill-april-2026.ts
 */

import "dotenv/config";
import mongoose, { Types } from "mongoose";
import axios from "axios";

// ── Config ─────────────────────────────────────────────────────────────────────
const BOLONCITY_WORKSPACE_ID = "69bdadc67386136fc3682734";
const TUMESERO_API_URL = "https://www.tumesero.com/api_sesiones_kuikers.php";
const TUMESERO_TOKEN = "SLKDJ20934831SKDJkjsooK3O399jgrehlhb90764aaqTYH_387JJyu";

// Fechas pendientes: Ene 27–31, 2026 (los primeros 26 ya están OK)
const START_DATE = "2026-01-27";
const END_DATE   = "2026-01-31";

// Pausa entre llamadas API (ms) para respetar el límite de 6/hora
const DELAY_BETWEEN_CALLS_MS = 3000;

// ── Modelos (inline para no depender del path de src/) ────────────────────────
const StoreSummarySchema = new mongoose.Schema(
  {
    storeName:    { type: String, required: true },
    sessions:     { type: Number, default: 0 },
    orders:       { type: Number, default: 0 },
    revenue:      { type: Number, default: 0 },
    deliveryCost: { type: Number, default: 0 },
  },
  { _id: false }
);

const SalesDailySummarySchema = new mongoose.Schema(
  {
    workspaceId:    { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true },
    date:           { type: String, required: true },
    totalSessions:  { type: Number, default: 0 },
    totalOrders:    { type: Number, default: 0 },
    conversionRate: { type: Number, default: 0 },
    totalRevenue:   { type: Number, default: 0 },
    totalDelivery:  { type: Number, default: 0 },
    totalBilled:    { type: Number, default: 0 },
    byStore:        { type: [StoreSummarySchema], default: [] },
    syncedAt:       { type: Date, default: Date.now },
  },
  { timestamps: true, versionKey: false }
);
SalesDailySummarySchema.index({ workspaceId: 1, date: 1 }, { unique: true });

const SalesDailySummaryModel = mongoose.models.SalesDailySummary
  || mongoose.model("SalesDailySummary", SalesDailySummarySchema);

const TumeseroUsageSchema = new mongoose.Schema(
  {
    date:       { type: String, required: true, unique: true },
    callCount:  { type: Number, default: 0 },
    lastCallAt: { type: Date },
  },
  { timestamps: true, versionKey: false }
);

const TumeseroUsageModel = mongoose.models.TumeseroUsage
  || mongoose.model("TumeseroUsage", TumeseroUsageSchema);

// ── Helpers ────────────────────────────────────────────────────────────────────
function getTodayEcuador(): string {
  const now = new Date();
  const ecuadorTime = new Date(now.getTime() + (-5 * 60 * 60 * 1000));
  const y = ecuadorTime.getUTCFullYear();
  const m = String(ecuadorTime.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ecuadorTime.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getDatesInRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const current = new Date(start + "T12:00:00Z");
  const last    = new Date(end   + "T12:00:00Z");
  while (current <= last) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

// ── Lógica de sync (con la lógica CORRECTA) ────────────────────────────────────
interface TumeseroSession {
  id_sesion:       number;
  fec_sesion:      string;
  nombre_tienda:   string | null;
  estado_pago:     string | null;  // ← campo correcto para conversión
  estado_funnel:   string;
  subtotal_neto:   string | null;
  costo_delivery:  string | null;
  subtotal_desc:   string | null;
  [key: string]:   unknown;
}

async function fetchAndSync(date: string): Promise<void> {
  const todayStr = getTodayEcuador();

  // Incrementar contador de uso
  await TumeseroUsageModel.findOneAndUpdate(
    { date: todayStr },
    { $inc: { callCount: 1 }, $set: { lastCallAt: new Date() } },
    { upsert: true, new: true }
  );

  const response = await axios.get<{ status: string; data: TumeseroSession[] }>(
    TUMESERO_API_URL,
    { params: { desde: date, hasta: date, token: TUMESERO_TOKEN, limit: 1000 }, timeout: 15000 }
  );

  if (response.data.status !== "ok") {
    throw new Error(`API error for ${date}: ${response.data.status}`);
  }

  const sessions: TumeseroSession[] = Array.isArray(response.data.data)
    ? response.data.data
    : [];

  let totalOrders  = 0;
  let totalRevenue = 0;
  let totalDelivery = 0;
  let totalBilled  = 0;

  const storeMap = new Map<string, { sessions: number; orders: number; revenue: number; deliveryCost: number }>();

  for (const s of sessions) {
    // ✅ LÓGICA CORRECTA: conversión = pago confirmado
    const isOrder  = s.estado_pago === "CONFIRMADO";
    const storeName = s.nombre_tienda || "Sin tienda";

    if (!storeMap.has(storeName)) {
      storeMap.set(storeName, { sessions: 0, orders: 0, revenue: 0, deliveryCost: 0 });
    }
    const storeData = storeMap.get(storeName)!;
    storeData.sessions++;

    if (isOrder) {
      totalOrders++;
      storeData.orders++;

      const rev    = parseFloat(s.subtotal_neto   ?? "0") || 0;
      const del    = parseFloat(s.costo_delivery  ?? "0") || 0;
      const billed = parseFloat(s.subtotal_desc   ?? "0") || 0;

      totalRevenue  += rev;
      totalDelivery += del;
      totalBilled   += billed;
      storeData.revenue      += rev;
      storeData.deliveryCost += del;
    }
  }

  const totalSessions  = sessions.length;
  const conversionRate = totalSessions > 0
    ? parseFloat(((totalOrders / totalSessions) * 100).toFixed(2))
    : 0;

  const byStore = Array.from(storeMap.entries()).map(([storeName, data]) => ({ storeName, ...data }));

  await SalesDailySummaryModel.findOneAndUpdate(
    { workspaceId: new Types.ObjectId(BOLONCITY_WORKSPACE_ID), date },
    {
      $set: {
        totalSessions,
        totalOrders,
        conversionRate,
        totalRevenue:  parseFloat(totalRevenue.toFixed(2)),
        totalDelivery: parseFloat(totalDelivery.toFixed(2)),
        totalBilled:   parseFloat(totalBilled.toFixed(2)),
        byStore,
        syncedAt: new Date(),
      },
    },
    { upsert: true, new: true }
  );

  console.log(
    `  ✅ ${date}: ${totalSessions} sesiones | ${totalOrders} CONFIRMADOS | tasa ${conversionRate}% | $${totalBilled.toFixed(2)} facturado`
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const DB_URI = process.env.DB_URI;
  if (!DB_URI) throw new Error("DB_URI no está definido en .env");

  console.log("🔌 Conectando a MongoDB...");
  await mongoose.connect(DB_URI);
  console.log("✅ Conectado.\n");

  const dates = getDatesInRange(START_DATE, END_DATE);
  console.log(`📅 Backfill enero 2026: ${dates.length} días (${START_DATE} → ${END_DATE})\n`);


  // 1. Borrar registros existentes de marzo + abril 2026 para Boloncity
  const deleteResult = await SalesDailySummaryModel.deleteMany({
    workspaceId: new Types.ObjectId(BOLONCITY_WORKSPACE_ID),
    date: { $gte: START_DATE, $lte: END_DATE },
  });
  console.log(`🗑️  Eliminados ${deleteResult.deletedCount} registros existentes (Ene 2026).\n`);

  // 2. Re-sincronizar cada día con lógica correcta
  console.log("🔄 Sincronizando con lógica correcta (estado_pago === CONFIRMADO)...\n");

  let success = 0;
  let failed  = 0;

  for (const date of dates) {
    try {
      await fetchAndSync(date);
      success++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ ${date}: ${msg}`);
      failed++;
    }

    if (date !== dates[dates.length - 1]) {
      await sleep(DELAY_BETWEEN_CALLS_MS);
    }
  }

  console.log(`\n📊 Resultado: ${success} exitosos, ${failed} fallidos de ${dates.length} días.`);

  // 3. Verificar uso de API hoy
  const todayStr = getTodayEcuador();
  const usage = await TumeseroUsageModel.findOne({ date: todayStr }).lean();
  console.log(`\n📡 Llamadas API hoy (${todayStr}): ${(usage as { callCount?: number })?.callCount ?? 0} / 50`);

  await mongoose.disconnect();
  console.log("\n✅ Backfill completo. MongoDB desconectado.");
}

main().catch(err => {
  console.error("Error fatal:", err);
  process.exit(1);
});
