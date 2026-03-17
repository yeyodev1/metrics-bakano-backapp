import { Resend } from "resend";

interface SurveyInvitationParams {
  to: string;
  recipientName: string;
  senderName: string;
  surveyTitle: string;
  surveyLink: string;
  customMessage?: string;
}

export class ResendService {
  // Lazy getter — read env at call time, not at module import time
  private get client(): Resend {
    return new Resend(process.env.RESEND_API_KEY);
  }

  private get from(): string {
    return process.env.RESEND_FROM_EMAIL || "Bakano Ads <noreply@bakano.ec>";
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
