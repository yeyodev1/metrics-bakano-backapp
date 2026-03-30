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
