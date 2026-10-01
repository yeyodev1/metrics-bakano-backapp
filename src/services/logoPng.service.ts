import cloudinary from "../config/cloudinary";

/**
 * El logo siempre termina en PNG, venga como venga.
 *
 * Antes se le exigia al cliente exportarlo a PNG y era donde mas se trababa:
 * mandaba un JPG o una foto, el bot se lo rechazaba y no volvia. Ahora se
 * acepta cualquier imagen (y la primera pagina de un PDF) y Cloudinary la
 * convierte a PNG al subirla (`format: "png"`). Si ya era PNG, queda igual.
 *
 * Ojo: convertir no le quita el fondo a un JPG. Si el original no traia
 * transparencia, el PNG tampoco; eso se le dice al cliente sin bloquearlo.
 */

/** Lo que se acepta como logo. */
export const TIPOS_LOGO = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/svg+xml",
  "application/pdf",
];

export function esTipoDeLogo(mime: string): boolean {
  return TIPOS_LOGO.includes(String(mime || "").toLowerCase());
}

/** El nombre con extension .png, para que el archivo diga lo que es. */
export function nombrePng(nombre: string): string {
  const base = String(nombre || "logo").replace(/\.[a-z0-9]{2,5}$/i, "");
  return `${base || "logo"}.png`;
}

/** Sube el logo a Cloudinary ya convertido a PNG. */
export async function subirLogoComoPng(
  buffer: Buffer,
  folder: string
): Promise<{ url: string; public_id: string; convertido: boolean; original: string }> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: "image",
        // Cloudinary convierte al subir. Un PDF entra como imagen y queda su primera pagina.
        format: "png",
      },
      (error, result) => {
        if (error || !result) return reject(error);
        resolve({
          url: result.secure_url,
          public_id: result.public_id,
          convertido: String(result.format || "").toLowerCase() === "png",
          original: String((result as any).original_extension || result.format || ""),
        });
      }
    );
    stream.end(buffer);
  });
}
