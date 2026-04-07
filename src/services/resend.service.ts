import { Resend } from "resend";

interface SurveyInvitationParams {
  to: string;
  recipientName: string;
  senderName: string;
  surveyTitle: string;
  surveyLink: string;
  customMessage?: string;
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
  private get client(): Resend {
    return new Resend(process.env.RESEND_API_KEY);
  }

  private get from(): string {
    return process.env.RESEND_FROM_EMAIL || "Bakano Ads <noreply@bakano.ec>";
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
  <title>Bienvenido/a a Bakano Ads</title>
</head>
<body style="margin:0;padding:0;background-color:#f0f2f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f2f5;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#0f1117 0%,#1e293b 100%);padding:36px 40px 32px;text-align:center;">
              <p style="margin:0 0 20px;color:#ffffff;font-size:22px;font-weight:800;letter-spacing:-0.5px;">Bakano Ads</p>
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
                      Ingresar a Bakano Ads →
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
                Este correo fue generado automáticamente por <strong>Bakano Ads</strong>.<br/>
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
      subject: `¡Bienvenido/a a Bakano Ads! Tus credenciales de acceso`,
      html,
    });
  }

  async sendSurveyInvitation(params: SurveyInvitationParams): Promise<void> {
    const { to, recipientName, senderName, surveyTitle, surveyLink, customMessage } = params;

    const greeting = recipientName ? `Hola, ${recipientName}` : "Hola";

    const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Encuesta: ${surveyTitle}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background-color:#0f1117;padding:28px 40px;">
              <p style="margin:0;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.3px;">Bakano Ads</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px;">
              <p style="margin:0 0 16px;color:#1a1a2e;font-size:22px;font-weight:600;">${greeting}</p>

              <p style="margin:0 0 16px;color:#444;font-size:15px;line-height:1.6;">
                <strong>${senderName}</strong> te ha enviado una encuesta para que la completes.
              </p>

              ${customMessage ? `
              <div style="background-color:#f8f9fa;border-left:4px solid #0f1117;padding:14px 18px;margin:0 0 24px;border-radius:0 6px 6px 0;">
                <p style="margin:0;color:#555;font-size:14px;line-height:1.6;font-style:italic;">${customMessage}</p>
              </div>
              ` : ""}

              <div style="background-color:#f8f9fa;border-radius:8px;padding:20px 24px;margin:0 0 28px;">
                <p style="margin:0 0 4px;color:#888;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Encuesta</p>
                <p style="margin:0;color:#1a1a2e;font-size:17px;font-weight:600;">${surveyTitle}</p>
              </div>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding:8px 0 32px;">
                    <a href="${surveyLink}"
                       style="display:inline-block;background-color:#0f1117;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:14px 36px;border-radius:6px;letter-spacing:0.2px;">
                      Responder encuesta →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0;color:#888;font-size:13px;line-height:1.6;text-align:center;">
                Necesitarás iniciar sesión con tu cuenta para acceder a la encuesta.<br/>
                Solo podrás responder <strong>una vez</strong>; tus respuestas no podrán modificarse después.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#f8f9fa;padding:20px 40px;border-top:1px solid #eee;">
              <p style="margin:0;color:#aaa;font-size:12px;text-align:center;">
                Este correo fue enviado por Bakano Ads · Si tienes dudas, contacta a tu gestor de cuenta.
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
      subject: `Encuesta pendiente: ${surveyTitle}`,
      html,
    });
  }

  async sendMeetingInviteEmail(params: {
    to: string;
    contactName: string;
    pmName: string;
    workspaceName: string;
    meetingDate: Date;
    agenda?: string;
    meetingLink?: string;
  }): Promise<void> {
    const { to, contactName, pmName, workspaceName, meetingDate, agenda, meetingLink } = params;
    const firstName = contactName.split(' ')[0];

    const mStr = meetingDate.toISOString().split('T')[0];
    const forceDate = new Date(`${mStr}T12:00:00Z`);
    const dateLabel = forceDate.toLocaleDateString('es-EC', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      timeZone: 'UTC',
    });

    const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reunión de performance agendada</title>
</head>
<body style="margin:0;padding:0;background-color:#f0f2f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f2f5;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#0f1117 0%,#1e293b 100%);padding:36px 40px 32px;text-align:center;">
              <p style="margin:0 0 16px;color:#ffffff;font-size:22px;font-weight:800;letter-spacing:-0.5px;">Bakano Ads</p>
              <div style="display:inline-block;width:64px;height:64px;background:rgba(255,255,255,0.08);border-radius:50%;text-align:center;line-height:64px;font-size:30px;margin-bottom:16px;">📅</div>
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;line-height:1.3;">Reunión de performance agendada</h1>
              <p style="margin:8px 0 0;color:rgba(255,255,255,0.65);font-size:14px;">Hola ${firstName}, tienes una reunión programada</p>
            </td>
          </tr>

          <!-- Meeting details card -->
          <tr>
            <td style="padding:32px 40px 0;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                <tr>
                  <td style="padding:10px 20px;background:#e2e8f0;">
                    <p style="margin:0;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;">Detalles de la reunión</p>
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
                          <p style="margin:0 0 3px;color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Fecha</p>
                          <p style="margin:0;color:#0f172a;font-size:15px;font-weight:600;text-transform:capitalize;">${dateLabel}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="border-top:1px solid #e2e8f0;padding-top:14px;">
                          <p style="margin:0 0 3px;color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Coordinado por</p>
                          <p style="margin:0;color:#0f172a;font-size:15px;font-weight:600;">${pmName}</p>
                        </td>
                      </tr>
                      ${agenda ? `
                      <tr>
                        <td style="border-top:1px solid #e2e8f0;padding-top:14px;">
                          <p style="margin:0 0 6px;color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Agenda</p>
                          <p style="margin:0;color:#374151;font-size:14px;line-height:1.6;">${agenda}</p>
                        </td>
                      </tr>` : ''}
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA -->
          ${meetingLink ? `
          <tr>
            <td style="padding:24px 40px 0;text-align:center;">
              <a href="${meetingLink}"
                 style="display:inline-block;background:linear-gradient(135deg,#0f1117 0%,#1e293b 100%);color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;padding:14px 36px;border-radius:10px;letter-spacing:0.2px;box-shadow:0 4px 14px rgba(15,17,23,0.25);">
                Unirse a la reunión →
              </a>
            </td>
          </tr>` : ''}

          <!-- Body -->
          <tr>
            <td style="padding:28px 40px 32px;">
              <p style="margin:0;color:#374151;font-size:14px;line-height:1.7;text-align:center;">
                Nuestro equipo se pondrá en contacto contigo para confirmar cualquier detalle adicional.<br/>
                Si tienes alguna pregunta, responde directamente a este correo.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #e2e8f0;text-align:center;">
              <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.6;">
                Este correo fue enviado por <strong>Bakano Ads</strong> en nombre de ${pmName}.<br/>
                Si no esperabas este correo, por favor ignóralo.
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
      subject: `📅 Reunión de performance agendada · ${workspaceName}`,
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
          <tr>
            <td style="background:linear-gradient(135deg,#0f1117 0%,#1e293b 100%);padding:36px 40px 32px;text-align:center;">
              <p style="margin:0 0 16px;color:#ffffff;font-size:22px;font-weight:800;letter-spacing:-0.5px;">Bakano Ads</p>
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
                Este correo fue generado automáticamente por <strong>Bakano Ads</strong>.<br/>
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
          <tr>
            <td style="background:linear-gradient(135deg,#0f1117 0%,#1e293b 100%);padding:36px 40px 32px;text-align:center;">
              <p style="margin:0 0 16px;color:#ffffff;font-size:22px;font-weight:800;letter-spacing:-0.5px;">Bakano Ads</p>
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
                Este correo fue generado automáticamente por <strong>Bakano Ads</strong>.<br/>
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
          <tr>
            <td style="background:linear-gradient(135deg,#0f1117 0%,#1e293b 100%);padding:36px 40px 32px;text-align:center;">
              <p style="margin:0 0 16px;color:#ffffff;font-size:22px;font-weight:800;letter-spacing:-0.5px;">Bakano Ads</p>
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
                Este correo fue generado automáticamente por <strong>Bakano Ads</strong>.<br/>
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
          <tr>
            <td style="background:linear-gradient(135deg,#0f1117 0%,#1e293b 100%);padding:36px 40px 32px;text-align:center;">
              <p style="margin:0 0 16px;color:#ffffff;font-size:22px;font-weight:800;letter-spacing:-0.5px;">Bakano Ads</p>
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
                Este correo fue generado automáticamente por <strong>Bakano Ads</strong>.<br/>
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
      ? `✅ Facturación confirmada · ${workspaceName}`
      : `⏰ Recordatorio: registra tu facturación de hoy · ${workspaceName}`;

    await this.client.emails.send({
      from: this.from,
      to,
      subject,
      html,
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
      new:      { label: "Nuevo",    color: "#059669", bg: "#d1fae5", icon: "✦" },
      improved: { label: "Mejora",   color: "#2563eb", bg: "#dbeafe", icon: "↑" },
      fix:      { label: "Corrección", color: "#d97706", bg: "#fef3c7", icon: "✓" },
      removed:  { label: "Eliminado", color: "#dc2626", bg: "#fee2e2", icon: "✕" },
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
  <title>Novedades de Bakano Ads v${version.version}</title>
</head>
<body style="margin:0;padding:0;background-color:#f0f2f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f2f5;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#0f1117 0%,#1e293b 100%);padding:32px 40px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <p style="margin:0 0 8px;color:rgba(255,255,255,0.55);font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Bakano Ads Platform</p>
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
                      Ir a Bakano Ads →
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
                Este correo fue enviado automáticamente por <strong>Bakano Ads</strong> al publicar una nueva versión.<br/>
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
      subject: `🚀 Novedades en Bakano Ads · v${version.version} — ${version.title}`,
      html,
    });
  }
}

export const resendService = new ResendService();

