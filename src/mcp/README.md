# MCP del equipo interno

Servidor MCP (HTTP, sin sesión) montado en la raíz del backend: `/mcp`, `/oauth/*`
y `/.well-known/oauth-*`. La dirección pública es `https://mcp.bakano.ec/mcp`
(el front `mcp-bakano-frontapp` reenvía esas rutas aquí con `vercel.json`).

## Entrada: OAuth 2.1 + enlace mágico

1. Claude se registra (`POST /oauth/register`) y abre `/oauth/authorize` (PKCE S256).
2. Se crea una `mcpsolicitudes` y el navegador va a `mcp.bakano.ec/entrar`.
3. La persona pone su correo; solo pasa si `perfilDe(user)` no es null (superadmin o `isInternal`, activo).
4. Le llega un correo con un código corto (el mismo que ve en pantalla). Confirma con POST en `/confirmar`.
5. La pestaña que empezó sondea con su secreto, recibe el `code` y vuelve a Claude, que lo cambia en `/oauth/token`.

Access 7 días, refresh 90 días que rota en cada uso. Todo se guarda hasheado.
El rol se relee de Mongo en cada llamada: cambiar o desactivar a alguien corta el acceso al instante.

## Perfiles (`perfiles.ts`)

| Perfil | internalRole | Ve |
|---|---|---|
| Dirección | superadmin, director | Todo + `auditoria_mcp` |
| Project Manager | project_manager, account_manager | Pendientes, Telegram completo, incidentes, fechas (videos y producciones), onboarding (escribe) |
| Contenido | content_manager, community_manager, estratega, copywriter | Pendientes, Telegram solo de guiones/videos, planificación, mover publicaciones, feedback, revisión |
| Producción | productor, asistente_produccion | Pendientes, calendario, planificación, onboarding (lectura) |
| Edición | editor, disenador | Pendientes, `mi_cola_edicion`, `actualizar_edicion` (solo estadoProduccion/edicion/linkVideo) |
| Campañas | trafficker | Pendientes, métricas, clientes sin Meta |
| Equipo | el resto | Pendientes, clientes, calendario, notificaciones |

Una tool que no es del perfil no aparece en `tools/list`. Cada llamada queda en `mcpauditoria`.
Si cambias el perfil de una tool, cambia también `mcp-bakano-frontapp/src/data/perfiles.ts`.

## Fechas negociadas

`consultar_cambio_fecha` no escribe: devuelve permitido/motivos/advertencias y un token JWT de 5 min
atado a ese cambio y a esa persona. `mover_fecha(token)` vuelve a evaluar y recién ahí mueve.
Producción: solo PM/dirección, 48 h de anticipación, se mueve también en el CRM.

## Variables

- `MCP_PUBLIC_URL` (def. `https://mcp.bakano.ec`): issuer y dirección del recurso.
- `MCP_GUIA_URL` (def. = `MCP_PUBLIC_URL`): dónde viven `/entrar` y `/confirmar`.
