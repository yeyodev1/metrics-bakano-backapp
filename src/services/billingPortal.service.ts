import axios, { AxiosError, AxiosInstance } from "axios";
import { CustomError } from "../errors/customError.error";

/**
 * Proxy hacia Bakano Finanzas (finances-bakano-backapp). La facturación vive
 * allá; acá solo se reenvían las peticiones del cliente ya autenticado con el
 * header servidor-a-servidor `x-metrics-key` (METRICS_PROXY_KEY, la dirección
 * inversa de la integración x-finance-key existente).
 */

let client: AxiosInstance | null = null;

function isConfigured(): boolean {
  return Boolean(process.env.FINANCES_API_URL && process.env.METRICS_PROXY_KEY);
}

function getClient(): AxiosInstance {
  if (!isConfigured()) {
    throw new CustomError("La facturación no está configurada en este entorno.", 503);
  }
  if (!client) {
    client = axios.create({
      baseURL: (process.env.FINANCES_API_URL as string).replace(/\/+$/, ""),
      timeout: 15000,
      headers: { "x-finance-source": "metrics", "x-metrics-key": process.env.METRICS_PROXY_KEY },
    });
  }
  return client;
}

/** Propaga el error de finanzas con su status y mensaje en español tal cual. */
function rethrow(error: unknown): never {
  const axiosError = error as AxiosError<{ message?: string }>;
  if (axiosError.response) {
    throw new CustomError(
      axiosError.response.data?.message || "Error del servicio de facturación.",
      axiosError.response.status
    );
  }
  throw new CustomError("No se pudo contactar al servicio de facturación.", 502);
}

export async function getBilling(workspaceId: string): Promise<unknown> {
  try {
    const { data } = await getClient().get(`/portal/workspaces/${workspaceId}/billing`);
    return data;
  } catch (error) {
    rethrow(error);
  }
}

export async function createCheckout(
  workspaceId: string,
  invoiceId: string,
  returnUrl: string
): Promise<unknown> {
  try {
    const { data } = await getClient().post(
      `/portal/workspaces/${workspaceId}/checkout-session`,
      { invoiceId, returnUrl }
    );
    return data;
  } catch (error) {
    rethrow(error);
  }
}

export interface SubmitReceiptInput {
  buffer: Buffer;
  filename: string;
  mimetype: string;
  fields: {
    invoiceId?: string;
    grossAmount: string;
    feeAmount?: string;
    submittedByName?: string;
    submittedByEmail?: string;
  };
}

export async function submitReceipt(
  workspaceId: string,
  input: SubmitReceiptInput
): Promise<unknown> {
  const form = new FormData();
  form.append(
    "receipt",
    new Blob([new Uint8Array(input.buffer)], { type: input.mimetype }),
    input.filename
  );
  for (const [key, value] of Object.entries(input.fields)) {
    if (value !== undefined && value !== null && value !== "") form.append(key, String(value));
  }

  try {
    const { data } = await getClient().post(
      `/portal/workspaces/${workspaceId}/submissions`,
      form
    );
    return data;
  } catch (error) {
    rethrow(error);
  }
}
