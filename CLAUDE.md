# Bakano Ads Backend — CLAUDE.md

## Package Manager
Usar **pnpm** siempre. Nunca `npm install`.

## Stack
- **Runtime:** Node.js + TypeScript
- **Framework:** Express 5
- **DB:** MongoDB via Mongoose 8
- **Email:** Resend (plantillas HTML inline en `resend.service.ts`)
- **Deploy:** Vercel (REST API puro)
- **Integraciones:** Meta Ads Graph API v22.0, Cloudinary, Gemini AI

## Repos del proyecto
```
roas-platform/
├── ads-bakano-clients-backapp/   ← este repo (backend)
└── ads-bakano-clients-frontapp/  ← frontend (Vue 3 + Vite + Pinia + Chart.js)
```

## Estructura de rutas
Todas las rutas viven en `src/routes/index.ts` y siguen el patrón `/api/<recurso>`.

## Roles de usuario
| Rol | Descripción |
|-----|-------------|
| `superadmin` | Acceso total, equipo Bakano |
| `admin` | Admin del workspace (cliente) |
| `colaborador` | Colaborador del workspace |
| `user` | Usuario genérico |

El flag `isInternal: true` identifica al equipo interno de Bakano.

## Convenciones
- Modelos en `src/models/` exportados desde `src/models/index.ts`
- Servicios en `src/services/`
- Controladores en `src/controllers/`
- Rutas en `src/routes/`
- Middlewares en `src/middlewares/`
- Errores con `CustomError` de `src/errors/customError.error.ts`

## Features en desarrollo

### ROAS - Facturación Diaria (2026-03-30)
Feature para registrar facturación diaria por workspace y calcular ROAS vs gasto Meta Ads.

**Reglas de negocio clave:**
- Múltiples usuarios pueden ingresar en el mismo día, pero cada usuario solo UNA vez (`userId + workspaceId + date` unique)
- El total del día es la SUMA de todas las entradas de ese día
- Al ingresar: doble confirmación (1. escribir "confirmar" 2. modal "¿Estás seguro?" → "¡Sí!")
- Al guardar: snapshot del `metaSpend` del día desde Meta API (Opción B)
- ROAS se calcula y guarda: `amount / metaSpend`
- Superadmin puede editar siempre; admin/colaborador solo el mismo día
- Email a superadmins cada vez que alguien ingresa facturación
- Cron diario: email a quienes NO llenaron (recordatorio) y a quienes SÍ (confirmación con monto)

**Archivos a crear:**
- `src/models/dailyBilling.model.ts`
- `src/services/billing.service.ts`
- `src/controllers/billing.controller.ts`
- `src/routes/billing.router.ts`
- Registrar en `src/routes/index.ts` como `/api/billing`
- Instalar `node-cron` para el cron job
- Agregar `sendBillingNotification` y `sendDailyReminder` en `resend.service.ts`

### Pulso Interno + Meta Mensual (2026-08-25)
Segmento **interno** dentro de cada entorno: meta mensual del cliente contra su
facturación real, ritmo del mes, equipo asignado y recordatorios.

- Modelo: `src/models/monthlyTarget.model.ts` (única por `workspaceId + year + month`)
- Servicio: `src/services/internalPulse.service.ts`
- Rutas: `/api/internal-pulse` (`authMiddleware` + `internalOrSuperadminMiddleware`)
  - `GET /overview` · `GET /missing-count` · `GET /:workspaceId`
  - `GET /:workspaceId/history` · `GET /:workspaceId/status` (etiqueta del menú)
  - `PUT /:workspaceId/target` · `POST /:workspaceId/remind`
- Quién define la meta: cualquiera con `isInternal` o `superadmin`. Se guarda
  `setBy` (quién y cuándo). El cliente no puede verla ni editarla.
- Cron: `/api/cron/monthly-target-reminders` (13:00 UTC, lun-vie)
- Email: `resendService.sendMonthlyTargetDigest` — **un correo por persona**, no
  por cliente: el equipo interno está asignado a casi todos los entornos y la
  versión por cliente mandaba ~900 correos diarios.
- El día en curso no cuenta como hueco ni corta la racha: la facturación se
  registra al cierre del día.
- Frontend: `views/workspaces/InternalPulseView/` (menú "Meta del Mes", ruta
  `WorkspacePulse`) y `views/pulse/PulseOverviewView.vue` (menú "Metas de
  Clientes", ruta `PulseOverview`), ambas `requiresInternal: true`.
- El menú marca `SIN META` en el cliente abierto y cuántos clientes siguen sin
  meta en el link global.

### Producción desde el CRM + reglas de guiones (2026-09-08)
- **Planning** ganó `source: manual|crm`, `crm{appointmentId,...}`, `endsAt` y
  `cumplida/cumplidaEn/cumplidaPorId/cumplidaPorNombre`. `createdBy` es opcional.
- **Webhook** `POST /v1/webhooks/ghl/production-appointment` (cabecera
  `x-ghl-webhook-secret` = `GHL_PRODUCTION_WEBHOOK_SECRET`, cae a
  `GHL_BOOKING_WEBHOOK_SECRET`). Parser tolerante en
  `crmProductionSync.service.ts#normalizarCita` (workflow de GHL, payload plano
  o evento de `/calendars/events`). Upsert por `crm.appointmentId`: crea,
  reprograma o cancela. Cancelada con guiones cargados → no se borra, se
  prefija `CANCELADA · ` en el título.
- Entorno se resuelve por: `customData.workspaceId` → correo del contacto
  (usuario cliente) → `company_name` = nombre del entorno → nombre del entorno
  dentro del título. Si no hay match: notificación + correo a superadmins.
- **Cron** `/api/cron/ghl-production-sync` cada 30 min reconcilia con
  `GHL_PRODUCTION_CALENDAR_IDS` (necesita `GHL_PIT_TOKEN` + `GHL_LOCATION_ID`).
- **Guiones**: el cliente puede rechazar hasta `GUION_CORRECCION_HORAS` (48)
  antes de `Planning.date`; el backend lo hace cumplir en `submitClientApproval`
  (422 `CORRECTION_WINDOW_CLOSED`). `getByEntry` devuelve `produccion` con el
  límite para pintarlo. Rechazo → in-app + correo URGENTE a: autor del guion
  (`guionPorId`), `GUION_RECHAZO_NOTIFY_EMAILS` (Ari) y roles
  `content_manager`/`copywriter`.
- `estadoProduccion → GRABADO` marca `Planning.cumplida` (idempotente) y avisa
  `produccion_cumplida` a todo el entorno. `GET /api/planning/monthly-status`
  resume por entorno (lo usan la vista de Clientes y el calendario del entorno).

### CRM del cliente + "cierres casi solos" (2026-09-26)
- Cada entorno puede conectar SU GoHighLevel (no confundir con `ghl.service.ts`,
  que es el CRM de Bakano). Modelo `crmIntegration.model.ts` (colección
  `crmintegrations`, único por `workspaceId`). El token va cifrado AES-256-GCM
  con `CRM_TOKEN_SECRET` (64 hex) en `tokenCifrado` (`select: false`) y nunca
  sale por la API: se muestra `tokenFinal` (últimos 4).
- Rutas (`crmIntegracion.router.ts`, `authMiddleware` + `workspaceAccessMiddleware`):
  `GET /api/workspaces/:id/integraciones` · `PUT .../integraciones/crm`
  `{ locationId, token }` · `POST .../integraciones/crm/probar` · `DELETE .../integraciones/crm`.
- Cliente GHL por entorno: `crmCliente.service.ts` (conversaciones y mensajes
  con `Version: 2021-04-15`; oportunidades y contactos con `2021-07-28`).
- Revisión diaria: `crmRevision.service.ts`, cron `/api/cron/crm-cierres`
  (14:00-14:45 UTC cada 15 min; cada corrida sigue donde quedó la anterior).
  Guarda `crmrevisiones` (una por entorno y día) y `crmhallazgos` (máx. 5
  por día, sin duplicar por conversación/oportunidad + tipo) y avisa al
  cliente por Telegram (nunca al equipo interno).
- Bot: botón "🔌 Conectar mi CRM" (`crm:ver`) solo si no está conectado o
  está en error; herramienta de IA `verMiCrm`.

### CRM: revisión configurable + modo agencia (2026-09-27)
- `CrmIntegration.revision { activa, diasConversaciones (1–30, def. 1),
  diasOportunidades (1–30, def. 1), diasEstancada (2–60, def. 7) }`. Los
  documentos viejos no la tienen: leer SIEMPRE con `configRevision(doc)`.
  `activa: false` → el cron no revisa ese entorno.
- Tope de conversaciones por corrida: `min(60, 30 + 10·(días−1))` (cada una
  es una llamada de mensajes). Oportunidades: siempre 2 páginas de 100.
- `PATCH .../integraciones/crm/revision` (solo equipo, 403 a clientes) →
  `CrmVista`. `POST .../integraciones/crm/revisar` `{ desde, hasta,
  avisarCliente? }` (solo equipo): revisión manual de hasta 31 días, hora de
  Ecuador, mismo análisis e índices anti-duplicado; guarda con `dia` = día en
  que se corrió; `truncado: true` si quedó algo sin mirar. No crea CrmRevision.
- `CrmIntegration.modo: token_propio | agencia`. Modo agencia: env
  `GHL_AGENCY_TOKEN` + `GHL_COMPANY_ID`; no se guarda token (`tokenFinal`
  = ""), el de subcuenta se pide con `POST /oauth/locationToken` y se cachea en
  memoria. Solo el equipo puede conectar así (`agenciaDisponible` es false
  para clientes) y una location no se conecta por agencia a dos entornos.
  `PUT .../integraciones/crm` con `token` → token_propio; sin `token` →
  agencia si está disponible, si no 400.

### MCP: Producción crea producciones (2026-10-05)
- `horarios_produccion` y `crear_produccion` (`src/mcp/tools/crearProduccion.ts`; perfiles produccion, pm, direccion). Mismo camino que el bot (`atencionClienteService.citaProduccionEnCrm`): cita en el calendario de producción del CRM (standard/premium), sync al Planificador y avisos. `crearProduccionPorEquipo` usa como contacto al admin cliente más antiguo del entorno. Las reglas del cliente (meses, Ariana, pagos, ya agendada) son advertencias; duras: contrato finalizado, horario ocupado y menos de `ANTICIPACION_PRODUCCION_H` (48 h). Sin `confirmar` solo revisa.

### Producción fuera de horario + facturación privada (2026-10-06)
- **Fuera de horario (solo equipo)**: `crear_produccion` con `fuera_de_horario=true` crea la cita con `ignoreFreeSlotValidation` si `atencionClienteService.choquesProduccion` no encuentra citas vivas ni bloqueos que se crucen (standard y premium de Dinamita se cruzan entre sí). Mover (MCP `mover_fecha` y `PUT /api/planning/:entryId`) también revisa choques. El cliente nunca tiene esa opción: en el PUT un no-interno solo mueve producciones de un entorno donde es admin y solo a un horario que `sigueLibre` ofrece.
- **Facturación privada**: `Workspace.facturacionPrivada { activa, visiblePara[], porNombre, en }`. Servicio `facturacionPrivada.service.ts` (`puedeVer`, `filtro`, `chatPuede`, `privadas`). `GET/PUT /api/workspaces/:id/facturacion-privada` (edita el equipo o un admin del entorno que la ve; el que la activa desde el cliente queda incluido). Aplica a `/api/billing/*` (`facturacionVisibleMiddleware`), agent-feed, gate de asesoría de ventas (no se exige a quien no la ve), correos de venta y del cron, recordatorios y resumen mensual por Telegram, botones y herramientas de facturación del bot. El equipo de Bakano siempre la ve. El front recibe `puedoVerFacturacion` en el entorno.

## Notas importantes
- No hay cron jobs instalados aún — usar `node-cron`
- Los emails tienen plantillas HTML inline (ver patrón en `resend.service.ts`)
- Frontend: Vue 3 + Vite, Vue Router 4, Pinia, Chart.js, SCSS custom (sin Tailwind/shadcn)

# context-mode — MANDATORY routing rules

You have context-mode MCP tools available. These rules are NOT optional — they protect your context window from flooding. A single unrouted command can dump 56 KB into context and waste the entire session.

## BLOCKED commands — do NOT attempt these

### curl / wget — BLOCKED
Any Bash command containing `curl` or `wget` is intercepted and replaced with an error message. Do NOT retry.
Instead use:
- `ctx_fetch_and_index(url, source)` to fetch and index web pages
- `ctx_execute(language: "javascript", code: "const r = await fetch(...)")` to run HTTP calls in sandbox

### Inline HTTP — BLOCKED
Any Bash command containing `fetch('http`, `requests.get(`, `requests.post(`, `http.get(`, or `http.request(` is intercepted and replaced with an error message. Do NOT retry with Bash.
Instead use:
- `ctx_execute(language, code)` to run HTTP calls in sandbox — only stdout enters context

### WebFetch — BLOCKED
WebFetch calls are denied entirely. The URL is extracted and you are told to use `ctx_fetch_and_index` instead.
Instead use:
- `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` to query the indexed content

## REDIRECTED tools — use sandbox equivalents

### Bash (>20 lines output)
Bash is ONLY for: `git`, `mkdir`, `rm`, `mv`, `cd`, `ls`, `npm install`, `pip install`, and other short-output commands.
For everything else, use:
- `ctx_batch_execute(commands, queries)` — run multiple commands + search in ONE call
- `ctx_execute(language: "shell", code: "...")` — run in sandbox, only stdout enters context

### Read (for analysis)
If you are reading a file to **Edit** it → Read is correct (Edit needs content in context).
If you are reading to **analyze, explore, or summarize** → use `ctx_execute_file(path, language, code)` instead. Only your printed summary enters context. The raw file content stays in the sandbox.

### Grep (large results)
Grep results can flood context. Use `ctx_execute(language: "shell", code: "grep ...")` to run searches in sandbox. Only your printed summary enters context.

## Tool selection hierarchy

1. **GATHER**: `ctx_batch_execute(commands, queries)` — Primary tool. Runs all commands, auto-indexes output, returns search results. ONE call replaces 30+ individual calls.
2. **FOLLOW-UP**: `ctx_search(queries: ["q1", "q2", ...])` — Query indexed content. Pass ALL questions as array in ONE call.
3. **PROCESSING**: `ctx_execute(language, code)` | `ctx_execute_file(path, language, code)` — Sandbox execution. Only stdout enters context.
4. **WEB**: `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` — Fetch, chunk, index, query. Raw HTML never enters context.
5. **INDEX**: `ctx_index(content, source)` — Store content in FTS5 knowledge base for later search.

## Subagent routing

When spawning subagents (Agent/Task tool), the routing block is automatically injected into their prompt. Bash-type subagents are upgraded to general-purpose so they have access to MCP tools. You do NOT need to manually instruct subagents about context-mode.

## Output constraints

- Keep responses under 500 words.
- Write artifacts (code, configs, PRDs) to FILES — never return them as inline text. Return only: file path + 1-line description.
- When indexing content, use descriptive source labels so others can `ctx_search(source: "label")` later.

## ctx commands

| Command | Action |
|---------|--------|
| `ctx stats` | Call the `ctx_stats` MCP tool and display the full output verbatim |
| `ctx doctor` | Call the `ctx_doctor` MCP tool, run the returned shell command, display as checklist |
| `ctx upgrade` | Call the `ctx_upgrade` MCP tool, run the returned shell command, display as checklist |
