import { Resend } from "resend";
import { sinBloqueados } from "../utils/contactosBloqueados";

const MARCA = "Bakano Metrics";
// Logo blanco con punto rosado: vive en public/ del front para tener URL fija.
const LOGO_CLARO = "https://metrics.bakano.ec/email/bakano-logo-light.png";

/**
 * Barra de marca arriba de todos los correos. Fondo oscuro para que el logo
 * blanco (y su punto rosado) contraste siempre, sea cual sea el color del
 * encabezado de cada correo (rojo urgente, morado novedades, etc.).
 */
function barraMarca(): string {
  return `<tr><td style="background:#0f0d14;padding:22px 40px 18px;text-align:center;border-bottom:3px solid #e6285c;"><a href="https://metrics.bakano.ec" style="text-decoration:none;"><img src="${LOGO_CLARO}" width="150" height="26" alt="${MARCA}" style="display:inline-block;border:0;outline:none;width:150px;height:26px;"/></a><p style="margin:8px 0 0;font-size:11px;font-weight:700;letter-spacing:4px;text-transform:uppercase;color:#f9a8d4;">📊 metrics</p></td></tr>`;
}


interface WelcomeEmailParams {
  to: string;
  recipientName?: string;
  email: string;
  password: string;
  isInternal: boolean;
  internalRole?: string;
}

export class ResendService {
  // Lazy getter — read env at call time, not at module import time
  /**
   * Todos los correos salen por aqui: antes de enviar se sacan los contactos
   * bloqueados por direccion (to, cc y bcc). Si no queda nadie, no se envia.
   */
  private get client() {
    const resend = new Resend(process.env.RESEND_API_KEY);
    type Envio = Parameters<Resend["emails"]["send"]>[0];
    return {
      emails: {
        send: async (params: Envio): Promise<Awaited<ReturnType<Resend["emails"]["send"]>>> => {
          const p = params as any;
          const to = await sinBloqueados(p.to as string | string[]);
          if (!to || (Array.isArray(to) && !to.length)) {
            console.warn(`[Resend] correo "${p.subject}" no enviado: solo tenía destinatarios bloqueados`);
            return { data: null, error: null } as any;
          }
          return resend.emails.send({
            ...p,
            to,
            ...(p.cc ? { cc: await sinBloqueados(p.cc) } : {}),
            ...(p.bcc ? { bcc: await sinBloqueados(p.bcc) } : {}),
          });
        },
      },
    };
  }

  private get from(): string {
    const configurado = process.env.RESEND_FROM_EMAIL || "noreply@bakano.ec";
    const direccion = configurado.match(/<([^>]+)>/)?.[1] ?? configurado.trim();
    return `${process.env.RESEND_FROM_NAME || `${MARCA} 📊`} <${direccion}>`;
  }

  async sendWelcomeEmail(params: WelcomeEmailParams): Promise<void> {
    const { to, recipientName, email, password, isInternal, internalRole } = params;
    const appUrl = 'https://metrics.bakano.ec';
    const firstName = recipientName ? recipientName.split(' ')[0] : 'nuevo integrante';

    const roleLabels: Record<string, string> = {
      director: 'Director', estratega: 'Estratega', project_manager: 'Project Manager', content_manager: 'Content Manager',
      account_manager: 'Account Manager', community_manager: 'Community Manager',
      productor: 'Productor', editor: 'Editor', disenador: 'Diseñador',
      copywriter: 'Copywriter', analista: 'Analista', desarrollador: 'Desarrollador',
    };

    const userTypeLabel = isInternal ? 'Equipo Interno' : 'Cliente';
    const userTypeColor = isInternal ? '#6d28d9' : '#0f766e';
    const userTypeBg = isInternal ? '#f5f3ff' : '#f0fdfa';
    const roleLabel = internalRole ? roleLabels[internalRole] || internalRole : null;

    const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Bienvenido/a a Bakano Metrics</title>
</head>
<body style="margin:0;padding:0;background-color:#f0f2f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f2f5;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

          <!-- Header -->
          ${barraMarca()}
          <tr>
            <td style="background:linear-gradient(135deg,#0f1117 0%,#1e293b 100%);padding:36px 40px 32px;text-align:center;">
              <div style="display:inline-block;width:64px;height:64px;background:rgba(255,255,255,0.08);border-radius:50%;text-align:center;line-height:64px;font-size:30px;margin-bottom:16px;">🎉</div>
              <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;line-height:1.3;">¡Bienvenido/a, ${firstName}!</h1>
              <p style="margin:10px 0 0;color:rgba(255,255,255,0.65);font-size:15px;">Tu cuenta ha sido creada exitosamente.</p>
            </td>
          </tr>

          <!-- User type badge -->
          <tr>
            <td style="padding:24px 40px 0;text-align:center;">
              <span style="display:inline-flex;align-items:center;gap:6px;background:${userTypeBg};color:${userTypeColor};font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:0.8px;padding:6px 16px;border-radius:20px;border:1.5px solid ${userTypeColor}30;">
                ${isInternal ? '⚡ ' : '👤 '}${userTypeLabel}${roleLabel ? ' · ' + roleLabel : ''}
              </span>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:28px 40px 32px;">
              <p style="margin:0 0 24px;color:#374151;font-size:15px;line-height:1.7;">
                A continuación encontrarás tus credenciales de acceso. Guárdalas en un lugar seguro y te recomendamos cambiar tu contraseña después del primer inicio de sesión.
              </p>

              <!-- Credentials box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;overflow:hidden;margin-bottom:28px;">
                <tr>
                  <td style="padding:8px 20px 8px;background:#e2e8f0;">
                    <p style="margin:0;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;">Tus credenciales de acceso</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:20px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding-bottom:14px;">
                          <p style="margin:0 0 4px;color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Correo electrónico</p>
                          <p style="margin:0;color:#0f172a;font-size:16px;font-weight:600;font-family:monospace,monospace;">${email}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="border-top:1px solid #e2e8f0;padding-top:14px;">
                          <p style="margin:0 0 4px;color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Contraseña temporal</p>
                          <p style="margin:0;color:#0f172a;font-size:18px;font-weight:700;font-family:monospace,monospace;background:#fff;border:1.5px solid #e2e8f0;border-radius:8px;padding:8px 14px;display:inline-block;letter-spacing:1px;">${password}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding-bottom:24px;">
                    <a href="${appUrl}/login"
                       style="display:inline-block;background:linear-gradient(135deg,#0f1117 0%,#1e293b 100%);color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;padding:14px 40px;border-radius:10px;letter-spacing:0.2px;box-shadow:0 4px 14px rgba(15,17,23,0.25);">
                      Ingresar a Bakano Metrics →
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Security note -->
              <div style="background:#fefce8;border:1.5px solid #fde68a;border-radius:10px;padding:14px 18px;">
                <p style="margin:0;color:#92400e;font-size:13px;line-height:1.6;">
                  <strong>🔐 Recomendación de seguridad:</strong> Por favor cambia tu contraseña después de tu primer inicio de sesión para mantener tu cuenta protegida.
                </p>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #e2e8f0;text-align:center;">
              <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.6;">
                Este correo fue generado automáticamente por <strong>Bakano Metrics</strong>.<br/>
                Si no esperabas este correo, por favor contáctanos.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    await this.client.emails.send({
      from: this.from,
      to,
      subject: `¡Bienvenido/a a Bakano Metrics! Tus credenciales de acceso`,
      html,
    });
  }


  /**
   * Notifies all superadmins when a user registers a billing entry.
   */
  async sendBillingEnteredNotification(params: {
    superadminEmails: string[];
    workspaceName: string;
    userName: string;
    amount: number;
    totalDay: number;
    metaSpend: number;
    roas: number;
    date: Date;
  }): Promise<void> {
    const { superadminEmails, workspaceName, userName, amount, totalDay, metaSpend, roas, date } = params;

    const dateLabel = date.toLocaleDateString("es-EC", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "America/Guayaquil",
    });

    const roasColor = roas >= 3 ? "#16a34a" : roas >= 1 ? "#d97706" : "#dc2626";
    const roasBg = roas >= 3 ? "#f0fdf4" : roas >= 1 ? "#fffbeb" : "#fef2f2";
    const roasBorder = roas >= 3 ? "#bbf7d0" : roas >= 1 ? "#fde68a" : "#fecaca";

    const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Nueva facturación registrada · ${workspaceName}</title>
</head>
<body style="margin:0;padding:0;background-color:#f0f2f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f2f5;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

          <!-- Header -->
          ${barraMarca()}
          <tr>
            <td style="background:linear-gradient(135deg,#0f1117 0%,#1e293b 100%);padding:36px 40px 32px;text-align:center;">
              <div style="display:inline-block;width:64px;height:64px;background:rgba(255,255,255,0.08);border-radius:50%;text-align:center;line-height:64px;font-size:30px;margin-bottom:16px;">💰</div>
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;line-height:1.3;">Nueva facturación registrada</h1>
              <p style="margin:8px 0 0;color:rgba(255,255,255,0.65);font-size:14px;text-transform:capitalize;">${dateLabel}</p>
            </td>
          </tr>

          <!-- Details card -->
          <tr>
            <td style="padding:32px 40px 0;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                <tr>
                  <td style="padding:10px 20px;background:#e2e8f0;">
                    <p style="margin:0;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;">Detalle de facturación</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:20px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding-bottom:14px;">
                          <p style="margin:0 0 3px;color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Cliente</p>
                          <p style="margin:0;color:#0f172a;font-size:15px;font-weight:700;">${workspaceName}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="border-top:1px solid #e2e8f0;padding:14px 0;">
                          <p style="margin:0 0 3px;color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Usuario que ingresó</p>
                          <p style="margin:0;color:#0f172a;font-size:15px;font-weight:600;">${userName}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="border-top:1px solid #e2e8f0;padding:14px 0;">
                          <p style="margin:0 0 3px;color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Monto ingresado</p>
                          <p style="margin:0;color:#0f172a;font-size:18px;font-weight:700;">$${amount.toLocaleString("es-EC", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="border-top:1px solid #e2e8f0;padding:14px 0;">
                          <p style="margin:0 0 3px;color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Total del día</p>
                          <p style="margin:0;color:#0f172a;font-size:18px;font-weight:700;">$${totalDay.toLocaleString("es-EC", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="border-top:1px solid #e2e8f0;padding:14px 0;">
                          <p style="margin:0 0 3px;color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Inversión Meta Ads</p>
                          <p style="margin:0;color:#0f172a;font-size:15px;font-weight:600;">$${metaSpend.toLocaleString("es-EC", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="border-top:1px solid #e2e8f0;padding-top:14px;">
                          <p style="margin:0 0 6px;color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">ROAS del día</p>
                          <span style="display:inline-block;background:${roasBg};color:${roasColor};border:1.5px solid ${roasBorder};border-radius:8px;padding:6px 16px;font-size:18px;font-weight:800;">${roas.toFixed(2)}x</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Spacer -->
          <tr><td style="height:32px;"></td></tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #e2e8f0;text-align:center;">
              <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.6;">
                Este correo fue generado automáticamente por <strong>Bakano Metrics</strong>.<br/>
                Notificación interna — no requiere acción.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    await this.client.emails.send({
      from: this.from,
      to: superadminEmails,
      subject: `💰 Nueva facturación · ${workspaceName} · $${amount.toLocaleString("es-EC", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      html,
    });
  }

  /**
   * Notifies all external collaborators of a workspace when a billing entry is created or updated.
   * Sent individually to each recipient so the email is personalized.
   */
  async sendBillingExternalNotification(params: {
    recipients: { email: string; name: string }[];
    workspaceName: string;
    workspaceId: string;
    userName: string;
    amount: number;
    totalDay: number;
    metaSpend: number;
    roas: number;
    date: Date;
    isUpdate: boolean;
  }): Promise<void> {
    const { recipients, workspaceName, workspaceId, userName, amount, totalDay, metaSpend, roas, date, isUpdate } = params;
    const appUrl = "https://metrics.bakano.ec";
    const billingUrl = `${appUrl}/app/workspaces/${workspaceId}/billing`;

    const dateLabel = date.toLocaleDateString("es-EC", {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
      timeZone: "America/Guayaquil",
    });

    const roasColor = roas >= 3 ? "#16a34a" : roas >= 1 ? "#d97706" : "#dc2626";
    const roasBg = roas >= 3 ? "#f0fdf4" : roas >= 1 ? "#fffbeb" : "#fef2f2";
    const roasBorder = roas >= 3 ? "#bbf7d0" : roas >= 1 ? "#fde68a" : "#fecaca";
    const actionLabel = isUpdate ? "Facturación actualizada" : "Nueva facturación registrada";
    const actionEmoji = isUpdate ? "✏️" : "💰";
    const subjectPrefix = isUpdate ? "✏️ Facturación actualizada" : "💰 Nueva facturación";

    const emailPromises = recipients.map(({ email, name }) => {
      const firstName = name.split(" ")[0];
      const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${actionLabel} · ${workspaceName}</title>
</head>
<body style="margin:0;padding:0;background-color:#f0f2f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f2f5;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

          <!-- Header -->
          ${barraMarca()}
          <tr>
            <td style="background:linear-gradient(135deg,#0f1117 0%,#1e293b 100%);padding:36px 40px 32px;text-align:center;">
              <div style="display:inline-block;width:64px;height:64px;background:rgba(255,255,255,0.08);border-radius:50%;text-align:center;line-height:64px;font-size:30px;margin-bottom:16px;">${actionEmoji}</div>
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;line-height:1.3;">${actionLabel}</h1>
              <p style="margin:8px 0 0;color:rgba(255,255,255,0.65);font-size:14px;text-transform:capitalize;">${dateLabel}</p>
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding:28px 40px 0;">
              <p style="margin:0;color:#0f172a;font-size:15px;line-height:1.6;">Hola <strong>${firstName}</strong>, se ha ${isUpdate ? "actualizado" : "registrado"} la facturación de <strong>${workspaceName}</strong>.</p>
            </td>
          </tr>

          <!-- Details card -->
          <tr>
            <td style="padding:20px 40px 0;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                <tr>
                  <td style="padding:10px 20px;background:#e2e8f0;">
                    <p style="margin:0;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;">Resumen del día</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:20px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding-bottom:14px;">
                          <p style="margin:0 0 3px;color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">${isUpdate ? "Actualizado por" : "Registrado por"}</p>
                          <p style="margin:0;color:#0f172a;font-size:15px;font-weight:700;">${userName}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="border-top:1px solid #e2e8f0;padding:14px 0;">
                          <p style="margin:0 0 3px;color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Monto ${isUpdate ? "actualizado" : "registrado"}</p>
                          <p style="margin:0;color:#0f172a;font-size:20px;font-weight:800;">$${amount.toLocaleString("es-EC", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="border-top:1px solid #e2e8f0;padding:14px 0;">
                          <p style="margin:0 0 3px;color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Total facturado del día</p>
                          <p style="margin:0;color:#0f172a;font-size:18px;font-weight:700;">$${totalDay.toLocaleString("es-EC", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="border-top:1px solid #e2e8f0;padding:14px 0;">
                          <p style="margin:0 0 3px;color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Inversión Meta Ads</p>
                          <p style="margin:0;color:#0f172a;font-size:15px;font-weight:600;">$${metaSpend.toLocaleString("es-EC", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="border-top:1px solid #e2e8f0;padding-top:14px;">
                          <p style="margin:0 0 8px;color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">ROAS del día</p>
                          <span style="display:inline-block;background:${roasBg};color:${roasColor};border:1.5px solid ${roasBorder};border-radius:8px;padding:6px 16px;font-size:18px;font-weight:800;">${roas.toFixed(2)}x</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td style="padding:24px 40px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <a href="${billingUrl}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:700;font-size:14px;letter-spacing:0.2px;">Ver facturación completa →</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #e2e8f0;text-align:center;">
              <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.6;">
                Este correo fue generado automáticamente por <strong>Bakano Metrics</strong>.<br/>
                Estás recibiendo esto porque tienes acceso a <strong>${workspaceName}</strong>.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

      return this.client.emails.send({
        from: this.from,
        to: email,
        subject: `${subjectPrefix} · ${workspaceName} · $${amount.toLocaleString("es-EC", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        html,
      });
    });

    await Promise.allSettled(emailPromises);
  }

  /**
   * Sends a daily billing reminder or confirmation to an external user.
   */
  async sendDailyBillingReminder(params: {
    to: string;
    recipientName: string;
    workspaceName: string;
    workspaceId: string;
    hasFilled: boolean;
    filledAmount?: number;
    totalDayAmount?: number;
    date: Date;
  }): Promise<void> {
    const { to, recipientName, workspaceName, workspaceId, hasFilled, filledAmount, totalDayAmount, date } = params;
    const appUrl = "https://metrics.bakano.ec";
    const firstName = recipientName.split(" ")[0];

    const dateLabel = date.toLocaleDateString("es-EC", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "America/Guayaquil",
    });

    const billingUrl = `${appUrl}/app/workspaces/${workspaceId}/billing`;

    const html = hasFilled ? `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Facturación confirmada · ${workspaceName}</title>
</head>
<body style="margin:0;padding:0;background-color:#f0f2f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f2f5;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

          <!-- Header -->
          ${barraMarca()}
          <tr>
            <td style="background:linear-gradient(135deg,#0f1117 0%,#1e293b 100%);padding:36px 40px 32px;text-align:center;">
              <div style="display:inline-block;width:64px;height:64px;background:rgba(255,255,255,0.08);border-radius:50%;text-align:center;line-height:64px;font-size:30px;margin-bottom:16px;">✅</div>
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;line-height:1.3;">¡Facturación confirmada!</h1>
              <p style="margin:8px 0 0;color:rgba(255,255,255,0.65);font-size:14px;">Hola ${firstName}, tu registro de hoy está listo.</p>
            </td>
          </tr>

          <!-- Details card -->
          <tr>
            <td style="padding:32px 40px 0;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:12px;overflow:hidden;">
                <tr>
                  <td style="padding:10px 20px;background:#bbf7d0;">
                    <p style="margin:0;color:#15803d;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;">Resumen del día · ${dateLabel}</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:20px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding-bottom:14px;">
                          <p style="margin:0 0 3px;color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Cliente</p>
                          <p style="margin:0;color:#0f172a;font-size:15px;font-weight:700;">${workspaceName}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="border-top:1px solid #dcfce7;padding:14px 0;">
                          <p style="margin:0 0 3px;color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Tu monto registrado</p>
                          <p style="margin:0;color:#16a34a;font-size:22px;font-weight:800;">$${(filledAmount ?? 0).toLocaleString("es-EC", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                        </td>
                      </tr>
                      ${totalDayAmount !== undefined ? `
                      <tr>
                        <td style="border-top:1px solid #dcfce7;padding-top:14px;">
                          <p style="margin:0 0 3px;color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Total facturado del día</p>
                          <p style="margin:0;color:#0f172a;font-size:18px;font-weight:700;">$${totalDayAmount.toLocaleString("es-EC", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                        </td>
                      </tr>` : ""}
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Spacer -->
          <tr><td style="height:32px;"></td></tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #e2e8f0;text-align:center;">
              <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.6;">
                Este correo fue generado automáticamente por <strong>Bakano Metrics</strong>.<br/>
                Si tienes dudas, contacta a tu gestor de cuenta.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>` : `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Recordatorio de facturación · ${workspaceName}</title>
</head>
<body style="margin:0;padding:0;background-color:#f0f2f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f2f5;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

          <!-- Header -->
          ${barraMarca()}
          <tr>
            <td style="background:linear-gradient(135deg,#0f1117 0%,#1e293b 100%);padding:36px 40px 32px;text-align:center;">
              <div style="display:inline-block;width:64px;height:64px;background:rgba(255,255,255,0.08);border-radius:50%;text-align:center;line-height:64px;font-size:30px;margin-bottom:16px;">⏰</div>
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;line-height:1.3;">Recordatorio de facturación</h1>
              <p style="margin:8px 0 0;color:rgba(255,255,255,0.65);font-size:14px;">Hola ${firstName}, aún no has registrado tu facturación de hoy.</p>
            </td>
          </tr>

          <!-- Alert card -->
          <tr>
            <td style="padding:32px 40px 0;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1.5px solid #fde68a;border-radius:12px;overflow:hidden;">
                <tr>
                  <td style="padding:10px 20px;background:#fde68a;">
                    <p style="margin:0;color:#92400e;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;">Pendiente · ${dateLabel}</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:20px;">
                    <p style="margin:0 0 8px;color:#0f172a;font-size:15px;font-weight:600;">Cliente: ${workspaceName}</p>
                    <p style="margin:0;color:#374151;font-size:14px;line-height:1.7;">
                      No olvides registrar el monto facturado de hoy para mantener actualizado el seguimiento de ROAS de tu cuenta.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td style="padding:24px 40px 0;text-align:center;">
              <a href="${billingUrl}"
                 style="display:inline-block;background:linear-gradient(135deg,#0f1117 0%,#1e293b 100%);color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;padding:14px 40px;border-radius:10px;letter-spacing:0.2px;box-shadow:0 4px 14px rgba(15,17,23,0.25);">
                Registrar facturación →
              </a>
            </td>
          </tr>

          <!-- Spacer -->
          <tr><td style="height:32px;"></td></tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #e2e8f0;text-align:center;">
              <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.6;">
                Este correo fue generado automáticamente por <strong>Bakano Metrics</strong>.<br/>
                Si tienes dudas, contacta a tu gestor de cuenta.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const subject = hasFilled
      ? `Facturación confirmada - ${workspaceName} | Bakano Metrics`
      : `Registro de facturación pendiente - ${workspaceName} | Bakano Metrics`;

    // Plain-text fallback (improves deliverability)
    const text = hasFilled
      ? `Hola ${recipientName.split(' ')[0]}, tu facturación de ${workspaceName} fue confirmada correctamente. Gracias por mantener tus datos al día en Bakano Metrics.`
      : `Hola ${recipientName.split(' ')[0]}, aún no has registrado la facturación de hoy para ${workspaceName}. Ingresa a https://metrics.bakano.ec/app/workspaces/${workspaceId}/billing para completarlo. Equipo Bakano Metrics.`;

    await this.client.emails.send({
      from: this.from,
      to,
      replyTo: process.env.RESEND_REPLY_TO || 'hola@bakano.ec',
      subject,
      html,
      text,
      headers: {
        'List-Unsubscribe': `<mailto:${process.env.RESEND_REPLY_TO || 'hola@bakano.ec'}?subject=Cancelar+recordatorios>`,
        'X-Entity-Ref-ID': `billing-${workspaceId}`,
      },
    });
  }

  /**
   * Resumen interno para una persona del equipo con todos sus clientes cuya
   * meta mensual esta en rojo. Es un solo correo por persona a proposito: el
   * equipo interno esta asignado a casi todos los entornos, y un correo por
   * cliente convertia el recordatorio en spam propio. El cliente nunca lo ve.
   */
  async sendMonthlyTargetDigest(params: {
    to: string;
    recipientName: string;
    year: number;
    month: number;
    expectedPct: number;
    clients: Array<{
      workspaceId: string;
      name: string;
      hasTarget: boolean;
      targetAmount: number;
      billed: number;
      progressPct: number;
      missingCount: number;
      motivos: string[];
    }>;
  }): Promise<void> {
    const { to, recipientName, year, month, expectedPct, clients } = params;
    if (!clients.length) return;

    const appUrl = "https://metrics.bakano.ec";
    const overviewUrl = `${appUrl}/app/pulso`;
    const firstName = recipientName.split(" ")[0];
    const money = (v: number) =>
      `$${v.toLocaleString("es-EC", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

    const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
    const periodo = `${MESES[month - 1]} ${year}`;

    const sinMeta = clients.filter((c) => !c.hasTarget).length;
    const fueraDeRitmo = clients.length - sinMeta;

    // El correo no lista 90 clientes: los 10 peores y un conteo del resto. Una
    // lista infinita no se lee, y el tablero ya tiene la lista completa.
    const MAX_FILAS = 10;
    const visibles = clients.slice(0, MAX_FILAS);
    const resto = clients.length - visibles.length;

    const filas = visibles
      .map((c) => {
        const acento = !c.hasTarget ? "#e6285c" : c.progressPct >= expectedPct ? "#16a34a" : "#f59e0b";
        const avance = c.hasTarget
          ? `${c.progressPct.toFixed(0)}% de ${money(c.targetAmount)}`
          : "sin meta definida";
        return `
                <tr>
                  <td style="padding:14px 18px;border-top:1px solid #e2e8f0;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td>
                          <a href="${appUrl}/app/workspaces/${c.workspaceId}/pulso" style="color:#0f172a;font-size:14px;font-weight:700;text-decoration:none;">${c.name}</a>
                          <p style="margin:3px 0 0;color:#64748b;font-size:12px;line-height:1.5;">${c.motivos.join(" · ")}</p>
                        </td>
                        <td align="right" style="white-space:nowrap;padding-left:12px;">
                          <p style="margin:0;color:${acento};font-size:13px;font-weight:800;">${avance}</p>
                          <p style="margin:3px 0 0;color:#94a3b8;font-size:11px;">${money(c.billed)} facturado</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>`;
      })
      .join("");

    const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Pulso de metas · ${periodo}</title>
</head>
<body style="margin:0;padding:0;background-color:#f0f2f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f2f5;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

          ${barraMarca()}
          <tr>
            <td style="background:linear-gradient(135deg,#191423 0%,#5c3070 100%);padding:34px 40px 30px;text-align:center;">
              <p style="margin:0 0 12px;color:#ffffff;font-size:21px;font-weight:800;letter-spacing:-0.5px;">Pulso interno</p>
              <h1 style="margin:0;color:#ffffff;font-size:23px;font-weight:700;line-height:1.3;">${clients.length === 1 ? "Un cliente necesita atencion" : `${clients.length} clientes necesitan atencion`}</h1>
              <p style="margin:10px 0 0;color:rgba(255,255,255,0.7);font-size:14px;">Hola ${firstName}, esto es lo de ${periodo}. El mes ya corrio el ${expectedPct.toFixed(0)}%.</p>
            </td>
          </tr>

          <tr>
            <td style="padding:26px 40px 0;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td width="50%" style="padding-right:6px;">
                    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff1f4;border-radius:12px;">
                      <tr><td style="padding:14px 16px;">
                        <p style="margin:0;color:#e6285c;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.6px;">Sin meta</p>
                        <p style="margin:4px 0 0;color:#0f172a;font-size:22px;font-weight:800;">${sinMeta}</p>
                      </td></tr>
                    </table>
                  </td>
                  <td width="50%" style="padding-left:6px;">
                    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffaf0;border-radius:12px;">
                      <tr><td style="padding:14px 16px;">
                        <p style="margin:0;color:#b45309;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.6px;">Fuera de ritmo</p>
                        <p style="margin:4px 0 0;color:#0f172a;font-size:22px;font-weight:800;">${fueraDeRitmo}</p>
                      </td></tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:24px 40px 0;">
              <p style="margin:0 0 10px;color:#94a3b8;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;">Tus clientes</p>
              <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                ${filas}
              </table>
              ${resto > 0 ? `<p style="margin:10px 0 0;color:#64748b;font-size:12px;">Y ${resto} clientes mas en el tablero.</p>` : ""}
            </td>
          </tr>

          <tr>
            <td style="padding:26px 40px 0;text-align:center;">
              <a href="${overviewUrl}" style="display:inline-block;background:#e6285c;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:10px;font-size:15px;font-weight:700;">
                Abrir el pulso de metas →
              </a>
            </td>
          </tr>

          <tr><td style="height:30px;"></td></tr>

          <tr>
            <td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #e2e8f0;text-align:center;">
              <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.6;">
                Correo interno del equipo Bakano. El cliente no recibe esta informacion.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const text =
      `Hola ${firstName}: ${clients.length} cliente(s) con la meta de ${periodo} en rojo ` +
      `(${sinMeta} sin meta, ${fueraDeRitmo} fuera de ritmo). ` +
      visibles.map((c) => `${c.name}: ${c.motivos.join(", ")}`).join(" | ") +
      ` Revisa el tablero en ${overviewUrl}`;

    await this.client.emails.send({
      from: this.from,
      to,
      replyTo: process.env.RESEND_REPLY_TO || "hola@bakano.ec",
      subject:
        clients.length === 1
          ? `${clients[0].name}: meta de ${periodo} | Bakano Metrics`
          : `${clients.length} clientes con la meta de ${periodo} en rojo | Bakano Metrics`,
      html,
      text,
      headers: {
        "X-Entity-Ref-ID": `monthly-target-digest-${year}-${month}`,
      },
    });
  }

  /**
   * Sends a "What's New" changelog email to a single user.
   */
  async sendChangelogEmail(params: {
    to: string;
    recipientName: string;
    version: { version: string; date: string; title: string; summary: string; changes: Array<{ type: string; text: string }> };
  }): Promise<void> {
    const { to, recipientName, version } = params;
    const firstName = recipientName.split(" ")[0];
    const appUrl = "https://metrics.bakano.ec";

    const typeConfig: Record<string, { label: string; color: string; bg: string; icon: string }> = {
      new: { label: "Nuevo", color: "#059669", bg: "#d1fae5", icon: "✦" },
      improved: { label: "Mejora", color: "#2563eb", bg: "#dbeafe", icon: "↑" },
      fix: { label: "Corrección", color: "#d97706", bg: "#fef3c7", icon: "✓" },
      removed: { label: "Eliminado", color: "#dc2626", bg: "#fee2e2", icon: "✕" },
    };

    const changeRows = version.changes.map((c) => {
      const cfg = typeConfig[c.type] || typeConfig["improved"];
      return `
        <tr>
          <td style="padding: 10px 0; vertical-align: top; border-bottom: 1px solid #f1f5f9;">
            <span style="display:inline-block;background:${cfg.bg};color:${cfg.color};font-size:10px;font-weight:800;padding:3px 8px;border-radius:20px;white-space:nowrap;letter-spacing:0.4px;text-transform:uppercase;">${cfg.label}</span>
          </td>
          <td style="padding: 10px 0 10px 14px; vertical-align: top; border-bottom: 1px solid #f1f5f9; font-size: 14px; color: #374151; line-height: 1.5;">
            ${c.text}
          </td>
        </tr>`;
    }).join("");

    const formattedDate = new Date(version.date + "T12:00:00").toLocaleDateString("es-EC", {
      day: "numeric", month: "long", year: "numeric", timeZone: "America/Guayaquil"
    });

    const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Novedades de Bakano Metrics v${version.version}</title>
</head>
<body style="margin:0;padding:0;background-color:#f0f2f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f2f5;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

          <!-- Header -->
          ${barraMarca()}
          <tr>
            <td style="background:linear-gradient(135deg,#0f1117 0%,#1e293b 100%);padding:32px 40px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <h1 style="margin:0 0 6px;color:#ffffff;font-size:22px;font-weight:800;letter-spacing:-0.3px;">¿Qué hay de nuevo? 🚀</h1>
                    <p style="margin:0;color:rgba(255,255,255,0.6);font-size:13px;">Versión ${version.version} · ${formattedDate}</p>
                  </td>
                  <td style="text-align:right;vertical-align:middle;">
                    <div style="background:rgba(255,255,255,0.12);border-radius:12px;padding:10px 18px;display:inline-block;">
                      <span style="color:#fff;font-size:20px;font-weight:900;letter-spacing:-1px;">v${version.version}</span>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding:32px 40px 0;">
              <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6;">
                Hola <strong>${firstName}</strong>,
              </p>
              <p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.7;">
                ${version.summary}
              </p>

              <!-- Version title banner -->
              <div style="background:linear-gradient(135deg,rgba(124,58,237,0.06) 0%,rgba(124,58,237,0.02) 100%);border:1.5px solid rgba(124,58,237,0.15);border-radius:12px;padding:16px 20px;margin-bottom:28px;">
                <p style="margin:0;font-size:15px;font-weight:700;color:#1e1b4b;">📋 ${version.title}</p>
              </div>
            </td>
          </tr>

          <!-- Changes list -->
          <tr>
            <td style="padding:0 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                ${changeRows}
              </table>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td style="padding:0 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#f8fafc;border-radius:12px;padding:24px;text-align:center;">
                    <p style="margin:0 0 16px;font-size:14px;color:#6b7280;">Accede a la plataforma para ver todas las novedades en acción</p>
                    <a href="${appUrl}" style="display:inline-block;background:linear-gradient(135deg,#0f1117 0%,#1e293b 100%);color:#ffffff;text-decoration:none;padding:13px 32px;border-radius:10px;font-size:14px;font-weight:700;letter-spacing:0.2px;">
                      Ir a Bakano Metrics →
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #e2e8f0;text-align:center;">
              <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.6;">
                Este correo fue enviado automáticamente por <strong>Bakano Metrics</strong> al publicar una nueva versión.<br/>
                Si tienes dudas sobre estas funcionalidades, contacta a tu gestor de cuenta.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    await this.client.emails.send({
      from: this.from,
      to,
      subject: `🚀 Novedades en Bakano Metrics · v${version.version} — ${version.title}`,
      html,
    });
  }

  async sendBrandProfileInvite(params: {
    to: string;
    recipientName?: string;
    workspaceName: string;
    brandProfileUrl: string;
    completionScore?: number;
  }): Promise<void> {
    const { to, recipientName, workspaceName, brandProfileUrl, completionScore = 0 } = params;
    const firstName = recipientName ? recipientName.split(' ')[0] : 'Cliente';
    const isReminder = completionScore > 0;

    const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

        <!-- Header -->
        ${barraMarca()}
        <tr>
          <td style="background:linear-gradient(135deg,#7c3aed 0%,#4f46e5 100%);padding:32px 40px;text-align:center;">
            <h1 style="margin:12px 0 0;font-size:24px;font-weight:800;color:#ffffff;">
              ${isReminder ? '⏰ Recordatorio: completa tu perfil' : '🚀 Un paso para empezar a vender más'}
            </h1>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px 40px 24px;">
            <p style="margin:0 0 20px;font-size:16px;color:#1e293b;">Hola <strong>${firstName}</strong>,</p>
            <p style="margin:0 0 20px;font-size:15px;color:#475569;line-height:1.7;">
              ${isReminder
        ? `Tu perfil de marca de <strong>${workspaceName}</strong> está al <strong>${completionScore}%</strong>. Mientras no esté completo, no podemos crear contenido que realmente venda para tu negocio.`
        : `Tu acceso a <strong>${workspaceName}</strong> en Bakano Metrics está listo. Antes de que empecemos a crear contenido para ti, necesitamos que completes tu <strong>Perfil de Marca</strong>.`
      }
            </p>

            <!-- Why section -->
            <div style="background:#faf5ff;border:1.5px solid #e9d5ff;border-radius:12px;padding:20px 24px;margin-bottom:24px;">
              <p style="margin:0 0 12px;font-size:13px;font-weight:700;color:#7c3aed;text-transform:uppercase;letter-spacing:0.5px;">¿Por qué es importante?</p>
              <table cellpadding="0" cellspacing="0">
                <tr><td style="padding:4px 0;color:#4c1d95;font-size:14px;">✅ &nbsp;La IA aprende cómo habla tu negocio</td></tr>
                <tr><td style="padding:4px 0;color:#4c1d95;font-size:14px;">✅ &nbsp;Creamos videos TOFU, MOFU y BOFU específicos para ti</td></tr>
                <tr><td style="padding:4px 0;color:#4c1d95;font-size:14px;">✅ &nbsp;El contenido genérico no vende — el tuyo, sí</td></tr>
                <tr><td style="padding:4px 0;color:#4c1d95;font-size:14px;">✅ &nbsp;Solo toma 10 minutos y es la base de todo</td></tr>
              </table>
            </div>

            <!-- CTA -->
            <div style="text-align:center;margin-bottom:24px;">
              <a href="${brandProfileUrl}" style="display:inline-block;background:linear-gradient(135deg,#7c3aed 0%,#4f46e5 100%);color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:10px;font-size:15px;font-weight:700;letter-spacing:0.2px;">
                Completar mi Perfil de Marca →
              </a>
              <p style="margin:12px 0 0;font-size:12px;color:#94a3b8;">Solo toma 10 minutos · Puedes guardarlo en cualquier momento</p>
            </div>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;padding:16px 40px;border-top:1px solid #e2e8f0;text-align:center;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">Enviado automáticamente por <strong>Bakano Metrics</strong>.<br/>Si tienes dudas, contáctanos en soporte@bakano.ec</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

    await this.client.emails.send({
      from: this.from,
      to,
      subject: isReminder
        ? `⏰ Recordatorio: tu perfil de marca de ${workspaceName} está incompleto`
        : `🚀 Completa tu Perfil de Marca — ${workspaceName}`,
      html,
    });
  }
  async sendContractEmail(params: {
    to: string;
    recipientName: string;
    pdfBuffer: Buffer;
  }): Promise<void> {
    try {
      await this.client.emails.send({
        from: "Bakano Legal <legal@bakano.ec>",
        to: params.to,
        bcc: ["dreyes@bakano.ec", "dquimi@bakano.ec"],
        subject: "Tu contrato de servicios con Bakano.ec",
        html: `
          <p>Hola ${params.recipientName},</p>
          <p>Adjunto encontrarás el contrato de prestación de servicios con Bakano.ec.</p>
          <p>Saludos cordiales,</p>
          <p>El equipo de Bakano.ec</p>
        `,
        attachments: [
          {
            filename: 'contrato_bakano.pdf',
            content: params.pdfBuffer,
          }
        ]
      });
    } catch (error) {
      console.error("ResendService - Failed to send contract email:", error);
    }
  }

  /**
   * Enlace para restablecer la contraseña.
   *
   * A diferencia de los demás correos, este SÍ propaga el error: si el envío
   * falla, quien lo pidió debe enterarse en vez de quedarse esperando un correo
   * que nunca va a llegar.
   */
  async sendPasswordResetEmail(params: {
    to: string;
    recipientName?: string;
    resetUrl: string;
    expiresInMinutes: number;
  }): Promise<void> {
    const { to, recipientName, resetUrl, expiresInMinutes } = params;
    const firstName = recipientName ? recipientName.split(" ")[0] : "Hola";

    const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

        ${barraMarca()}
        <tr>
          <td style="background:linear-gradient(135deg,#e6285c 0%,#85529c 100%);padding:32px 40px;text-align:center;">
            <h1 style="margin:12px 0 0;font-size:24px;font-weight:800;color:#ffffff;">Restablece tu contraseña</h1>
          </td>
        </tr>

        <tr>
          <td style="padding:32px 40px 24px;">
            <p style="margin:0 0 20px;font-size:16px;color:#1e293b;">${firstName},</p>
            <p style="margin:0 0 24px;font-size:15px;color:#475569;line-height:1.7;">
              Pediste restablecer la contraseña de tu cuenta en Bakano Metrics. Usa el botón de abajo para elegir una nueva.
            </p>

            <div style="text-align:center;margin-bottom:24px;">
              <a href="${resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#e6285c 0%,#85529c 100%);color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:10px;font-size:15px;font-weight:700;">
                Elegir contraseña nueva
              </a>
              <p style="margin:12px 0 0;font-size:12px;color:#94a3b8;">El enlace vence en ${expiresInMinutes} minutos y sirve una sola vez.</p>
            </div>

            <div style="background:#fef2f2;border:1.5px solid #fecaca;border-radius:12px;padding:16px 20px;margin-bottom:20px;">
              <p style="margin:0;font-size:14px;color:#991b1b;line-height:1.6;">
                <strong>¿No pediste esto?</strong> Ignora este correo: tu contraseña actual sigue funcionando y nadie puede cambiarla sin abrir este enlace.
              </p>
            </div>

            <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;word-break:break-all;">
              Si el botón no funciona, copia y pega esta dirección en tu navegador:<br/>${resetUrl}
            </p>
          </td>
        </tr>

        <tr>
          <td style="background:#f8fafc;padding:16px 40px;border-top:1px solid #e2e8f0;text-align:center;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">Enviado automáticamente por <strong>Bakano Metrics</strong>.<br/>Si tienes dudas, escríbenos a soporte@bakano.ec</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

    await this.client.emails.send({
      from: this.from,
      to,
      subject: "Restablece tu contraseña de Bakano Metrics",
      html,
    });
  }

  /** Codigo de un solo uso para vincular un chat de Telegram con la cuenta. */
  async sendTelegramLoginCode(params: {
    to: string;
    recipientName?: string;
    codigo: string;
    expiresInMinutes: number;
  }): Promise<void> {
    const { to, recipientName, codigo, expiresInMinutes } = params;
    const firstName = recipientName ? recipientName.split(" ")[0] : "Hola";

    const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

        ${barraMarca()}
        <tr>
          <td style="background:linear-gradient(135deg,#e6285c 0%,#85529c 100%);padding:32px 40px;text-align:center;">
            <h1 style="margin:12px 0 0;font-size:24px;font-weight:800;color:#ffffff;">Tu código para Telegram</h1>
          </td>
        </tr>

        <tr>
          <td style="padding:32px 40px 24px;">
            <p style="margin:0 0 20px;font-size:16px;color:#1e293b;">${firstName},</p>
            <p style="margin:0 0 24px;font-size:15px;color:#475569;line-height:1.7;">
              Escribe este código en el chat con <strong>@BakanoAgencyBot</strong> para conectar tu cuenta de metrics.bakano.ec.
            </p>

            <div style="text-align:center;margin-bottom:24px;">
              <p style="margin:0;display:inline-block;background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;padding:16px 32px;font-size:32px;font-weight:800;letter-spacing:8px;color:#1e293b;">${codigo}</p>
              <p style="margin:12px 0 0;font-size:12px;color:#94a3b8;">Vence en ${expiresInMinutes} minutos y sirve una sola vez.</p>
            </div>

            <div style="background:#fef2f2;border:1.5px solid #fecaca;border-radius:12px;padding:16px 20px;">
              <p style="margin:0;font-size:14px;color:#991b1b;line-height:1.6;">
                <strong>¿No fuiste tú?</strong> Ignora este correo y no compartas el código con nadie. Nadie del equipo de Bakano te lo va a pedir.
              </p>
            </div>
          </td>
        </tr>

        <tr>
          <td style="background:#f8fafc;padding:16px 40px;border-top:1px solid #e2e8f0;text-align:center;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">Enviado automáticamente por <strong>Bakano Metrics</strong>.<br/>Si tienes dudas, escríbenos a soporte@bakano.ec</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

    await this.client.emails.send({
      from: this.from,
      to,
      subject: `${codigo} es tu código para conectar Telegram con Bakano`,
      html,
    });
  }

  /**
   * Bakanology va incluido mientras el cliente siga con Bakano.
   *
   * Se puede mandar cuando haga falta: al dar el acceso, cuando alguien
   * pregunta si tiene que pagarlo, o para recordarle que lo tiene ahi.
   */
  async sendBakanologyIncluido(params: {
    to: string;
    recipientName?: string;
    workspaceName: string;
    academiaUrl: string;
  }): Promise<void> {
    const { to, recipientName, workspaceName, academiaUrl } = params;
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const firstName = recipientName ? esc(recipientName.split(" ")[0]) : "Hola";

    const cursos = [
      ["📈", "Estrategia Comercial", "Cómo se arma una oferta que la gente quiere comprar"],
      ["🎯", "ADN de la Venta", "Cómo hablarle a un cliente sin sonar a vendedor"],
      ["📊", "Marketing y Ventas", "Cómo leer tus números y decidir con ellos"],
    ]
      .map(
        ([emoji, titulo, detalle]) =>
          `<tr><td style="padding:9px 0;vertical-align:top;width:34px;font-size:19px;">${emoji}</td>` +
          `<td style="padding:9px 0;"><p style="margin:0;font-size:15px;font-weight:700;color:#1e293b;">${titulo}</p>` +
          `<p style="margin:2px 0 0;font-size:14px;color:#64748b;line-height:1.6;">${detalle}</p></td></tr>`
      )
      .join("");

    const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

        ${barraMarca()}
        <tr>
          <td style="background:linear-gradient(135deg,#e6285c 0%,#85529c 100%);padding:32px 40px;text-align:center;">
            <h1 style="margin:0;font-size:24px;font-weight:800;color:#ffffff;">Bakanology va incluido</h1>
            <p style="margin:10px 0 0;font-size:15px;color:#ffe4ec;">Mientras estés con Bakano, no pagas nada aparte</p>
          </td>
        </tr>

        <tr>
          <td style="padding:32px 40px 8px;">
            <p style="margin:0 0 16px;font-size:16px;color:#1e293b;">${firstName},</p>
            <p style="margin:0 0 20px;font-size:15px;color:#475569;line-height:1.7;">
              Con la suscripción de <strong>${esc(workspaceName)}</strong> tienes acceso a <strong>Bakanology</strong>,
              nuestra academia: lo mismo que estudiamos nosotros para hacer crecer negocios como el tuyo.
            </p>

            <div style="background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:12px;padding:18px 20px;margin-bottom:20px;">
              <p style="margin:0;font-size:15px;color:#166534;line-height:1.65;">
                <strong>No tienes que pagarla.</strong> Mientras tengas tu suscripción con Bakano,
                Bakanology va incluida: sin costo adicional y sin fecha de corte mientras sigas con nosotros.
              </p>
            </div>

            <table width="100%" cellpadding="0" cellspacing="0">${cursos}</table>
          </td>
        </tr>

        <tr>
          <td style="padding:24px 40px 32px;text-align:center;">
            <a href="${academiaUrl}" style="display:inline-block;background:linear-gradient(135deg,#e6285c 0%,#85529c 100%);color:#ffffff;text-decoration:none;padding:16px 40px;border-radius:12px;font-size:16px;font-weight:700;">Entrar a Bakanology</a>
            <p style="margin:14px 0 0;font-size:13px;color:#94a3b8;">Entras con este mismo correo. Si no recuerdas tu contraseña, la creas de nuevo desde ahí.</p>
          </td>
        </tr>

        <tr>
          <td style="background:#f8fafc;padding:16px 40px;border-top:1px solid #e2e8f0;text-align:center;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">Enviado por <strong>Bakano Metrics</strong>.<br/>Dudas sobre la academia: bakanology@bakanology.com</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

    await this.client.emails.send({
      from: this.from,
      to,
      subject: `${esc(workspaceName)}: Bakanology va incluido en tu suscripción`,
      html,
    });
  }

  /**
   * Como funciona la produccion: que es y cada cuanto se hace. Se manda una
   * vez a todos los clientes, porque la regla cambio de dos meses a seis y
   * nadie se entera de una regla que solo vive en la cabeza del equipo.
   */
  async sendReglaProduccion(params: {
    to: string;
    recipientName?: string;
    workspaceName: string;
    botUrl: string;
  }): Promise<void> {
    const { to, recipientName, workspaceName, botUrl } = params;
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const firstName = recipientName ? esc(recipientName.split(" ")[0]) : "Hola";

    const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

        ${barraMarca()}
        <tr>
          <td style="background:linear-gradient(135deg,#e6285c 0%,#85529c 100%);padding:32px 40px;text-align:center;">
            <h1 style="margin:0;font-size:24px;font-weight:800;color:#ffffff;">Tu producción, explicada</h1>
            <p style="margin:10px 0 0;font-size:15px;color:#ffe4ec;">Qué grabamos ese día y cada cuánto se hace</p>
          </td>
        </tr>

        <tr>
          <td style="padding:32px 40px 8px;">
            <p style="margin:0 0 16px;font-size:16px;color:#1e293b;">${firstName},</p>
            <p style="margin:0 0 20px;font-size:15px;color:#475569;line-height:1.7;">
              Queremos que quede clarísimo cómo funciona la producción de <strong>${esc(workspaceName)}</strong>,
              porque de ahí sale todo lo que publicamos después.
            </p>

            <div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;padding:20px;margin-bottom:16px;">
              <p style="margin:0 0 8px;font-size:15px;font-weight:700;color:#1e293b;">🎬 Qué es la producción</p>
              <p style="margin:0;font-size:14px;color:#475569;line-height:1.7;">
                Es la grabación en ambiente controlado para <strong>crear tu avatar</strong> y <strong>grabar tus productos</strong>.
                No es una sesión de videos sueltos: con ese material armamos todas tus piezas del periodo.
              </p>
            </div>

            <div style="background:#f3edf8;border:1.5px solid #d9c7e6;border-radius:12px;padding:20px;margin-bottom:16px;">
              <p style="margin:0 0 8px;font-size:15px;font-weight:700;color:#1e293b;">📅 Cada cuánto se hace</p>
              <p style="margin:0;font-size:14px;color:#475569;line-height:1.7;">
                <strong>Una producción cada 6 meses.</strong> En la práctica, para la mayoría es
                <strong>una vez al año</strong>: mientras el material siga sirviendo, no hace falta volver a grabar.
              </p>
            </div>

            <div style="background:#fdeef2;border:1.5px solid #f8c7d5;border-radius:12px;padding:20px;">
              <p style="margin:0 0 8px;font-size:15px;font-weight:700;color:#1e293b;">🎯 Y si necesitas grabar antes</p>
              <p style="margin:0;font-size:14px;color:#475569;line-height:1.7;">
                Se puede, cuando la estrategia lo pide: productos nuevos, un cambio de marca o si se acabó el contenido.
                Escríbele al bot, cuéntale por qué, y tu equipo lo habilita.
              </p>
            </div>
          </td>
        </tr>

        <tr>
          <td style="padding:24px 40px 32px;text-align:center;">
            <a href="${botUrl}" style="display:inline-block;background:linear-gradient(135deg,#e6285c 0%,#85529c 100%);color:#ffffff;text-decoration:none;padding:16px 40px;border-radius:12px;font-size:16px;font-weight:700;">Hablar con el bot</a>
            <p style="margin:14px 0 0;font-size:13px;color:#94a3b8;">Desde ahí agendas tu producción y ves cuándo te toca la siguiente.</p>
          </td>
        </tr>

        <tr>
          <td style="background:#f8fafc;padding:16px 40px;border-top:1px solid #e2e8f0;text-align:center;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">Enviado por <strong>Bakano Metrics</strong>.<br/>Si algo no te cuadra, escríbenos a soporte@bakano.ec</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

    await this.client.emails.send({
      from: this.from,
      to,
      subject: `${esc(workspaceName)}: cómo funciona tu producción y cada cuánto se hace`,
      html,
    });
  }

  /**
   * Presentacion del bot a los clientes que ya venian usando la plataforma.
   * La idea es una sola: lo que antes tenian que entrar a buscar a Metrics,
   * ahora lo pueden preguntar por chat.
   */
  async sendPresentacionBot(params: {
    to: string;
    recipientName?: string;
    workspaceName: string;
    botUrl: string;
    correoCliente: string;
  }): Promise<void> {
    const { to, recipientName, workspaceName, botUrl, correoCliente } = params;
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const firstName = recipientName ? esc(recipientName.split(" ")[0]) : "Hola";

    const puede = [
      ["🗓️", "Ver tus citas y moverlas o cancelarlas", "tu producción, tus sesiones y tus reuniones, sin escribirle a nadie"],
      ["📝", "Revisar tus guiones", "cuántos hay, cuáles están listos y pedir cambios contándoselos por chat"],
      ["🎬", "Agendar tu producción", "te muestra los horarios libres del equipo y la reserva al momento"],
      ["💵", "Registrar tu facturación del día", "le mandas el monto por chat y él lo sube a Metrics"],
      ["📣", "Saber qué estamos anunciando", "qué anuncios están activos y cuánto se ha invertido"],
      ["💬", "Hablar con tu equipo", "le cuentas lo que necesitas y se lo pasa a quien le toca, al momento"],
    ]
      .map(
        ([emoji, titulo, detalle]) =>
          `<tr><td style="padding:10px 0;vertical-align:top;width:34px;font-size:20px;">${emoji}</td>` +
          `<td style="padding:10px 0;"><p style="margin:0;font-size:15px;font-weight:700;color:#1e293b;">${titulo}</p>` +
          `<p style="margin:2px 0 0;font-size:14px;color:#64748b;line-height:1.6;">${detalle}</p></td></tr>`
      )
      .join("");

    const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

        ${barraMarca()}
        <tr>
          <td style="background:linear-gradient(135deg,#e6285c 0%,#85529c 100%);padding:32px 40px;text-align:center;">
            <h1 style="margin:0;font-size:24px;font-weight:800;color:#ffffff;">Ahora nos escribes por Telegram</h1>
            <p style="margin:10px 0 0;font-size:15px;color:#ffe4ec;">Sin entrar a la plataforma a buscar nada</p>
          </td>
        </tr>

        <tr>
          <td style="padding:32px 40px 8px;">
            <p style="margin:0 0 16px;font-size:16px;color:#1e293b;">${firstName},</p>
            <p style="margin:0 0 20px;font-size:15px;color:#475569;line-height:1.7;">
              Pusimos a trabajar un asistente de Bakano en Telegram para <strong>${esc(workspaceName)}</strong>.
              Le escribes como le escribirías a una persona y te resuelve ahí mismo lo que antes tenías
              que entrar a buscar a metrics.bakano.ec.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0">${puede}</table>
          </td>
        </tr>

        <tr>
          <td style="padding:8px 40px 24px;">
            <div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;padding:20px;">
              <p style="margin:0 0 10px;font-size:15px;font-weight:700;color:#1e293b;">Cómo entras, en 30 segundos</p>
              <p style="margin:0;font-size:14px;color:#475569;line-height:1.8;">
                1. Abres el chat con el botón de abajo.<br/>
                2. Le escribes tu correo: <strong>${esc(correoCliente)}</strong><br/>
                3. Te llega un código de 6 números a ese correo y lo escribes en el chat. Listo.
              </p>
            </div>
          </td>
        </tr>

        <tr>
          <td style="padding:0 40px 32px;text-align:center;">
            <a href="${botUrl}" style="display:inline-block;background:linear-gradient(135deg,#e6285c 0%,#85529c 100%);color:#ffffff;text-decoration:none;padding:16px 40px;border-radius:12px;font-size:16px;font-weight:700;">Abrir el chat en Telegram</a>
            <p style="margin:14px 0 0;font-size:13px;color:#94a3b8;">Metrics sigue igual de disponible: el chat es para no tener que entrar.</p>
          </td>
        </tr>

        <tr>
          <td style="background:#f8fafc;padding:16px 40px;border-top:1px solid #e2e8f0;text-align:center;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">Enviado por <strong>Bakano Metrics</strong>.<br/>Si algo no te cuadra, escríbenos a soporte@bakano.ec</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

    await this.client.emails.send({
      from: this.from,
      to,
      subject: `${esc(workspaceName)}: ahora puedes hablar con Bakano por Telegram`,
      html,
    });
  }

  /**
   * Arranque del onboarding: le dice al cliente que todo se maneja por el bot
   * de Telegram y le deja los links de las tres sesiones tecnicas.
   */
  async sendOnboardingBienvenida(params: {
    to: string[];
    recipientName?: string;
    workspaceName: string;
    botUrl: string;
    /** Con cuál correo se conecta al bot y a la plataforma. */
    correoCliente?: string;
    sesiones: { etiqueta: string; responsable: string; link: string; resumen: string }[];
  }): Promise<void> {
    const { to, recipientName, workspaceName, botUrl, correoCliente, sesiones } = params;
    if (!to.length) return;
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const firstName = recipientName ? recipientName.split(" ")[0] : "Hola";

    const filas = sesiones
      .map(
        (s, i) => `
      <tr><td style="padding:0 0 14px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;">
          <tr><td style="padding:16px 20px;">
            <p style="margin:0 0 4px;font-size:12px;font-weight:800;color:#e6285c;letter-spacing:1px;">PASO ${i + 1}</p>
            <p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#1e293b;">${esc(s.etiqueta)} · con ${esc(s.responsable)}</p>
            <p style="margin:0 0 12px;font-size:14px;color:#475569;line-height:1.6;">${esc(s.resumen)}</p>
            <a href="${s.link}" style="display:inline-block;background:#1e293b;color:#ffffff;text-decoration:none;padding:9px 18px;border-radius:8px;font-size:13px;font-weight:700;">Agendar esta sesión</a>
          </td></tr>
        </table>
      </td></tr>`
      )
      .join("");

    const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        ${barraMarca()}
        <tr>
          <td style="background:linear-gradient(135deg,#e6285c 0%,#85529c 100%);padding:32px 40px;text-align:center;">
            <h1 style="margin:0;font-size:24px;font-weight:800;color:#ffffff;">Arrancamos con ${esc(workspaceName)}</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px 8px;">
            <p style="margin:0 0 20px;font-size:16px;color:#1e293b;">${esc(firstName)},</p>
            <p style="margin:0 0 24px;font-size:15px;color:#475569;line-height:1.7;">
              Tu entorno <strong>${esc(workspaceName)}</strong> ya está activo. Todo tu proceso lo llevamos por <strong>Telegram</strong>: ahí agendas tus sesiones, resuelves dudas y ves en qué paso vas. Son 3 pasos y te toma 5 minutos dejarlo listo.
            </p>

            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
              <tr><td style="padding:0 0 14px;">
                <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;"><tr><td style="padding:16px 20px;">
                  <p style="margin:0 0 4px;font-size:12px;font-weight:800;color:#e6285c;letter-spacing:1px;">PASO 1</p>
                  <p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#1e293b;">Descarga Telegram</p>
                  <p style="margin:0 0 12px;font-size:14px;color:#475569;line-height:1.6;">Es gratis y funciona como WhatsApp. Si ya lo tienes, salta al paso 2.</p>
                  <a href="https://telegram.org/dl" style="display:inline-block;background:#1e293b;color:#ffffff;text-decoration:none;padding:9px 18px;border-radius:8px;font-size:13px;font-weight:700;">Descargar Telegram</a>
                  <p style="margin:10px 0 0;font-size:12px;color:#94a3b8;">iPhone: App Store · Android: Google Play · Computadora: telegram.org/dl</p>
                </td></tr></table>
              </td></tr>
              <tr><td style="padding:0 0 14px;">
                <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff5f8;border:1.5px solid #fbcfe8;border-radius:12px;"><tr><td style="padding:16px 20px;">
                  <p style="margin:0 0 4px;font-size:12px;font-weight:800;color:#e6285c;letter-spacing:1px;">PASO 2</p>
                  <p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#1e293b;">Escríbele a tu asistente de Bakano</p>
                  <p style="margin:0 0 12px;font-size:14px;color:#475569;line-height:1.6;">
                    Abre el chat y escribe <strong>/start</strong>. Te va a pedir tu correo${correoCliente ? ` (<strong>${esc(correoCliente)}</strong>)` : ""} y te manda un código para conectarte. Desde ahí te guía paso a paso.
                  </p>
                  <a href="${botUrl}" style="display:inline-block;background:linear-gradient(135deg,#e6285c 0%,#85529c 100%);color:#ffffff;text-decoration:none;padding:11px 24px;border-radius:8px;font-size:14px;font-weight:700;">Abrir el chat de Bakano</a>
                </td></tr></table>
              </td></tr>
              <tr><td style="padding:0 0 14px;">
                <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;"><tr><td style="padding:16px 20px;">
                  <p style="margin:0 0 4px;font-size:12px;font-weight:800;color:#e6285c;letter-spacing:1px;">PASO 3</p>
                  <p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#1e293b;">Entra a tu plataforma</p>
                  <p style="margin:0 0 12px;font-size:14px;color:#475569;line-height:1.6;">
                    En <strong>metrics.bakano.ec</strong> ves tus guiones, tus videos y tus métricas${correoCliente ? `. Entra con <strong>${esc(correoCliente)}</strong>` : ""}.
                  </p>
                  <a href="https://metrics.bakano.ec" style="display:inline-block;background:#1e293b;color:#ffffff;text-decoration:none;padding:9px 18px;border-radius:8px;font-size:13px;font-weight:700;">Ir a metrics.bakano.ec</a>
                </td></tr></table>
              </td></tr>
            </table>

            <p style="margin:20px 0 16px;font-size:15px;color:#1e293b;font-weight:700;">Tus tres sesiones de arranque</p>
            <p style="margin:0 0 14px;font-size:14px;color:#475569;line-height:1.7;">
              El asistente te las agenda por el chat, sin que salgas de Telegram. Si prefieres hacerlo tú, aquí están los links:
            </p>
            <table width="100%" cellpadding="0" cellspacing="0">${filas}</table>
          </td>
        </tr>
        <tr>
          <td style="background:#f8fafc;padding:16px 40px;border-top:1px solid #e2e8f0;text-align:center;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">Enviado automáticamente por <strong>${MARCA}</strong>.<br/>Si tienes dudas, escríbenos a soporte@bakano.ec</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    await this.client.emails.send({
      from: this.from,
      to,
      subject: `🚀 ${workspaceName}: así arrancamos tu onboarding con Bakano`,
      html,
    });
  }

  /** Un cliente escribio por Telegram: le llega directo a quien atiende el tema. */
  async sendSolicitudClienteEmail(params: {
    to: string[];
    tema: string;
    workspaceName: string;
    clienteNombre: string;
    clienteEmail?: string;
    telegramUsername?: string;
    mensaje: string;
    proximaProduccion?: string;
    asunto?: string;
    encabezado?: string;
  }): Promise<void> {
    const { to, tema, workspaceName, clienteNombre, clienteEmail, telegramUsername, mensaje, proximaProduccion, asunto, encabezado } = params;
    if (!to.length) return;
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const fila = (etiqueta: string, valor: string) =>
      `<tr><td style="padding:6px 0;font-size:13px;color:#94a3b8;width:140px;vertical-align:top;">${etiqueta}</td><td style="padding:6px 0;font-size:14px;color:#1e293b;">${valor}</td></tr>`;

    const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

        ${barraMarca()}
        <tr>
          <td style="background:linear-gradient(135deg,#e6285c 0%,#85529c 100%);padding:32px 40px;text-align:center;">
            <p style="margin:0;font-size:13px;font-weight:700;color:rgba(255,255,255,0.75);letter-spacing:2px;text-transform:uppercase;">Telegram · ${esc(tema)}</p>
            <h1 style="margin:12px 0 0;font-size:24px;font-weight:800;color:#ffffff;">${esc(encabezado ?? `${workspaceName} te escribió`)}</h1>
          </td>
        </tr>

        <tr>
          <td style="padding:32px 40px 24px;">
            <div style="background:#f8fafc;border-left:4px solid #e6285c;border-radius:8px;padding:16px 20px;margin-bottom:24px;">
              <p style="margin:0;font-size:15px;color:#1e293b;line-height:1.7;white-space:pre-wrap;">${esc(mensaje)}</p>
            </div>
            <table width="100%" cellpadding="0" cellspacing="0">
              ${fila("Cliente", esc(clienteNombre))}
              ${clienteEmail ? fila("Correo", esc(clienteEmail)) : ""}
              ${telegramUsername ? fila("Telegram", `@${esc(telegramUsername)}`) : ""}
              ${proximaProduccion ? fila("Próxima producción", esc(proximaProduccion)) : ""}
            </table>
            <p style="margin:24px 0 0;font-size:14px;color:#475569;line-height:1.6;">
              El cliente ya sabe que tú lo atiendes. Contáctalo lo antes posible.
            </p>
          </td>
        </tr>

        <tr>
          <td style="background:#f8fafc;padding:16px 40px;border-top:1px solid #e2e8f0;text-align:center;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">Enviado automáticamente por <strong>@BakanoAgencyBot</strong>.</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

    await this.client.emails.send({
      from: this.from,
      to,
      replyTo: clienteEmail,
      subject: asunto ?? `${workspaceName} escribió por Telegram (${tema})`,
      html,
    });
  }

  /**
   * Aviso de que hay una planificacion lista para aprobar.
   *
   * Devuelve el id del proveedor para poder cruzarlo despues con los eventos
   * de apertura y clic que manda el webhook de Resend.
   */
  async sendPlanningReadyEmail(params: {
    to: string[];
    cliente: string;
    enlace: string;
    totalVideos: number;
  }): Promise<string | undefined> {
    const { to, cliente, enlace, totalVideos } = params;

    const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        ${barraMarca()}
        <tr>
          <td style="background:linear-gradient(135deg,#e6285c 0%,#85529c 100%);padding:32px 40px;text-align:center;">
            <h1 style="margin:12px 0 0;font-size:24px;font-weight:800;color:#ffffff;">Tu planificacion esta lista</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px 24px;">
            <p style="margin:0 0 16px;font-size:16px;color:#1e293b;">Hola <strong>${cliente}</strong>,</p>
            <p style="margin:0 0 24px;font-size:15px;color:#475569;line-height:1.7;">
              Preparamos <strong>${totalVideos} videos</strong> para el proximo mes. Necesitamos que los revises y los apruebes para empezar a grabar.
            </p>
            <div style="text-align:center;margin-bottom:24px;">
              <a href="${enlace}" style="display:inline-block;background:linear-gradient(135deg,#e6285c 0%,#85529c 100%);color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:10px;font-size:15px;font-weight:700;">
                Revisar y aprobar
              </a>
            </div>
            <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;word-break:break-all;">
              Si el boton no funciona, copia esta direccion:<br/>${enlace}
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#f8fafc;padding:16px 40px;border-top:1px solid #e2e8f0;text-align:center;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">Enviado por <strong>Bakano Metrics</strong>. Dudas: soporte@bakano.ec</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const { data } = await this.client.emails.send({
      from: this.from,
      to,
      subject: `${cliente}: tu planificacion de ${totalVideos} videos esta lista`,
      html,
    });

    return data?.id;
  }

  /**
   * Aviso al PM/Content Manager: un editor marco un video como EDITADO y
   * espera revision. El link lleva directo a la vista de revision.
   */
  async sendVideoReadyForReview(params: {
    to: string[];
    workspaceName: string;
    numero: number;
    tema: string;
    editorNombre?: string;
    driveLink?: string;
  }): Promise<void> {
    const { to, workspaceName, numero, tema, editorNombre, driveLink } = params;
    if (!to.length) return;
    const reviewUrl = "https://metrics.bakano.ec/app/workspaces/review-videos-from-planning";
    const num = String(numero).padStart(2, "0");

    const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Video listo para revisión</title></head>
<body style="margin:0;padding:0;background-color:#f0f2f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f2f5;padding:40px 16px;">
    <tr><td align="center">
      <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">
        ${barraMarca()}
        <tr>
          <td style="background:linear-gradient(135deg,#191423 0%,#2b2438 100%);padding:32px 40px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;line-height:1.3;">Video listo para revisión</h1>
            <p style="margin:8px 0 0;color:rgba(255,255,255,0.65);font-size:14px;">${editorNombre ? `${editorNombre} terminó la edición` : "La edición está terminada"} y espera tu visto bueno.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 40px 8px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#faf9fc;border:1px solid #eceaf1;border-radius:12px;">
              <tr><td style="padding:16px 20px;">
                <p style="margin:0 0 4px;font-size:11px;font-weight:800;letter-spacing:0.08em;color:#6b7280;text-transform:uppercase;">${workspaceName}</p>
                <p style="margin:0;font-size:16px;font-weight:700;color:#191423;">#${num} · ${tema}</p>
              </td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px 8px;text-align:center;">
            <a href="${reviewUrl}" style="display:inline-block;background:#e6285c;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;padding:13px 28px;border-radius:12px;">Revisar ahora</a>
          </td>
        </tr>
        ${driveLink ? `<tr><td style="padding:4px 40px 8px;text-align:center;"><a href="${driveLink}" style="font-size:12.5px;color:#1ea362;font-weight:700;text-decoration:none;">Ver archivo maestro en Drive</a></td></tr>` : ""}
        <tr>
          <td style="padding:16px 40px 30px;text-align:center;">
            <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.5;">Si lo apruebas queda listo para publicar; si lo rechazas, vuelve a la cola del editor con tu motivo.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    await this.client.emails.send({
      from: this.from,
      to,
      subject: `Revisión pendiente · ${workspaceName} #${num} ${tema}`,
      html,
    });
  }

  /**
   * Aviso al equipo interno del entorno: una produccion entro, se movio o se
   * cancelo desde el link de agendamiento del CRM. `sin_entorno` va a los
   * superadmins porque nadie mas puede resolverlo.
   */
  async sendProduccionCrmEmail(params: {
    to: string[];
    tipo: "creada" | "reprogramada" | "cancelada" | "sin_entorno";
    workspaceName: string;
    workspaceId?: string;
    fecha: string;
    fechaAnterior?: string;
    titulo: string;
    contacto?: string;
    calendario?: string;
    conservada?: boolean;
  }): Promise<void> {
    const { to, tipo, workspaceName, workspaceId, fecha, fechaAnterior, titulo, contacto, calendario, conservada } = params;
    if (!to.length) return;

    const copy = {
      creada: {
        asunto: `Producción agendada · ${workspaceName} · ${fecha}`,
        titulo: "Nueva producción agendada",
        bajada: `${workspaceName} reservó su día de grabación desde el CRM. Ya está en el Planificador.`,
        color: "#1ea362",
      },
      reprogramada: {
        asunto: `Producción reprogramada · ${workspaceName} · ${fecha}`,
        titulo: "Producción reprogramada",
        bajada: `${workspaceName} movió su producción en el CRM${fechaAnterior ? ` (antes: ${fechaAnterior})` : ""}. El Planificador ya tiene la fecha nueva.`,
        color: "#f59e0b",
      },
      cancelada: {
        asunto: `Producción cancelada · ${workspaceName} · ${fecha}`,
        titulo: "Producción cancelada",
        bajada: conservada
          ? `${workspaceName} canceló su producción en el CRM. Como ya tenía guiones cargados, quedó marcada como CANCELADA en el Planificador para que decidan qué hacer.`
          : `${workspaceName} canceló su producción en el CRM. Se quitó del Planificador.`,
        color: "#e6285c",
      },
      sin_entorno: {
        asunto: `Producción del CRM sin entorno · ${fecha}`,
        titulo: "Producción sin entorno asignado",
        bajada: "Llegó una cita de producción desde el CRM y no coincide con ningún entorno de Metrics. Hay que agendarla a mano o corregir el nombre de empresa del contacto en el CRM.",
        color: "#e6285c",
      },
    }[tipo];

    const url = workspaceId
      ? `https://metrics.bakano.ec/app/workspaces/${workspaceId}/planning`
      : "https://metrics.bakano.ec/app/planning";

    const fila = (label: string, valor?: string) =>
      valor
        ? `<tr><td style="padding:6px 0;font-size:12px;color:#6b7280;width:120px;">${label}</td><td style="padding:6px 0;font-size:13.5px;color:#191423;font-weight:600;">${valor}</td></tr>`
        : "";

    const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${copy.titulo}</title></head>
<body style="margin:0;padding:0;background-color:#f0f2f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f2f5;padding:40px 16px;">
    <tr><td align="center">
      <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">
        ${barraMarca()}
        <tr>
          <td style="background:linear-gradient(135deg,#191423 0%,#2b2438 100%);padding:32px 40px;text-align:center;">
            <span style="display:inline-block;background:${copy.color};color:#fff;font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;padding:4px 10px;border-radius:999px;margin-bottom:10px;">Planificador · CRM</span>
            <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;line-height:1.3;">${copy.titulo}</h1>
            <p style="margin:8px 0 0;color:rgba(255,255,255,0.65);font-size:14px;line-height:1.5;">${copy.bajada}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 40px 8px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#faf9fc;border:1px solid #eceaf1;border-radius:12px;">
              <tr><td style="padding:16px 20px;">
                <p style="margin:0 0 10px;font-size:11px;font-weight:800;letter-spacing:0.08em;color:#6b7280;text-transform:uppercase;">${workspaceName}</p>
                <table cellpadding="0" cellspacing="0" width="100%">
                  ${fila("Producción", titulo)}
                  ${fila("Fecha (Ecuador)", fecha)}
                  ${fila("Antes", fechaAnterior)}
                  ${fila("Calendario", calendario)}
                  ${fila("Contacto", contacto)}
                </table>
              </td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px 8px;text-align:center;">
            <a href="${url}" style="display:inline-block;background:#e6285c;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;padding:13px 28px;border-radius:12px;">Abrir el Planificador</a>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 40px 30px;text-align:center;">
            <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.5;">La fecha y hora se sincronizan desde el CRM: si hay que moverla, muévela allá.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    await this.client.emails.send({ from: this.from, to, subject: copy.asunto, html });
  }

  /**
   * URGENTE para contenido: el cliente rechazo guiones y hay que corregirlos
   * antes de la fecha limite (48 h antes de la produccion).
   */
  async sendGuionesRechazadosEmail(params: {
    to: string[];
    workspaceName: string;
    workspaceId: string;
    entryId: string;
    clienteNombre?: string;
    fechaProduccion?: string;
    limiteCorrecciones?: string;
    horasRestantes?: number | null;
    rechazados: { numero: number; tema: string; motivo?: string }[];
    totalGuiones: number;
  }): Promise<void> {
    const { to, workspaceName, workspaceId, entryId, clienteNombre, fechaProduccion, limiteCorrecciones, horasRestantes, rechazados, totalGuiones } = params;
    if (!to.length || !rechazados.length) return;

    const url = `https://metrics.bakano.ec/app/workspaces/${workspaceId}/planning/${entryId}/video-planning`;
    const urgencia =
      horasRestantes === null || horasRestantes === undefined
        ? "Corrígelos cuanto antes."
        : horasRestantes <= 0
          ? "El plazo de correcciones ya venció: coordina con el productor antes de grabar."
          : horasRestantes <= 24
            ? `Quedan menos de ${Math.max(1, Math.ceil(horasRestantes))} horas para el límite de correcciones.`
            : `Quedan ${Math.floor(horasRestantes / 24)} día(s) y ${Math.floor(horasRestantes % 24)} h para el límite de correcciones.`;

    const filas = rechazados
      .map(
        (r) => `
          <tr>
            <td style="padding:10px 12px;border-bottom:1px solid #f1eef4;font-size:13px;font-weight:800;color:#e6285c;white-space:nowrap;vertical-align:top;">#${String(r.numero).padStart(2, "0")}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #f1eef4;font-size:13.5px;color:#191423;vertical-align:top;">
              <strong>${r.tema}</strong>
              ${r.motivo ? `<div style="margin-top:4px;font-size:12.5px;color:#6b7280;font-style:italic;">“${r.motivo}”</div>` : `<div style="margin-top:4px;font-size:12px;color:#9ca3af;">Sin motivo indicado</div>`}
            </td>
          </tr>`
      )
      .join("");

    const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Guiones rechazados</title></head>
<body style="margin:0;padding:0;background-color:#f0f2f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f2f5;padding:40px 16px;">
    <tr><td align="center">
      <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">
        ${barraMarca()}
        <tr>
          <td style="background:linear-gradient(135deg,#7f1d1d 0%,#e6285c 100%);padding:32px 40px;text-align:center;">
            <span style="display:inline-block;background:#ffffff;color:#e6285c;font-size:11px;font-weight:900;letter-spacing:0.1em;text-transform:uppercase;padding:4px 12px;border-radius:999px;margin-bottom:10px;">Urgente</span>
            <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;line-height:1.3;">${workspaceName} rechazó ${rechazados.length} de ${totalGuiones} guiones</h1>
            <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:14px;line-height:1.5;">${clienteNombre ? `${clienteNombre} revisó la planificación. ` : ""}${urgencia}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 40px 8px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff5f5;border:1px solid #fecaca;border-radius:12px;">
              <tr><td style="padding:14px 20px;">
                ${fechaProduccion ? `<p style="margin:0 0 4px;font-size:13px;color:#7f1d1d;"><strong>Producción:</strong> ${fechaProduccion} (hora Ecuador)</p>` : ""}
                ${limiteCorrecciones ? `<p style="margin:0;font-size:13px;color:#7f1d1d;"><strong>Límite para correcciones:</strong> ${limiteCorrecciones}</p>` : ""}
              </td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 40px 8px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eceaf1;border-radius:12px;overflow:hidden;">
              ${filas}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px 8px;text-align:center;">
            <a href="${url}" style="display:inline-block;background:#e6285c;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;padding:13px 28px;border-radius:12px;">Corregir los guiones</a>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 40px 30px;text-align:center;">
            <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.5;">Cuando estén corregidos, reabre la planificación y vuelve a notificar al cliente para que apruebe.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    await this.client.emails.send({
      from: this.from,
      to,
      subject: `🚨 URGENTE · ${workspaceName} rechazó ${rechazados.length} guion${rechazados.length === 1 ? "" : "es"}${horasRestantes !== null && horasRestantes !== undefined && horasRestantes > 0 ? ` · ${Math.ceil(horasRestantes)} h para corregir` : ""}`,
      html,
    });
  }
  /**
   * Circuito de REVISION DE VIDEOS terminados. Mismo aviso que sale por
   * WhatsApp, en su version correo: el tipo decide el texto porque no es lo
   * mismo estrenar el aviso, insistir, que confirmar que ya reviso.
   */
  async sendVideosParaRevisionEmail(params: {
    to: string[];
    cliente: string;
    enlace: string;
    videosListos: number;
    tipo: "esperando_revision" | "recordatorio" | "revisado";
  }): Promise<string | undefined> {
    const { to, cliente, enlace, videosListos, tipo } = params;

    const textos = {
      esperando_revision: {
        titulo: "Tus videos estan listos",
        cuerpo: `Terminamos la edicion de <strong>${videosListos} videos</strong>. Necesitamos que los revises y nos des tu visto bueno para poder publicarlos.`,
        boton: "Revisar mis videos",
        asunto: `${cliente}: tus ${videosListos} videos estan listos para tu revision`,
      },
      recordatorio: {
        titulo: "Tus videos siguen esperando",
        cuerpo: `Tienes <strong>${videosListos} videos</strong> editados esperando tu revision. Sin tu visto bueno no podemos publicarlos.`,
        boton: "Revisar ahora",
        asunto: `Recordatorio: tus ${videosListos} videos esperan tu revision`,
      },
      revisado: {
        titulo: "Recibimos tu revision",
        cuerpo: `Gracias por revisar tus <strong>${videosListos} videos</strong>. Ya estamos procesando tu respuesta para continuar con la publicacion.`,
        boton: "Ver mis videos",
        asunto: `${cliente}: tu revision fue recibida`,
      },
    }[tipo];

    const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        ${barraMarca()}
        <tr>
          <td style="background:linear-gradient(135deg,#e6285c 0%,#85529c 100%);padding:32px 40px;text-align:center;">
            <h1 style="margin:12px 0 0;font-size:24px;font-weight:800;color:#ffffff;">${textos.titulo}</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px 24px;">
            <p style="margin:0 0 16px;font-size:16px;color:#1e293b;">Hola <strong>${cliente}</strong>,</p>
            <p style="margin:0 0 24px;font-size:15px;color:#475569;line-height:1.7;">${textos.cuerpo}</p>
            <div style="text-align:center;margin-bottom:24px;">
              <a href="${enlace}" style="display:inline-block;background:linear-gradient(135deg,#e6285c 0%,#85529c 100%);color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:10px;font-size:15px;font-weight:700;">
                ${textos.boton}
              </a>
            </div>
            <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;word-break:break-all;">
              Si el boton no funciona, copia esta direccion:<br/>${enlace}
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#f8fafc;padding:16px 40px;border-top:1px solid #e2e8f0;text-align:center;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">Enviado por <strong>Bakano Metrics</strong>. Dudas: soporte@bakano.ec</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const { data } = await this.client.emails.send({
      from: this.from,
      to,
      subject: textos.asunto,
      html,
    });

    return data?.id;
  }
}

export const resendService = new ResendService();

