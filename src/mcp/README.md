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
| Dirección | superadmin, director | Todo + `auditoria_mcp`. Solo superadmin: gestión de entornos (ver abajo) |
| Project Manager | project_manager, account_manager | Pendientes, Telegram completo, incidentes, fechas (videos y producciones), onboarding (escribe) |
| Contenido | content_manager, community_manager, estratega, copywriter | Pendientes, Telegram solo de guiones/videos, planificación, mover publicaciones, feedback, revisión |
| Producción | productor, asistente_produccion | Pendientes, calendario, planificación, mover producciones (con aviso a contenido), onboarding (lectura) |
| Edición | editor, disenador | Pendientes, `mi_cola_edicion`, `actualizar_edicion` (solo estadoProduccion/edicion/linkVideo) |
| Campañas | trafficker | Pendientes, métricas, clientes sin Meta |
| Equipo | el resto | Pendientes, clientes, calendario, notificaciones |

Una tool que no es del perfil no aparece en `tools/list`. Cada llamada queda en `mcpauditoria`.
Si cambias el perfil de una tool, cambia también `mcp-bakano-frontapp/src/data/perfiles.ts`.

## Entornos (solo superadmin)

`soloSuperadmin` en la tool: un director también es perfil Dirección, pero crear, pausar o borrar
entornos en la plataforma es de superadmin, así que a él no le aparecen.

- `crear_entorno`, `editar_entorno` (nombre; motivo/nota si está pausado).
- `pausar_entorno` (motivo obligatorio) / `reanudar_entorno`: no borran nada.
- Borrar en dos pasos: `consultar_eliminar_entorno` no escribe, muestra el impacto y da un token de 5 min;
  `eliminar_entorno(token, confirmar_nombre)`. Solo entornos ya pausados. Usa el mismo `deleteWorkspace`
  de la plataforma: borra el entorno y sus usuarios del cliente, desvincula a los @bakano.ec y deja
  producciones, guiones y chats sin entorno (no los borra).
- Personas: `ver_personas_entorno`, `agregar_persona_entorno` (mismo `createUser` de la plataforma: si es
  nueva, contraseña aleatoria + correo de bienvenida; arranca onboarding, bot y Bakanology),
  `quitar_persona_entorno` (sin token muestra el impacto y da token; con token aplica `deleteUser`,
  que borra la cuenta si era su único entorno). Los contactos bloqueados no se agregan.
  `contrasena_persona_entorno`: pone contraseña (dada o generada `xxxx-xxxx-xxxx`) con `updateUser`, la devuelve
  y opcionalmente manda el correo de acceso. La auditoría guarda `***` en lugar de contraseñas.
  `agregar_persona_entorno` acepta `contrasena` inicial y la devuelve. `recuperar_contrasena` (dirección y PM)
  manda el correo de "olvidé mi contraseña" de Metrics o Bakanology (`accesosCliente.recuperarPorCorreo`).

## Correos (solo superadmin)

`correo_prueba` manda la prueba SOLO a quien lo pide (con franja de a quién llegaría) y da un token de
30 min que lleva el correo entero; `enviar_correo(token)` manda exactamente eso, uno por destinatario
(máx. 40, la función vive 60 s). Sale de noreply sin replyTo y el pie siempre dice que es de solo envío
y remite a soporte@bakano.ec. Destinatarios: `para` y/o los clientes activos de un entorno; los
bloqueados se apartan.

## Fechas negociadas

`consultar_cambio_fecha` no escribe: devuelve permitido/motivos/advertencias y un token JWT de 5 min
atado a ese cambio y a esa persona. `mover_fecha(token)` vuelve a evaluar y recién ahí mueve.
Producción: solo PM/dirección, 48 h de anticipación, se mueve también en el CRM.

## Producciones → contenido

Producción, PM y dirección mueven producciones (`consultar_cambio_fecha` + `mover_fecha`). Todo cambio de
fecha de una producción (MCP, plataforma con `PlanningService.updateEntry`, o el CRM al agendar, mover o
cancelar) avisa a Ariana (`EQUIPO_ATENCION.guiones`) y a las content_manager del entorno (si no hay, a todas):
in-app + correo con cuántos guiones hay aprobados y hasta cuándo corrige el cliente
(`avisoContenidoProduccion.service.ts`).

## Telegram: hechos y lectura con IA

`ver_conversacion_telegram` trae además `hechos` (`lecturaConversacion.service.hechos`): contrato y estado del
último correo, entregables pendientes, avisos que de verdad llegaron al equipo (y si alguien los leyó) e
incidentes. `analizar_conversacion_telegram` (dirección y PM) cruza chat + hechos con la IA (`AI_MODEL` vía AI
Gateway) y devuelve resumen, dónde se trabó y por qué, promesas del bot cumplidas o no, lo ya resuelto, lo que
falta del cliente y siguientes pasos con responsable.

## Lucas

`lucas_cliente` pide a Lucas `GET /api/metrics/entornos/:id/resumen` con `x-metrics-key` =
`METRICS_PROXY_KEY` (en Lucas es `METRICS_SYNC_KEY`). `LUCAS_API_URL` (def.
`https://lucas-by-bakano-backapp.vercel.app/api`).

## Variables

- `MCP_PUBLIC_URL` (def. `https://mcp.bakano.ec`): issuer y dirección del recurso.
- `MCP_GUIA_URL` (def. = `MCP_PUBLIC_URL`): dónde viven `/entrar` y `/confirmar`.
