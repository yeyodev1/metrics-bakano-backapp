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

### CRM: métricas diarias y dashboard (2026-10-04)
- Modelo `crmMetricaDiaria.model.ts` (colección `crmmetricasdiarias`, única
  por `workspaceId + dia`, hora de Ecuador): conversaciones con actividad,
  nuevas, por canal, mensajes entrantes/salientes/automáticos, contactos que
  escribieron, sin respuesta, mediana de primera respuesta y `asesores[]`
  (userId de GHL, nombre, mensajes, conversaciones, respuestas, `tiemposSeg`
  hasta 300 para medianas de rango, sinRespuesta). Es también el candado:
  `pendiente → en_curso → terminada | fallida` (3 intentos).
- Cálculo en `crmMetricas.service.ts`: lee TODAS las conversaciones con
  actividad desde el inicio del día (tope 1.500, desde ahora hacia atrás) y
  sus mensajes (`mensajesDesde`, páginas de 100). Saliente humano = no
  viene de workflow/campaña/acción masiva; sin `userId` (contestado desde la
  app de IG/WhatsApp) corta la espera pero no se atribuye a un asesor
  (verificado con datos reales de Bakano 2026-10-04). La respuesta cuenta
  el día en que se envía; sin respuesta = el cliente escribió ese día y al
  cierre seguía esperando (se atribuye al asignado).
- Cron `/api/cron/crm-metricas` (`5,35 * * * *`): pendiente ayer para cada
  CRM conectado (los últimos 7 la primera vez) y calcula lo que falte.
- `GET .../integraciones/crm/metricas?dias=7` (días cerrados hasta ayer) y
  `POST .../integraciones/crm/metricas/recalcular` `{ desde, hasta }` (solo
  equipo, máx. 31 días; lo que no alcanza lo sigue el cron).
- `users.readonly` es opcional (`permisos.usuarios`): sin él no hay nombres de
  asesores; `CrmVista.advertencias` lo avisa. `CrmCliente.get` reintenta 429.
- Bakano People: herramienta `verMiEquipoEnCrm`.

### Videos por guion: subida masiva, revisión por Telegram y 2 rondas (2026-10-04)
- **Subida masiva** (`videoEntrega.service.ts`, rutas en `drive.router.ts`, solo equipo):
  `GET /api/drive/planificaciones` (ventana -75/+45 días; el editor ve sus entornos) ·
  `POST /api/drive/planificaciones/:planningId/sesion` `{ fileName, mimeType, size }` →
  sesión resumable en `Unidad / <Cliente> / <AAAA-MM - Título>` (se crea sola; si la
  planificación ya tenía `driveMonthFolderId`, se reusa) · `POST .../sugerencias`
  `{ archivos: [{ fileId, nombre }] }` (por número o tema del nombre) · `POST .../conectar`
  `{ asignaciones: [{ itemId, fileId }] }`. Conectar renombra a `NN - tema (vN).ext`,
  guarda `item.versiones[]` (la vieja queda en Drive), pone `EDITADO`, `editadoEn`,
  `videoClienteAprobacion: PENDIENTE` y abre la revisión interna (correo PM/CM, banderas).
- **Aviso al cliente**: cuando ningún video EDITADO espera revisión interna y alguno
  espera al cliente, `updateItem` (al aprobar `edicionRevisada`) llama
  `avisarClienteSiTodoRevisado` → `videoReviewNotificationService.notificar`. Ahora
  también sale por **Telegram** (chats de clientes, sin internos ni bloqueados; con
  deuda, el aviso lleva a pagar). Primer aviso siempre; recordatorios por Telegram
  máximo 1 cada 24 h (`avisosRevision.canal: telegram`). Una versión nueva reabre el
  ciclo aunque `videosRevisadosEn` exista.
- **Rondas y cambios** (`correccionVideo.service.ts`): `MAX_RONDAS_VIDEO = 2` por video.
  `POST /api/video-planning/:planningId/video-review` acepta
  `reviews[{ itemId, estado, cambios: [{ segundo: "0:15", texto }] }]`. Rechazar exige
  cambios con segundo (`SEGUNDO_REQUERIDO`), sin rondas → `RONDAS_AGOTADAS` (solo
  aprobar), y filtra **vanidad** (palabras de negocio pasan directo; si no, IA
  `AI_MODEL`; si la IA cae, lista de palabras de vanidad). Errores → 422 con
  `{ message, codigo, numero }`. Rechazo: `edicion = RECHAZADO` (vuelve a la cola del
  editor), `rondasUsadas++`, `correccionesVideo[]`, ReviewEvent cliente/edición, aviso
  al editor (in-app `video_corregido`, Telegram, correo `sendCorreccionesVideoEditor`).
  Aprobar → `videoAprobadoEn`.
- **Bot**: callback `vid:lista`, atajo "Revisar videos", herramientas
  `verVideosParaRevisar`, `aprobarVideo`, `anotarCorreccionVideo` (segundo + cambio,
  filtra vanidad al anotar), `quitarCorreccionVideo`, `verBorradorCorreccionVideo`,
  `enviarCorreccionesVideo`. Borrador en `TelegramChat.revisionVideos`.
- Cola del editor y MCP `mi_cola_edicion`: `correcciones[{segundo, texto}]`, `ronda`,
  `rondasRestantes`, `versiones`.
- Bitácora `actividades` (`actividad.model.ts`, `actividadService.registrar`): base del
  reporte semanal.

### Videos por MCP: editor sube y conecta, productor aprueba (2026-10-05)
- `src/mcp/tools/edicion.ts`: `planificaciones_para_subir`, `subir_videos` (devuelve un curl por archivo
  con la URL resumable de Drive), `conectar_videos` (propone por nombre y pregunta; `confirmar` conecta),
  `cola_revision_videos` (ahora también perfil Producción), `aprobar_videos` (pregunta "¿lo envío al
  cliente?"), `devolver_video_editor`.
- La revisión interna antes del cliente la hace el **productor** (y PM/CM): `REVISORES_VIDEO` en
  `videoEntrega.service.ts`; `avisarRevisores` (correo a todos, in-app `video_por_revisar` + Telegram al
  productor) se usa al conectar y al marcar EDITADO en `updateItem`.
- `updateItem(..., opciones?: { avisarCliente?: boolean })`: el MCP aprueba en lote sin aviso y avisa una vez.
- `googleDriveService.listFiles`, `videoEntregaService.archivosSinConectar` / `filtrarSinConectar`,
  `avisarEditorDevuelto` + `resendService.sendVideoDevueltoEditor`. Notificación nueva `video_devuelto`.

### Reporte semanal: viernes 6 pm Ecuador (2026-10-04)
- **Fechas de etapa** en cada item (`guionCreadoEn`, `guionAprobadoEn`, `grabadoEn`,
  `editadoEn`, `videoAprobadoEn`, `publicadoEn`) + `versiones[].en` y
  `correccionesVideo[].en`. Se estampan en la transición (`updateItem`,
  `submitClientApproval`, generación de guion IA, `conectar`, revisión del cliente).
  Lo histórico sin fecha es "sin dato". El PUT de items (`upsert`) conserva
  `CAMPOS_DEL_SERVIDOR` si el front no los manda.
- **Bitácora** `actividades`: guion escrito/aprobado/corregido, producción realizada
  (`planningService.marcarCumplida`), video subido / revisado interno / corregido /
  aprobado / publicado.
- **Servicio** `reporteSemanal.service.ts`: semana = 7 días hasta el viernes 18:00 EC
  (23:00 UTC), clave `semana` = fecha del viernes. Por cliente: guiones escritos /
  aprobados / corregidos (ReviewEvent cliente-contenido), producciones (`cumplidaEn`),
  videos entregados / nuevas versiones / aprobados / rondas / publicados, tiempos
  promedio por etapa con quién (guion → aprobado, aprobado → grabado [o fecha de la
  producción cumplida], grabado → 1ª versión, versión vigente → aprobado, ronda →
  versión que la resolvió), pendientes y CRM (`crmMetricasService.rango(7)`).
  Funciones puras: `rangoSemana`, `medirItems`, `resumirTiempos`, `textoTelegram`.
- **Envío**: Telegram a chats del cliente (sin internos ni bloqueados) + correo
  (`resendService.htmlReporteSemanal` / `sendReporteSemanal`) a
  `planningNotificationService.destinatarios`. Solo `isActive: true`; sin movimiento
  ni pendientes → `omitido`. Consolidado a superadmins (correo + Telegram) armado
  con los `datos` guardados de cada cliente: totales, tiempos por etapa y persona,
  pendientes por cliente.
- **Cron** `/api/cron/reporte-semanal` (`0,10,20,30,40,50 23 * * 5`): `reportessemanales`
  (único `semana + workspaceId`; `workspaceId: null` = consolidado) es el candado;
  presupuesto 45 s por corrida, la siguiente sigue. El consolidado sale cuando ya no
  falta ningún cliente.
- **Previsualizar** (solo equipo): `GET /api/reporte-semanal/:workspaceId/preview`,
  `GET /api/reporte-semanal/consolidado/preview`, `POST /api/reporte-semanal/:workspaceId/prueba`
  `{ correo }` (solo a ese correo). MCP `reporte_semanal` (dirección, PM).

### MCP: Producción crea producciones (2026-10-05)
- `horarios_produccion` y `crear_produccion` (`src/mcp/tools/crearProduccion.ts`; perfiles produccion, pm, direccion). Mismo camino que el bot (`atencionClienteService.citaProduccionEnCrm`): cita en el calendario de producción del CRM (standard/premium), sync al Planificador y avisos. `crearProduccionPorEquipo` usa como contacto al admin cliente más antiguo del entorno. Las reglas del cliente (meses, Ariana, pagos, ya agendada) son advertencias; duras: contrato finalizado y horario ocupado. Las 48 h (`ANTICIPACION_PRODUCCION_H`) son solo un aviso para el equipo interno desde 2026-10-06 (crear y mover por MCP); al cliente se le exigen en el `PUT /api/planning/:entryId` y el bot le pide 5 días. Sin `confirmar` solo revisa.

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
