import axios from "axios";

const API = "https://slack.com/api";

/**
 * Avisos internos al equipo en Slack. El cliente habla por Telegram; el equipo
 * se entera por Slack (con @mencion a quien atiende) y por correo.
 *
 * A las personas se las encuentra por su correo @bakano.ec
 * (users.lookupByEmail), asi que nadie tiene que mantener IDs de Slack.
 */
class SlackService {
  private ids = new Map<string, string | null>();

  private get headers() {
    return { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, "content-type": "application/json; charset=utf-8" };
  }

  /** Canal de avisos del equipo: uno propio si se configura, si no el de soporte. */
  canalEquipo(): string | undefined {
    return process.env.SLACK_EQUIPO_CHANNEL_ID || process.env.SLACK_SOPORTE_CHANNEL_ID;
  }

  configurado(): boolean {
    return Boolean(process.env.SLACK_BOT_TOKEN && this.canalEquipo());
  }

  /** Slack interpreta & < > en mrkdwn. */
  escapar(texto: string): string {
    return texto.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  async idPorCorreo(email: string): Promise<string | null> {
    if (this.ids.has(email)) return this.ids.get(email)!;
    try {
      const { data } = await axios.get(`${API}/users.lookupByEmail`, { params: { email }, headers: this.headers, timeout: 10_000 });
      const id = data?.ok ? (data.user.id as string) : null;
      if (!data?.ok) console.warn(`[Slack] ${email} no está en Slack: ${data?.error}`);
      this.ids.set(email, id);
      return id;
    } catch (error: any) {
      console.error("[Slack] lookupByEmail:", error.message);
      return null;
    }
  }

  async menciones(correos: string[]): Promise<string[]> {
    const ids = await Promise.all([...new Set(correos)].map((c) => this.idPorCorreo(c)));
    return ids.filter((id): id is string => Boolean(id));
  }

  async publicar(canal: string, texto: string, blocks?: unknown[]): Promise<string> {
    const { data } = await axios.post(
      `${API}/chat.postMessage`,
      { channel: canal, text: texto, unfurl_links: false, ...(blocks ? { blocks } : {}) },
      { headers: this.headers, timeout: 15_000 }
    );
    if (!data?.ok) throw new Error(`Slack: ${data?.error}`);
    return data.ts as string;
  }

  /** Aviso interno con @mencion a quienes atienden. true si se publico. */
  async avisarEquipo(aviso: { titulo: string; detalle?: string; correos: string[] }): Promise<boolean> {
    if (!this.configurado()) return false;
    const ids = await this.menciones(aviso.correos);
    const quienes = ids.map((id) => `<@${id}>`).join(" ");
    const detalle = aviso.detalle ? `\n>${this.escapar(aviso.detalle.slice(0, 1500)).replace(/\n/g, "\n>")}` : "";
    await this.publicar(this.canalEquipo()!, `${aviso.titulo} ${quienes}`.trim(), [
      { type: "section", text: { type: "mrkdwn", text: `*${this.escapar(aviso.titulo)}*${detalle}` } },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: quienes ? `Atiende: ${quienes} · 👀 reacciona cuando lo tomes` : "_No encontré a quien atiende en Slack_" },
        ],
      },
    ]);
    return true;
  }
}

export const slackService = new SlackService();
