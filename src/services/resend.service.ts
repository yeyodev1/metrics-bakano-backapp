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
    const appUrl = process.env.APP_URL || 'https://metrics.bakano.ec';
    const firstName = recipientName ? recipientName.split(' ')[0] : 'nuevo integrante';

    const roleLabels: Record<string, string> = {
      director: 'Director', estratega: 'Estratega', content_manager: 'Content Manager',
      account_manager: 'Account Manager', community_manager: 'Community Manager',
      productor: 'Productor', editor: 'Editor', disenador: 'Diseñador',
      copywriter: 'Copywriter', analista: 'Analista', desarrollador: 'Desarrollador',
    };

    const userTypeLabel  = isInternal ? 'Equipo Interno' : 'Cliente';
    const userTypeColor  = isInternal ? '#6d28d9' : '#0f766e';
    const userTypeBg     = isInternal ? '#f5f3ff' : '#f0fdfa';
    const roleLabel      = internalRole ? roleLabels[internalRole] || internalRole : null;

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
}

export const resendService = new ResendService();
