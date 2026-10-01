import multer from "multer";

/**
 * Un archivo rechazado es culpa de la peticion, no del servidor: sin `status`
 * terminaba en 500 y disparaba alerta a Slack, y el cliente veia "Internal
 * Server Error" en vez de por que no se acepto su archivo.
 */
function rechazo(mensaje: string): Error {
  return Object.assign(new Error(mensaje), { status: 400 });
}

const storage = multer.memoryStorage();

export const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter(_req, file, cb) {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(rechazo("Solo se permiten imágenes (PNG, JPG o WEBP)."));
    }
  },
});

export const uploadMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB for videos
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("video/") || file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(rechazo("Solo se permiten videos e imágenes."));
    }
  },
});

export const uploadDocument = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
      // Para logos: se convierten a PNG al subir (logoPng.service).
      "image/heic",
      "image/heif",
      "image/gif",
      "image/svg+xml",
      // El catálogo se puede escribir a mano desde la plataforma y se envía
      // como .txt: el servidor lo rechazaba y esa opción nunca funcionó.
      "text/plain",
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        rechazo(
          "Solo se permiten PDF, PNG, JPG o WEBP. Si tienes el archivo en .ai, .psd o .eps, sube una captura o un PDF (el logo lo convertimos a PNG)."
        )
      );
    }
  },
});
