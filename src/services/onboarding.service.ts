import PDFDocument from 'pdfkit';

export interface IContractData {
  rucBakano: string;
  nombreCliente: string;
  rucCliente: string;
  representanteCliente: string;
  cantidadGuiones: number;
  videosEntretenimiento: number;
  videosVenta: number;
  numeroFunnels: number;
  frecuenciaSesiones: string;
  valorMensual: number;
  diasPago: number;
  plazoMeses: number;
  mesesPermanencia: number;
  mensualidadesPenalidad: number;
  clientSignatureBase64?: string;
}

export class OnboardingService {
  /**
   * Generates a PDF buffer based on the dynamic contract template
   */
  public async generateContractPDF(data: IContractData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 50 });
        const buffers: Buffer[] = [];

        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => {
          const pdfData = Buffer.concat(buffers);
          resolve(pdfData);
        });

        // Add some basic styling
        doc.font('Helvetica-Bold').fontSize(14).text('CONTRATO DE PRESTACIÓN DE SERVICIOS DE MARKETING DIGITAL, CONSULTORÍA COMERCIAL Y PARTNER DE ESCALADO 360', { align: 'center' });
        doc.moveDown();

        doc.font('Helvetica').fontSize(11);
        
        doc.text('PRIMERA.- COMPARECIENTES:', { underline: true });
        doc.text(`Comparecen a la celebración del presente contrato, por una parte, NEGOCIOS DEL PACIFICO NEGODELPAC S.A., representada por LUIS ALBERTO REYES LEMA, en calidad de representante legal, con Ruc No. ${data.rucBakano}, en adelante y para efectos del presente contrato se lo denominará como BAKANO, y por otra parte, ${data.nombreCliente}, con RUC/C.I. No. ${data.rucCliente}, representada por ${data.representanteCliente}, en adelante y para el efecto de este contrato se lo denominará como EL CLIENTE, quienes libre y voluntariamente acuerdan celebrar el presente Contrato de Prestación de Servicios, al tenor de las siguientes cláusulas:`);
        doc.moveDown();

        doc.text('SEGUNDA.- ANTECEDENTES:', { underline: true });
        doc.text(`1.1. BAKANO es una empresa especializada en marketing digital, adquisición de clientes, consultoría comercial y estrategias de escalado de negocios mediante sistemas de conversión digital, generación de contenido estratégico, tráfico pago y optimización comercial.
1.2. EL CLIENTE ha manifestado su interés en contratar los servicios profesionales de BAKANO para implementar estrategias digitales y comerciales orientadas al posicionamiento, generación de prospectos y fortalecimiento de su presencia digital.
1.3. Las partes reconoce que la metodología, procesos, sistemas, funnels, estructuras comerciales, guiones, estrategias y know-how utilizados por BAKANO son propios, confidenciales y forman parte de sus activos intelectuales y comerciales.`);
        doc.moveDown();

        doc.text('TERCERA.- OBJETO DEL CONTRATO:', { underline: true });
        doc.text('BAKANO se obliga a prestar a favor de EL CLIENTE servicios de marketing digital, consultoría comercial y acompañamiento estratégico bajo la modalidad de “Partner de Escalado 360”, incluyendo generación de contenido estratégico, implementación de campañas publicitarias digitales, diseño de sistemas de adquisición de clientes y acompañamiento consultivo, conforme al alcance establecido en este contrato.');
        doc.moveDown();

        doc.text('CUARTA.- ALCANCE DE LOS SERVICIOS:', { underline: true });
        if (data.cantidadGuiones) {
          doc.text(`A. Motor de Contenido de Conversión
- Ingeniería y desarrollo de guiones persuasivos. Cantidad de piezas: ${data.cantidadGuiones}.
- Producción y edición de ${data.videosEntretenimiento || 0} videos de entretenimiento y ${data.videosVenta || 0} videos de venta mensuales.
- Planificación estratégica de contenido.
- Programación y publicación del contenido acordado.

B. Sistema de Adquisición de Clientes
- Diseño de funnels y rutas de conversión. Cantidad de funnels: ${data.numeroFunnels}.
- Configuración de campañas digitales.
- Segmentación estratégica de audiencias.
- Optimización técnica de campañas y presupuesto publicitario.
- Implementación de herramientas de métricas y seguimiento.

C. Consultoría Estratégica
- Sesiones de análisis estratégico. Modalidad y frecuencia: ${data.frecuenciaSesiones}.
- Revisión de métricas comerciales.
- Recomendaciones sobre procesos comerciales y de ventas.
- Acompañamiento estratégico de escalado. Modalidad y frecuencia: ${data.frecuenciaSesiones}.

BAKANO ejecutará únicamente las actividades expresamente acordadas. Cualquier servicio adicional deberá ser cotizado y aprobado por separado.`);
        } else {
          doc.text(`Los servicios a prestar se ejecutarán estrictamente según lo conversado y estipulado previamente entre las partes.

BAKANO ejecutará únicamente las actividades expresamente acordadas. Cualquier servicio adicional deberá ser cotizado y aprobado por separado.`);
        }
        doc.moveDown();

        doc.text('QUINTA.- DELIMITACIÓN DEL SERVICIO:', { underline: true });
        doc.text(`Las partes acuerdan expresamente que el presente contrato NO incluye:
- Diseño gráfico integral o branding corporativo.
- Desarrollo de identidad visual.
- Atención al cliente o gestión de cierres comerciales.
- Manejo de chats, WhatsApp o seguimiento comercial.
- Fotografía profesional de catálogo o eventos.
- Desarrollo web o mantenimiento tecnológico, salvo contratación independiente.`);
        doc.moveDown();

        doc.text('SEXTA.- OBLIGACIONES DE BAKANO:', { underline: true });
        doc.text(`BAKANO se obliga a:
- Ejecutar los servicios contratados con diligencia y criterio técnico.
- Implementar estrategias digitales acordes al modelo de negocio de EL CLIENTE.
- Entregar los contenidos y campañas dentro de tiempos razonables.
- Mantener confidencialidad respecto de la información de EL CLIENTE.
- Informar periódicamente sobre métricas y resultados publicitarios.`);
        doc.moveDown();

        doc.text('SÉPTIMA.- OBLIGACIONES DE EL CLIENTE:', { underline: true });
        doc.text(`EL CLIENTE se obliga a:
- Entregar información veraz y oportuna.
- Facilitar accesos, materiales y aprobaciones necesarias.
- Contar con personal interno capacitado para atención, seguimiento y cierre de ventas.
- Dar seguimiento efectivo y oportuno a los prospectos generados.
- Ejecutar adecuadamente los procesos comerciales y operativos internos.
- Pagar puntualmente los valores acordados.

EL CLIENTE reconoce expresamente que el resultado comercial final depende de múltiples factores ajenos al control de BAKANO, incluyendo capacidad operativa, seguimiento comercial, precios, servicio al cliente, competencia y capacidad de cierre de ventas.`);
        doc.moveDown();

        doc.text('OCTAVA.- EXCLUSIÓN DE GARANTÍA DE RESULTADOS:', { underline: true });
        doc.text(`BAKANO presta servicios de estrategia, marketing digital, posicionamiento y generación de prospectos, mas no garantiza resultados económicos específicos, volúmenes determinados de ventas, retornos financieros, cierres comerciales ni niveles concretos de facturación.
EL CLIENTE reconoce y acepta que:
- La generación efectiva de ventas depende de la correcta ejecución comercial interna.
- El cierre de ventas corresponde exclusivamente al personal y procesos del EL CLIENTE.
- Los resultados pueden verse afectados por variables de mercado, competencia, presupuesto publicitario, calidad del producto o servicio, tiempos de respuesta y gestión comercial.
En consecuencia, BAKANO no será responsable por metas comerciales no alcanzadas ni por expectativas de ventas de EL CLIENTE.`);
        doc.moveDown();

        doc.text('NOVENA.- PROPIEDAD INTELECTUAL Y PROTECCIÓN DE METODOLOGÍA:', { underline: true });
        doc.text(`Toda metodología, estructura estratégica, funnels, sistemas de adquisición, procesos, scripts, guiones, dashboards, automatizaciones, estrategias publicitarias, know-how, documentation técnica y modelos comerciales utilizados o desarrollados por BAKANO constituyen propiedad intelectual y comercial exclusiva de BAKANO.
EL CLIENTE se obliga expresamente a:
- No divulgar, reproducir, compartir, comercializar o transferir la metodología de BAKANO.
- No entregar información estratégica a terceros competidores o agencias externas.
- No replicar parcial o totalmente los sistemas implementados para fines comerciales externos.
- No capacitar terceros utilizando material o metodología de BAKANO.
El incumplimiento a esta cláusula facultará a BAKANO a:
- Terminar inmediatamente el contrato.
- Exigir indemnización por daños y perjuicios.
- Iniciar acciones civiles, comerciales o penales conforme a la legislación ecuatoriana.
La obligación de confidencialidad y no divulgación subsistirá indefinidamente aun después de terminado el contrato.`);
        doc.moveDown();

        doc.text('DÉCIMA.- CONFIDENCIALIDAD:', { underline: true });
        doc.text('Toda información comercial, financiera, estratégica, técnica o publicitaria compartida entre las partes tendrá carácter confidencial. Ninguna de las partes podrá divulgar información sin autorización previa y escrita de la otra.');
        doc.moveDown();

        doc.text('DÉCIMA PRIMERA.- ANEXOS OPERATIVOS:', { underline: true });
        doc.text(`Forman parte integrante del presente contrato, con igual fuerza obligatoria, los siguientes anexos:
Anexo 1: Propuesta comercial y alcance del servicio.
Anexo 2: Cronograma operativo y calendario de producción.
Anexo 3: Lineamientos de marca y contenido.
Anexo 4: Accesos, plataformas y herramientas tecnológicas.
Anexo 5: KPIs y métricas de seguimiento.
Anexo 6: Presupuesto publicitario y condiciones de pauta.
Los anexos podrán ser actualizados de común acuerdo entre las partes mediante comunicación escrita física o electrónica.`);
        doc.moveDown();

        doc.text('DÉCIMA SEGUNDA.- HONORARIOS Y FORMA DE PAGO:', { underline: true });
        if (data.diasPago) {
          doc.text(`EL CLIENTE pagará a BAKANO la suma mensual de USD ${data.valorMensual} más IVA.
Los pagos deberán realizarse de manera anticipada dentro de los primeros ${data.diasPago} días de cada período mensual.
La falta de pago facultará a BAKANO a suspender inmediatamente los servicios sin responsabilidad alguna.
El presupuesto publicitario en Meta Ads, Google Ads u otras plataformas NO se encuentra incluido salvo pacto expreso.`);
        } else {
          doc.text(`EL CLIENTE pagará a BAKANO la suma mensual acordada más IVA.
Los pagos y fechas se realizarán según lo conversado y estipulado entre las partes.
La falta de pago facultará a BAKANO a suspender inmediatamente los servicios sin responsabilidad alguna.
El presupuesto publicitario en Meta Ads, Google Ads u otras plataformas NO se encuentra incluido salvo pacto expreso.`);
        }
        doc.moveDown();

        doc.text('DÉCIMA TERCERA.- PLAZO, PERMANENCIA MÍNIMA Y TERMINACIÓN:', { underline: true });
        if (data.plazoMeses) {
          doc.text(`El presente contrato se mantendrá plenamente vigente dentro de un periodo de tiempo estipulado de ${data.plazoMeses} meses, o bien, extenderá de forma sucesiva sus obligaciones comerciales hasta dar por cancelado el servicio mediante notificación formal escrita o electrónica entre las partes.
Las partes acuerdan expresamente una permanencia mínima obligatoria de ${data.mesesPermanencia} meses contados desde el inicio efectivo de la prestación del servicio. En caso de que EL CLIENTE decida terminar unilateralmente el contrato antes del cumplimiento del plazo mínimo acordado, deberá pagar a favor de BAKANO, en concepto de fee de salida y compensación por estructura operativa, planificación estratégica y recursos asignados, el equivalente a ${data.mensualidadesPenalidad} mensualidades del servicio contratado.
El fee de salida será exigible inmediatamente y no constituirá cláusula penal excluyente de otros daños o valores pendientes.
Cualquiera de las partes podrá terminar el contrato notificando por escrito con al menos quince (15) días de anticipación una vez cumplido el período mínimo obligatorio o dictaminando formalmente dar por cancelado el servicio.
BAKANO podrá terminar inmediatamente el contrato en caso de:
- Incumplimiento de pagos.
- Uso indebido de metodología.
- Conductas que afecten reputacionalmente a BAKANO.
- Incumplimiento grave de EL CLIENTE.`);
        } else {
          doc.text(`El presente contrato tiene un plazo de permanencia y vigencia según lo conversado y estipulado previamente entre las partes.
Cualquiera de las partes podrá terminar el contrato notificando por escrito con al menos quince (15) días de anticipación una vez cumplido el período mínimo obligatorio o dictaminando formalmente dar por cancelado el servicio.
BAKANO podrá terminar inmediatamente el contrato en caso de:
- Incumplimiento de pagos.
- Uso indebido de metodología.
- Conductas que afecten reputacionalmente a BAKANO.
- Incumplimiento grave de EL CLIENTE.`);
        }
        doc.moveDown();

        doc.text('DÉCIMA CUARTA.- LIMITACIÓN DE RESPONSABILIDAD:', { underline: true });
        doc.text(`La responsabilidad total de BAKANO se limitará exclusivamente al valor efectivamente pagado por EL CLIENTE durante el último mes de servicio.
BAKANO no será responsable por:
- Pérdidas de ventas.
- Lucro cesante.
- Daños indirectos.
- Pérdida de clientes.
- Decisiones comerciales tomadas por EL CLIENTE.
- Suspensiones o restricciones de plataformas digitales ajenas a su control.`);
        doc.moveDown();

        doc.text('DÉCIMA QUINTA.- NATURALEZA DE LA RELACIÓN:', { underline: true });
        doc.text('El presente contrato es de naturaleza civil y mercantil. No genera relación laboral, representación, sociedad, joint venture ni exclusividad entre las partes.');
        doc.moveDown();

        doc.text('DÉCIMA SEXTA.- JURISDICCIÓN:', { underline: true });
        doc.text('Para cualquier controversia derivada del presente contrato, las partes se someten a los jueces competentes de la ciudad de Guayaquil y a la legislación ecuatoriana.');
        doc.moveDown(2);

        doc.text('En señal de aceptación, las partes suscriben el presente contrato en dos ejemplares de igual tenor y valor legal.', { align: 'center' });
        doc.moveDown(4);

        // Calculate positions for signatures
        const signatureY = doc.y;
        const leftColX = 50;
        const rightColX = 350;
        const signatureWidth = 150;

        // Render Client Signature if provided
        if (data.clientSignatureBase64) {
          try {
            // Remove the data:image/png;base64, part
            const base64Data = data.clientSignatureBase64.replace(/^data:image\/\w+;base64,/, '');
            const signatureBuffer = Buffer.from(base64Data, 'base64');
            // Right column for Client
            doc.image(signatureBuffer, rightColX, signatureY - 40, { width: signatureWidth, height: 50 });
          } catch (e) {
            console.error("Failed to embed client signature", e);
          }
        }

        // Render Bakano Official Signature (Luis Reyes)
        // Here we simulate an official electronic signature using stylized text.
        // In a real scenario, we would load an image buffer similarly to the client.
        doc.font('Times-Italic').fontSize(16).fillColor('#003366');
        doc.text('Luis Alberto Reyes', leftColX + 10, signatureY - 20);
        doc.font('Helvetica').fontSize(8).fillColor('#666666');
        doc.text('[FIRMADO ELECTRÓNICAMENTE]', leftColX, signatureY + 5);

        // Reset font for the lines
        doc.font('Helvetica-Bold').fontSize(11).fillColor('black');
        doc.text('__________________________________________', leftColX, signatureY + 15);
        doc.text('__________________________________________', rightColX, signatureY + 15);
        
        doc.moveDown(0.5);
        
        doc.text('LUIS ALBERTO REYES LEMA', leftColX);
        doc.text(`${data.representanteCliente}`, rightColX, doc.y - doc.currentLineHeight());

        doc.font('Helvetica');
        doc.text(`RUC: ${data.rucBakano}`, leftColX);
        doc.text(`RUC/C.I.: ${data.rucCliente}`, rightColX, doc.y - doc.currentLineHeight());

        doc.text('GERENTE GENERAL', leftColX);
        doc.text('EL CLIENTE', rightColX, doc.y - doc.currentLineHeight());

        doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }
}

export const onboardingService = new OnboardingService();
