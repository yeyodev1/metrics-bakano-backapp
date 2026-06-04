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
