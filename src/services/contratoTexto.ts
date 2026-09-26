/**
 * Texto del contrato, en un solo lugar.
 *
 * Antes el contrato estaba copiado dos veces: en el PDF y en la vista previa
 * de la web, y ya no decian lo mismo. Ahora el PDF, la web y el borrador que
 * se manda por Telegram leen de aqui.
 *
 * Los contratos se versionan: uno firmado se vuelve a generar siempre con el
 * texto que firmo (ver onboarding.service, que guarda la version 1 tal cual).
 */

export const CONTRATO_VERSION_ACTUAL = 2;

export const BAKANO_LEGAL = {
  razonSocial: "BAKANOEC SAS",
  ruc: "0993408804001",
  representante: "LUIS ALBERTO REYES LEMA",
  cargo: "GERENTE GENERAL",
};

/** Menos de esto en pauta no se acepta: no alcanza para asegurar cierres. */
export const PAUTA_MINIMA = 300;
/** Recomendado en octubre, noviembre y diciembre: hay mas anunciantes. */
export const PAUTA_TEMPORADA_ALTA = 400;

export interface Clausula {
  titulo: string;
  texto: string;
}

export interface DatosContrato {
  nombreCliente?: string;
  rucCliente?: string;
  representanteCliente?: string;
  presupuestoPauta?: number | string;
  cantidadGuiones?: number;
  videosEntretenimiento?: number;
  videosVenta?: number;
  numeroFunnels?: number;
  frecuenciaSesiones?: string;
  diasPago?: number;
}

export const TITULO_CONTRATO =
  "CONTRATO DE PRESTACIÓN DE SERVICIOS DE MARKETING DIGITAL, CONSULTORÍA COMERCIAL Y PARTNER DE ESCALADO 360";

const PENDIENTE = "[pendiente]";

export function formatoDolares(valor: number): string {
  return `USD $${valor.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** Las clausulas de la version vigente, ya con los datos del cliente. */
export function clausulasContrato(d: DatosContrato): Clausula[] {
  const nombre = d.nombreCliente || PENDIENTE;
  const ruc = d.rucCliente || PENDIENTE;
  const representante = d.representanteCliente || PENDIENTE;
  const pauta = Number(d.presupuestoPauta);
  const pautaTexto = pauta >= PAUTA_MINIMA ? formatoDolares(pauta) : PENDIENTE;

  const alcance = d.cantidadGuiones
    ? `A. Motor de Contenido de Conversión
- Ingeniería y desarrollo de guiones persuasivos. Cantidad de piezas: ${d.cantidadGuiones}.
- Producción y edición de ${d.videosEntretenimiento || 0} videos de entretenimiento y ${d.videosVenta || 0} videos de venta mensuales.
- Planificación estratégica de contenido.
- Programación y publicación del contenido acordado.

B. Sistema de Adquisición de Clientes
- Diseño de funnels y rutas de conversión. Cantidad de funnels: ${d.numeroFunnels}.
- Configuración de campañas digitales.
- Segmentación estratégica de audiencias.
- Optimización técnica de campañas y presupuesto publicitario.
- Implementación de herramientas de métricas y seguimiento.

C. Consultoría Estratégica
- Sesiones de análisis estratégico. Modalidad y frecuencia: ${d.frecuenciaSesiones}.
- Revisión de métricas comerciales.
- Recomendaciones sobre procesos comerciales y de ventas.
- Acompañamiento estratégico de escalado. Modalidad y frecuencia: ${d.frecuenciaSesiones}.

BAKANO ejecutará únicamente las actividades expresamente acordadas. Cualquier servicio adicional deberá ser cotizado y aprobado por separado.`
    : `Los servicios a prestar se ejecutarán estrictamente según lo conversado y estipulado previamente entre las partes.

BAKANO ejecutará únicamente las actividades expresamente acordadas. Cualquier servicio adicional deberá ser cotizado y aprobado por separado.`;

  const pagos = d.diasPago
    ? `Los pagos deberán realizarse de manera anticipada dentro de los primeros ${d.diasPago} días de cada período mensual.`
    : "Los pagos y fechas se realizarán según lo conversado y estipulado entre las partes.";

  return [
    {
      titulo: "PRIMERA.- COMPARECIENTES:",
      texto: `Comparecen a la celebración del presente contrato, por una parte, ${BAKANO_LEGAL.razonSocial}, representada por ${BAKANO_LEGAL.representante}, en calidad de representante legal, con RUC No. ${BAKANO_LEGAL.ruc}, en adelante y para efectos del presente contrato se la denominará como BAKANO, y por otra parte, ${nombre}, con RUC/C.I. No. ${ruc}, representada por ${representante}, en adelante y para el efecto de este contrato se lo denominará como EL CLIENTE, quienes libre y voluntariamente acuerdan celebrar el presente Contrato de Prestación de Servicios, al tenor de las siguientes cláusulas:`,
    },
    {
      titulo: "SEGUNDA.- ANTECEDENTES:",
      texto: `2.1. BAKANO es una empresa especializada en marketing digital, adquisición de clientes, consultoría comercial y estrategias de escalado de negocios mediante sistemas de conversión digital, generación de contenido estratégico, tráfico pago y optimización comercial.
2.2. EL CLIENTE ha manifestado su interés en contratar los servicios profesionales de BAKANO para implementar estrategias digitales y comerciales orientadas al posicionamiento, generación de prospectos y fortalecimiento de su presencia digital.
2.3. Las partes reconocen que la metodología, procesos, sistemas, funnels, estructuras comerciales, guiones, estrategias y know-how utilizados por BAKANO son propios, confidenciales y forman parte de sus activos intelectuales y comerciales.`,
    },
    {
      titulo: "TERCERA.- OBJETO DEL CONTRATO:",
      texto:
        "BAKANO se obliga a prestar a favor de EL CLIENTE servicios de marketing digital, consultoría comercial y acompañamiento estratégico bajo la modalidad de “Partner de Escalado 360”, incluyendo generación de contenido estratégico, implementación de campañas publicitarias digitales, diseño de sistemas de adquisición de clientes y acompañamiento consultivo, conforme al alcance establecido en este contrato.",
    },
    { titulo: "CUARTA.- ALCANCE DE LOS SERVICIOS:", texto: alcance },
    {
      titulo: "QUINTA.- DELIMITACIÓN DEL SERVICIO:",
      texto: `Las partes acuerdan expresamente que el presente contrato NO incluye:
- Diseño gráfico integral o branding corporativo.
- Desarrollo de identidad visual.
- Atención al cliente o gestión de cierres comerciales.
- Manejo de chats, WhatsApp o seguimiento comercial.
- Fotografía profesional de catálogo o eventos.
- Desarrollo web o mantenimiento tecnológico, salvo contratación independiente.`,
    },
    {
      titulo: "SEXTA.- OBLIGACIONES DE BAKANO:",
      texto: `BAKANO se obliga a:
- Ejecutar los servicios contratados con diligencia y criterio técnico.
- Implementar estrategias digitales acordes al modelo de negocio de EL CLIENTE.
- Entregar los contenidos y campañas dentro de tiempos razonables.
- Mantener confidencialidad respecto de la información de EL CLIENTE.
- Informar periódicamente sobre métricas y resultados publicitarios.`,
    },
    {
      titulo: "SÉPTIMA.- OBLIGACIONES DE EL CLIENTE:",
      texto: `EL CLIENTE se obliga a:
- Entregar información veraz y oportuna.
- Facilitar accesos, materiales y aprobaciones necesarias.
- Contar con personal interno capacitado para atención, seguimiento y cierre de ventas.
- Dar seguimiento efectivo y oportuno a los prospectos generados.
- Ejecutar adecuadamente los procesos comerciales y operativos internos.
- Mantener la inversión publicitaria mensual comprometida en la cláusula décima cuarta.
- Pagar puntualmente los valores acordados.

EL CLIENTE reconoce expresamente que el resultado comercial final depende de múltiples factores ajenos al control de BAKANO, incluyendo capacidad operativa, seguimiento comercial, precios, servicio al cliente, competencia y capacidad de cierre de ventas.`,
    },
    {
      titulo: "OCTAVA.- EXCLUSIÓN DE GARANTÍA DE RESULTADOS:",
      texto: `BAKANO presta servicios de estrategia, marketing digital, posicionamiento y generación de prospectos, mas no garantiza resultados económicos específicos, volúmenes determinados de ventas, retornos financieros, cierres comerciales ni niveles concretos de facturación, salvo la garantía de desempeño expresamente prevista en la cláusula vigésima.
EL CLIENTE reconoce y acepta que:
- La generación efectiva de ventas depende de la correcta ejecución comercial interna.
- El cierre de ventas corresponde exclusivamente al personal y procesos de EL CLIENTE.
- Los resultados pueden verse afectados por variables de mercado, competencia, presupuesto publicitario, calidad del producto o servicio, tiempos de respuesta y gestión comercial.
En consecuencia, BAKANO no será responsable por metas comerciales no alcanzadas ni por expectativas de ventas de EL CLIENTE.`,
    },
    {
      titulo: "NOVENA.- PROPIEDAD INTELECTUAL Y PROTECCIÓN DE METODOLOGÍA:",
      texto: `Toda metodología, estructura estratégica, funnels, sistemas de adquisición, procesos, scripts, guiones, dashboards, automatizaciones, estrategias publicitarias, know-how, documentación técnica y modelos comerciales utilizados o desarrollados por BAKANO constituyen propiedad intelectual y comercial exclusiva de BAKANO.
EL CLIENTE se obliga expresamente a:
- No divulgar, reproducir, compartir, comercializar o transferir la metodología de BAKANO.
- No entregar información estratégica a terceros competidores o agencias externas.
- No replicar parcial o totalmente los sistemas implementados para fines comerciales externos.
- No capacitar terceros utilizando material o metodología de BAKANO.
El incumplimiento a esta cláusula facultará a BAKANO a:
- Terminar inmediatamente el contrato.
- Exigir indemnización por daños y perjuicios.
- Iniciar acciones civiles, comerciales o penales conforme a la legislación ecuatoriana.
La obligación de confidencialidad y no divulgación subsistirá indefinidamente aun después de terminado el contrato.`,
    },
    {
      titulo: "DÉCIMA.- CONFIDENCIALIDAD:",
      texto:
        "Toda información comercial, financiera, estratégica, técnica o publicitaria compartida entre las partes tendrá carácter confidencial. Ninguna de las partes podrá divulgar información sin autorización previa y escrita de la otra.",
    },
    {
      titulo: "DÉCIMA PRIMERA.- ANEXOS OPERATIVOS:",
      texto: `Forman parte integrante del presente contrato, con igual fuerza obligatoria, los siguientes anexos:
Anexo 1: Propuesta comercial y alcance del servicio.
Anexo 2: Cronograma operativo y calendario de producción.
Anexo 3: Lineamientos de marca y contenido.
Anexo 4: Accesos, plataformas y herramientas tecnológicas.
Anexo 5: KPIs y métricas de seguimiento.
Anexo 6: Presupuesto publicitario y condiciones de pauta.
Los anexos podrán ser actualizados de común acuerdo entre las partes mediante comunicación escrita física o electrónica.`,
    },
    {
      titulo: "DÉCIMA SEGUNDA.- HONORARIOS Y FORMA DE PAGO:",
      texto: `EL CLIENTE pagará a BAKANO la suma mensual acordada más IVA.
${pagos}
La falta de pago facultará a BAKANO a suspender inmediatamente los servicios sin responsabilidad alguna.
El presupuesto publicitario en Meta Ads, Google Ads u otras plataformas NO forma parte de los honorarios de BAKANO y se rige por la cláusula décima cuarta.`,
    },
    {
      titulo: "DÉCIMA TERCERA.- INICIO DEL SERVICIO:",
      texto:
        "La prestación del servicio iniciará al día siguiente de que BAKANO reciba el comprobante o la captura del pago correspondiente al primer mes de honorarios. Desde esa fecha se contarán los plazos previstos en el presente contrato.",
    },
    {
      titulo: "DÉCIMA CUARTA.- PRESUPUESTO PUBLICITARIO (PAUTA):",
      texto: `EL CLIENTE se compromete a invertir mensualmente en pauta publicitaria la suma de ${pautaTexto}, sin impuestos. Este valor no podrá ser inferior a ${formatoDolares(PAUTA_MINIMA)} mensuales, sin impuestos.
EL CLIENTE reconoce que con una inversión menor BAKANO no puede asegurar la generación de cierres comerciales y que los resultados pueden tomar más tiempo.
A partir de este valor, las partes evaluarán el retorno de la inversión y el presupuesto crecerá conforme crezca la facturación de EL CLIENTE, lo que se acordará conforme avance la relación comercial.
En los meses de octubre, noviembre y diciembre se recomienda una inversión de al menos ${formatoDolares(PAUTA_TEMPORADA_ALTA)} mensuales, debido a la mayor cantidad de anunciantes compitiendo en las plataformas durante esa temporada.
El presupuesto publicitario no forma parte de los honorarios de BAKANO.`,
    },
    {
      titulo: "DÉCIMA QUINTA.- CRM Y MENSAJERÍA:",
      texto:
        "BAKANO cubre el valor de la licencia del CRM utilizado para la gestión de prospectos durante la vigencia del contrato. Los costos de los mensajes de WhatsApp enviados desde el CRM no están incluidos: son facturados por Meta y serán pagados directamente por EL CLIENTE a dicha plataforma.",
    },
    {
      titulo: "DÉCIMA SEXTA.- PERÍODO DE EXPLORACIÓN:",
      texto:
        "EL CLIENTE reconoce que el primer mes de servicio es de exploración: en él se prueban mensajes, audiencias y contenidos, por lo que la estrategia no muestra su resultado completo en ese período. BAKANO recomienda mantener el servicio al menos dos (2) meses consecutivos aplicando la metodología para obtener resultados más tangibles.",
    },
    {
      titulo: "DÉCIMA SÉPTIMA.- PLAZO, RENOVACIÓN Y TERMINACIÓN:",
      texto: `El presente contrato tiene una permanencia mínima obligatoria de 1 mes contado desde el inicio del servicio.
Posteriormente, el contrato se renovará de manera automática y sucesiva mes a mes, mientras EL CLIENTE mantenga activa y al día su suscripción mensual.
EL CLIENTE podrá suspender o terminar el servicio en el momento que lo desee, sin penalidad alguna. Para que la suspensión sea válida, deberá comunicarla por escrito a través de los canales de comunicación oficiales de BAKANO.
BAKANO podrá terminar inmediatamente el contrato en caso de:
- Incumplimiento de pagos.
- Uso indebido de metodología.
- Conductas que afecten reputacionalmente a BAKANO.
- Incumplimiento grave de EL CLIENTE.`,
    },
    {
      titulo: "DÉCIMA OCTAVA.- LIMITACIÓN DE RESPONSABILIDAD:",
      texto: `La responsabilidad total de BAKANO se limitará exclusivamente al valor efectivamente pagado por EL CLIENTE durante el último mes de servicio.
BAKANO no será responsable por:
- Pérdidas de ventas.
- Lucro cesante.
- Daños indirectos.
- Pérdida de clientes.
- Decisiones comerciales tomadas por EL CLIENTE.
- Suspensiones o restricciones de plataformas digitales ajenas a su control.`,
    },
    {
      titulo: "DÉCIMA NOVENA.- NATURALEZA DE LA RELACIÓN Y JURISDICCIÓN:",
      texto:
        "El presente contrato es de naturaleza civil y mercantil. No genera relación laboral, representación, sociedad, joint venture ni exclusividad entre las partes. Para cualquier controversia derivada del presente contrato, las partes se someten a los jueces competentes de la ciudad de Guayaquil y a la legislación ecuatoriana.",
    },
    {
      titulo: "VIGÉSIMA.- GARANTÍA DE DESEMPEÑO:",
      texto:
        "Si EL CLIENTE mantiene el servicio durante los dos (2) primeros meses consecutivos aplicando la metodología de BAKANO y, al cabo de ese período, no se han obtenido resultados, entendidos como la generación de prospectos (leads) para EL CLIENTE, EL CLIENTE podrá acceder a una garantía de desempeño: durante el tercer y el cuarto mes de servicio pagará únicamente el cincuenta por ciento (50%) de los honorarios mensuales de BAKANO. El objetivo de este período es ajustar, optimizar y levantar la estrategia.",
    },
    {
      titulo: "VIGÉSIMA PRIMERA.- CONDICIONES DE LA GARANTÍA:",
      texto: `Para acceder y mantener la garantía de desempeño, EL CLIENTE deberá:
- Haber mantenido y mantener durante los meses de garantía, de forma directa e ininterrumpida, la inversión publicitaria comprometida en la cláusula décima cuarta. El descuento aplica única y exclusivamente a los honorarios de BAKANO, nunca a la pauta.
- Cumplir con sus obligaciones operativas y comerciales de la cláusula séptima: contar con personal capacitado para la atención inmediata, dar seguimiento oportuno a los prospectos y desplegar el máximo esfuerzo comercial para el cierre de ventas.
- Compartir con BAKANO la retroalimentación de su gestión comercial para fines de optimización.
- Estar al día en sus pagos.
La falta de cualquiera de estas condiciones provocará la cancelación inmediata de la garantía.`,
    },
    {
      titulo: "VIGÉSIMA SEGUNDA.- AUDITORÍA Y ANULACIÓN DE LA GARANTÍA:",
      texto:
        "BAKANO se reserva el derecho de verificar la gestión comercial de EL CLIENTE a través de las plataformas y herramientas tecnológicas pactadas. Si se demuestra que BAKANO cumplió con la generación de prospectos, pero estos no se convirtieron en cierres comerciales debido a demoras en el contacto, deficiente atención, inacción operativa o incumplimiento de procesos internos por parte de EL CLIENTE, la garantía quedará automáticamente anulada, debiendo EL CLIENTE abonar la mensualidad regular completa correspondiente.",
    },
  ];
}
