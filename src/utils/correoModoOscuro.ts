/**
 * Correos que se leen bien en el celular, también en modo oscuro.
 *
 * Gmail en iPhone/Android invierte los colores por su cuenta: los fondos
 * sólidos claros pasan a oscuros y viceversa, y el texto blanco lo oscurece.
 * Pero NO toca los degradados ni las imágenes. Resultado: títulos blancos
 * sobre un encabezado con degradado quedaban oscuro sobre oscuro, y el logo
 * blanco desaparecía sobre una barra que Gmail volvió clara.
 *
 * Se arregla en un solo lugar, al enviar, para todas las plantillas:
 * - `color-scheme: light` para Apple Mail y los que lo respetan (no invierten).
 * - En Gmail (selector `u + .body`), el texto blanco se envuelve con el truco
 *   de mix-blend-mode (screen + difference), que lo deja blanco aunque Gmail
 *   lo haya oscurecido. Fuera de Gmail esas clases no hacen nada.
 * La barra del logo ya es una imagen con su fondo, así que no depende de esto.
 */

const ESTILO = `<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only">
<style>
:root { color-scheme: light only; supported-color-schemes: light only; }
u + .body .gmail-screen { background: #000; mix-blend-mode: screen; }
u + .body .gmail-difference { background: #000; mix-blend-mode: difference; }
</style>`;

/** Texto blanco o casi blanco en un estilo en línea. */
const BLANCO = /color:\s*(#fff\b|#ffffff\b|white\b|rgba?\(\s*255\s*,\s*255\s*,\s*255)/i;

/** Etiquetas cuyo texto se protege. Sin div/td: se anidan y el regex no sabría dónde cierran. */
const ETIQUETAS = ["h1", "h2", "h3", "p", "a", "span", "strong"];

function protegerTextoBlanco(html: string): string {
  let salida = html;
  for (const tag of ETIQUETAS) {
    const re = new RegExp(`<${tag}(\\s[^>]*style="[^"]*"[^>]*)>([\\s\\S]*?)</${tag}>`, "gi");
    salida = salida.replace(re, (entero, atributos: string, contenido: string) => {
      const estilo = /style="([^"]*)"/i.exec(atributos)?.[1] ?? "";
      // Con la misma etiqueta anidada el cierre encontrado no es el suyo: mejor no tocar.
      if (!BLANCO.test(estilo) || contenido.includes("gmail-screen") || new RegExp(`<${tag}[\\s>]`, "i").test(contenido)) return entero;
      const display = tag === "a" || tag === "span" || tag === "strong" ? "inline-block" : "block";
      return `<${tag}${atributos}><span class="gmail-screen" style="display:${display}"><span class="gmail-difference" style="display:${display}">${contenido}</span></span></${tag}>`;
    });
  }
  return salida;
}

/**
 * Las plantillas usan tablas de 600 px fijos: en un celular se cortaban o el
 * cliente las achicaba hasta que no se leían. Se dejan en 600 como máximo y
 * al 100% del ancho disponible.
 */
function anchoFluido(html: string): string {
  return html.replace(/<table\b([^>]*)\bwidth="(\d{3})"([^>]*)>/gi, (entero, antes: string, ancho: string, despues: string) => {
    if (Number(ancho) < 480 || /max-width/i.test(entero)) return entero;
    const fluido = `width:100%;max-width:${ancho}px;`;
    const attrs = `${antes}width="${ancho}"${despues}`;
    return /style="/i.test(attrs) ? `<table${attrs.replace(/style="/i, `style="${fluido}`)}>` : `<table${attrs} style="${fluido}">`;
  });
}

export function paraModoOscuro(html: string): string {
  if (!html || html.includes("gmail-difference {")) return html;
  let salida = anchoFluido(protegerTextoBlanco(html));

  // Gmail vuelve <body> un div con clase "body" detrás de un <u>: de ahí sale `u + .body`.
  salida = /<body\b[^>]*class="/i.test(salida)
    ? salida.replace(/<body\b([^>]*)class="/i, '<body$1class="body ')
    : /<body\b/i.test(salida)
      ? salida.replace(/<body\b/i, '<body class="body"')
      : `<div class="body">${salida}</div>`;

  // Al final del <head>, después del charset y el viewport de la plantilla.
  return /<\/head>/i.test(salida) ? salida.replace(/<\/head>/i, `${ESTILO}</head>`) : `${ESTILO}${salida}`;
}
