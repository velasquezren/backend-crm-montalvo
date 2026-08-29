import { Injectable, NotFoundException } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { Writable } from 'stream';

import { PrismaService } from '../../prisma/prisma.service';
import { CalculoComisionesService } from './calculo-comisiones.service';
import {
  armarInforme,
  bob,
  FilaInforme,
  Firmantes,
  firmantesPara,
  InformeComisiones,
  TotalesBloque,
  usd,
} from './informe-pdf';

/**
 * Informe mensual de comisiones en PDF: el documento que se imprime y se firma.
 *
 * ## Por qué PDFKit y no un HTML renderizado
 *
 * La opción cómoda sería maquetar HTML y pasarlo por Puppeteer, pero en este
 * servidor no cabe: `crm_backend.service` corre con `MemoryMax=400M` sobre un
 * VPS de 1,7 GB compartido con MySQL, Apache y un FastAPI (ver
 * `crm-backend-arquitectura`). Un Chrome headless pide más que eso él solo, y
 * pasarse del techo no degrada el servicio: systemd lo mata.
 *
 * PDFKit es JS puro, dibuja sobre un stream y no carga el documento entero en
 * memoria — el mismo criterio con el que ya se escribe el Excel.
 *
 * Usa las fuentes Helvetica incrustadas en el estándar PDF: no hay archivos de
 * fuente que desplegar y su codificación WinAnsi cubre los acentos y la eñe de
 * los nombres.
 *
 * ## Qué NO lleva, y por qué
 *
 * La tabla de la hoja "Liquidación" tiene 20 columnas. Acá van 13: se quitan
 * Tipo, Área, Planes, Cumple objetivo, Cirugías acumuladas y los dos niveles.
 * Todas ésas explican **cómo se llegó** a la cifra, y para eso está el Excel,
 * que se lee en pantalla y se puede filtrar. Este documento responde otra
 * pregunta —cuánto se le paga a cada quien— y se firma en papel: cada columna
 * de más le quita ancho a las que importan y obliga a bajar el tamaño de letra.
 */

/** Paleta de la clínica (`styles.css` del frontend), en hexadecimal para PDFKit. */
const COLOR = {
  primary: '#006156',
  secondary: '#39ADA3',
  textoOscuro: '#1F2937',
  textoSuave: '#6B7280',
  borde: '#E5E7EB',
  fondoSuave: '#EAF7F5',
  blanco: '#FFFFFF',
} as const;

interface Columna {
  titulo: string;
  ancho: number;
  /** Cómo sacar el texto de una fila. `null` = la columna no aplica a esa fila. */
  valor: (f: FilaInforme) => string | null;
  /** Cómo sacar el texto de un pie de bloque. */
  total: (t: TotalesBloque) => string | null;
  alineacion: 'left' | 'right';
}

/*
 * Anchos en puntos sobre A4 apaisado (841,89 pt menos 2×30 de margen = 781,89).
 * Suman 781: si se toca uno hay que compensar en otro o la tabla se sale de la
 * caja, porque no hay reflow — PDFKit dibuja donde se le dice.
 */
const COLUMNAS: Columna[] = [
  { titulo: 'Vendedora', ancho: 130, alineacion: 'left', valor: f => f.nombre, total: () => null },
  { titulo: 'Código', ancho: 44, alineacion: 'left', valor: f => f.codigo, total: () => null },
  { titulo: 'Facturado', ancho: 62, alineacion: 'right', valor: f => usd(f.montoVendido), total: t => usd(t.montoVendido) },
  { titulo: 'Base cálculo', ancho: 62, alineacion: 'right', valor: f => usd(f.baseCalculo), total: t => usd(t.baseCalculo) },
  { titulo: 'Tipo A', ancho: 48, alineacion: 'right', valor: f => usd(f.comisionA), total: t => usd(t.comisionA) },
  { titulo: 'Tipo A RA', ancho: 52, alineacion: 'right', valor: f => usd(f.comisionTipoARA), total: t => usd(t.comisionTipoARA) },
  { titulo: 'Tipo B', ancho: 48, alineacion: 'right', valor: f => usd(f.comisionB), total: t => usd(t.comisionB) },
  { titulo: 'Tipo C', ancho: 48, alineacion: 'right', valor: f => usd(f.comisionC), total: t => usd(t.comisionC) },
  { titulo: 'Bonos', ancho: 50, alineacion: 'right', valor: f => usd(f.totalBonos), total: t => usd(t.totalBonos) },
  { titulo: 'Total $us', ancho: 55, alineacion: 'right', valor: f => usd(f.totalUsd), total: t => usd(t.totalUsd) },
  { titulo: 'Total Bs', ancho: 58, alineacion: 'right', valor: f => bob(f.totalBob), total: t => bob(t.totalBob) },
  { titulo: 'Sueldo Bs', ancho: 58, alineacion: 'right', valor: f => bob(f.sueldoBase), total: t => bob(t.sueldoBase) },
  { titulo: 'A PAGAR Bs', ancho: 66, alineacion: 'right', valor: f => bob(f.totalGanado), total: t => bob(t.totalGanado) },
];

/**
 * Columnas que en el bloque de marketing se dejan EN BLANCO.
 *
 * No comisiona: no factura, no tiene base ni tipos. Un `$ 0,00` ahí diría
 * "vendió y no llegó"; el hueco dice "esto no le corresponde", que es lo cierto.
 * Mismo criterio que el bloque equivalente del Excel.
 */
const COLUMNAS_SOLO_VENTAS = new Set([
  'Facturado',
  'Base cálculo',
  'Tipo A',
  'Tipo A RA',
  'Tipo B',
  'Tipo C',
]);

const MARGEN = 30;
/** Alto del bloque de firmas, con la aclaración del TC incluida arriba. */
const ALTO_FIRMAS = 76;
const ALTO_FILA = 16;
const ALTO_CABECERA = 20;

/** Cómo se lee cada estado en el documento, sin el guion bajo del enum. */
const ESTADO_LEGIBLE: Record<string, string> = {
  BORRADOR: 'en borrador',
  CALCULADO: 'calculado',
  EN_REVISION: 'en revisión',
  CERRADO: 'cerrado',
  PAGADO: 'pagado',
};

const MESES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

type Doc = PDFKit.PDFDocument;

@Injectable()
export class ExportacionPdfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calculo: CalculoComisionesService,
  ) {}

  async nombreArchivo(periodoId: string): Promise<string> {
    const periodo = await this.prisma.periodoComision.findUnique({
      where: { id: periodoId },
      select: { anio: true, mes: true },
    });
    if (!periodo) {
      throw new NotFoundException(`Periodo ${periodoId} no encontrado`);
    }
    return `informe-comisiones-${periodo.anio}-${String(periodo.mes).padStart(2, '0')}.pdf`;
  }

  async exportar(
    periodoId: string,
    salida: Writable,
    opciones: { incluirOcultas?: boolean; usuarioId?: string } = {},
  ): Promise<void> {
    const consolidado = await this.calculo.reporteConsolidado(
      periodoId,
      opciones.incluirOcultas ?? false,
    );

    const usuario = opciones.usuarioId
      ? await this.prisma.usuario.findUnique({
          where: { id: opciones.usuarioId },
          select: { nombre: true },
        })
      : null;

    const informe = armarInforme(consolidado.filas);
    const firmantes = firmantesPara(usuario);

    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: MARGEN,
      info: {
        Title: `Informe de Comisiones ${consolidado.periodo.mes}/${consolidado.periodo.anio}`,
        Author: 'Clínica Montalvo',
      },
    });
    doc.pipe(salida);

    const tipoCambio = Number(consolidado.periodo.tipoCambio) || 1;
    this.cabecera(doc, {
      mes: consolidado.periodo.mes,
      anio: consolidado.periodo.anio,
      tipoCambio,
      estado: consolidado.periodo.estado,
      firmantes,
    });

    let y = doc.y + 6;
    y = this.tabla(doc, informe, y);
    y = this.avisoOcultas(doc, consolidado, y);
    this.firmas(doc, firmantes, y);

    doc.end();
  }

  /* ── Encabezado ─────────────────────────────────────────────────────── */

  private cabecera(
    doc: Doc,
    datos: {
      mes: number;
      anio: number;
      tipoCambio: number;
      estado: string;
      firmantes: Firmantes;
    },
  ): void {
    const { mes, anio, tipoCambio, estado, firmantes } = datos;
    const ancho = doc.page.width - MARGEN * 2;

    doc.rect(MARGEN, MARGEN, ancho, 56).fill(COLOR.primary);

    doc
      .fillColor(COLOR.blanco)
      .font('Helvetica-Bold')
      .fontSize(15)
      .text('CLÍNICA MONTALVO', MARGEN + 14, MARGEN + 10);

    doc
      .font('Helvetica')
      .fontSize(10)
      .text(
        `Informe General de Comisiones · ${MESES[mes - 1] ?? mes} ${anio}`,
        MARGEN + 14,
        MARGEN + 29,
      );

    /* A la derecha, los dos datos sin los que el documento no se puede
       auditar: con qué tipo de cambio se convirtió y quién lo generó. */
    doc
      .fontSize(8)
      .text(`Tipo de cambio  ${bob(tipoCambio)}`, MARGEN, MARGEN + 10, {
        width: ancho - 14,
        align: 'right',
      })
      .text(
        `Generado ${new Date().toLocaleDateString('es-BO')}${
          firmantes.elaboradoPor ? ` · ${firmantes.elaboradoPor}` : ''
        }`,
        MARGEN,
        MARGEN + 23,
        { width: ancho - 14, align: 'right' },
      );

    /*
     * El estado del periodo, en el papel que se firma.
     *
     * Sin esto no hay forma de distinguir el informe de un mes ya cerrado del
     * de un borrador que todavía se está corrigiendo: los dos salen iguales, y
     * las cifras de un mes sin cerrar pueden cambiar al día siguiente. El
     * sello PRELIMINAR es para que nadie autorice como definitivo un documento
     * que el sistema todavía considera editable.
     */
    const definitivo = estado === 'CERRADO' || estado === 'PAGADO';
    doc.text(
      definitivo ? `Periodo ${ESTADO_LEGIBLE[estado] ?? estado}` : 'PRELIMINAR · periodo no cerrado',
      MARGEN,
      MARGEN + 38,
      { width: ancho - 14, align: 'right' },
    );

    doc.fillColor(COLOR.textoOscuro);
    doc.y = MARGEN + 56;
  }

  /* ── Tabla ──────────────────────────────────────────────────────────── */

  private tabla(doc: Doc, informe: InformeComisiones, yInicial: number): number {
    let y = this.cabeceraTabla(doc, yInicial);

    for (const fila of informe.ventas) {
      y = this.saltarPaginaSiHaceFalta(doc, y, 40);
      y = this.filaDatos(doc, fila, y, false);
    }

    const hayMarketing = informe.marketing.length > 0;
    y = this.filaTotal(
      doc,
      hayMarketing ? 'TOTAL EQUIPO DE VENTAS' : 'TOTALES',
      informe.totalVentas,
      y,
      false,
    );

    if (hayMarketing) {
      y += 10;
      y = this.saltarPaginaSiHaceFalta(doc, y, 80);
      y = this.seccion(doc, 'EQUIPO DE MARKETING — cobra bono, no comisiona', y);
      for (const fila of informe.marketing) {
        y = this.filaDatos(doc, fila, y, true);
      }
      y = this.filaTotal(doc, 'TOTAL MARKETING', informe.totalMarketing, y, true);

      y += 8;
      y = this.filaTotal(doc, 'TOTAL GENERAL A PAGAR', informe.totalGeneral, y, false, true);
    }

    return y;
  }

  private cabeceraTabla(doc: Doc, y: number): number {
    const ancho = doc.page.width - MARGEN * 2;
    doc.rect(MARGEN, y, ancho, ALTO_CABECERA).fill(COLOR.primary);

    doc.font('Helvetica-Bold').fontSize(7).fillColor(COLOR.blanco);
    let x = MARGEN;
    for (const col of COLUMNAS) {
      doc.text(col.titulo, x + 4, y + 7, {
        width: col.ancho - 8,
        align: col.alineacion,
        lineBreak: false,
      });
      x += col.ancho;
    }

    doc.fillColor(COLOR.textoOscuro);
    return y + ALTO_CABECERA;
  }

  private filaDatos(doc: Doc, fila: FilaInforme, y: number, esMarketing: boolean): number {
    const ancho = doc.page.width - MARGEN * 2;

    doc
      .moveTo(MARGEN, y + ALTO_FILA)
      .lineTo(MARGEN + ancho, y + ALTO_FILA)
      .lineWidth(0.5)
      .strokeColor(COLOR.borde)
      .stroke();

    doc.font('Helvetica').fontSize(7).fillColor(COLOR.textoOscuro);
    let x = MARGEN;
    for (const col of COLUMNAS) {
      const vacia = esMarketing && COLUMNAS_SOLO_VENTAS.has(col.titulo);
      const texto = vacia ? '' : (col.valor(fila) ?? '');
      if (texto) {
        doc.text(texto, x + 4, y + 5, {
          width: col.ancho - 8,
          align: col.alineacion,
          lineBreak: false,
          ellipsis: true,
        });
      }
      x += col.ancho;
    }

    return y + ALTO_FILA;
  }

  private filaTotal(
    doc: Doc,
    etiqueta: string,
    totales: TotalesBloque,
    y: number,
    esMarketing: boolean,
    destacado = false,
  ): number {
    const ancho = doc.page.width - MARGEN * 2;
    const alto = ALTO_FILA + 3;

    doc.rect(MARGEN, y, ancho, alto).fill(destacado ? COLOR.primary : COLOR.fondoSuave);

    const colorTexto = destacado ? COLOR.blanco : COLOR.primary;
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(colorTexto);

    let x = MARGEN;
    for (const [indice, col] of COLUMNAS.entries()) {
      /* La etiqueta ocupa las dos primeras columnas (nombre + código): "TOTAL
         GENERAL A PAGAR" no cabe en 130 pt y partido en dos líneas rompería la
         altura de la fila. */
      if (indice === 0) {
        doc.text(etiqueta, x + 4, y + 6, {
          width: COLUMNAS[0].ancho + COLUMNAS[1].ancho - 8,
          align: 'left',
          lineBreak: false,
        });
        x += col.ancho;
        continue;
      }
      if (indice === 1) {
        x += col.ancho;
        continue;
      }

      const vacia = esMarketing && COLUMNAS_SOLO_VENTAS.has(col.titulo);
      const texto = vacia ? '' : (col.total(totales) ?? '');
      if (texto) {
        doc.text(texto, x + 4, y + 6, {
          width: col.ancho - 8,
          align: col.alineacion,
          lineBreak: false,
        });
      }
      x += col.ancho;
    }

    doc.fillColor(COLOR.textoOscuro);
    return y + alto;
  }

  private seccion(doc: Doc, texto: string, y: number): number {
    const ancho = doc.page.width - MARGEN * 2;
    doc.rect(MARGEN, y, ancho, ALTO_FILA).fill(COLOR.secondary);
    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor(COLOR.blanco)
      .text(texto, MARGEN + 4, y + 5, { width: ancho - 8, lineBreak: false });
    doc.fillColor(COLOR.textoOscuro);
    return y + ALTO_FILA;
  }

  /**
   * La misma declaración que lleva el Excel: si faltan vendedoras dadas de baja,
   * el documento lo dice. Un informe firmado al que le falta gente sin avisar
   * hace que quien lo cuadre contra su propia planilla busque un error que no
   * existe.
   */
  private avisoOcultas(
    doc: Doc,
    consolidado: { incluyeOcultas: boolean; ocultas: ReadonlyArray<{ nombre: string; codigo: string }> },
    y: number,
  ): number {
    const fuera = consolidado.incluyeOcultas ? [] : consolidado.ocultas;
    if (fuera.length === 0) return y;

    const ancho = doc.page.width - MARGEN * 2;
    doc
      .font('Helvetica-Oblique')
      .fontSize(7)
      .fillColor(COLOR.textoSuave)
      .text(
        `No se listan ${fuera.length} vendedora(s) dada(s) de baja: ` +
          `${fuera.map(v => `${v.nombre} (${v.codigo})`).join(', ')}.`,
        MARGEN,
        y + 8,
        { width: ancho },
      );

    doc.fillColor(COLOR.textoOscuro);
    return y + 24;
  }

  /* ── Firmas ─────────────────────────────────────────────────────────── */

  /**
   * Las tres firmas, ancladas al pie de la página y no debajo de la tabla.
   *
   * Si fueran detrás del contenido, un mes con muchas vendedoras las empujaría
   * a mitad de la hoja siguiente y el documento dejaría de parecerse a sí mismo
   * de un mes a otro. En un papel que se archiva firmado, el sitio de la firma
   * es parte del formato.
   */
  private firmas(doc: Doc, firmantes: Firmantes, yContenido: number): number {
    const ancho = doc.page.width - MARGEN * 2;
    const y = doc.page.height - MARGEN - ALTO_FIRMAS;

    /* Si la tabla llegó hasta abajo, las firmas van en una hoja nueva enteras:
       partirlas —la línea en una página y el nombre en la siguiente— dejaría un
       documento que no se puede firmar. */
    if (yContenido > y - 12) {
      doc.addPage();
    }

    /* La aclaración del tipo de cambio va JUSTO encima de las firmas, no al pie
       de la página. Escribir por debajo del margen inferior hace que PDFKit
       abra una página nueva él solo, y el informe salía con una segunda hoja en
       blanco con una sola línea. */
    doc
      .font('Helvetica')
      .fontSize(6.5)
      .fillColor(COLOR.textoSuave)
      .text(
        'Los importes en bolivianos se convirtieron con el tipo de cambio del periodo liquidado. ' +
          'Documento generado por el CRM de Clínica Montalvo.',
        MARGEN,
        y,
        { width: ancho, align: 'center', lineBreak: false },
      );

    const anchoCaja = ancho / 3;
    const casillas: Array<[string, string]> = [
      ['Elaborado por', firmantes.elaboradoPor],
      ['Revisado por', firmantes.revisadoPor],
      ['Autorizado por', firmantes.autorizadoPor],
    ];

    casillas.forEach(([rol, nombre], indice) => {
      const x = MARGEN + anchoCaja * indice;
      const anchoLinea = anchoCaja - 40;

      doc
        .moveTo(x + 20, y + 42)
        .lineTo(x + 20 + anchoLinea, y + 42)
        .lineWidth(0.8)
        .strokeColor(COLOR.textoOscuro)
        .stroke();

      /* Si no se sabe quién genera el informe, la línea queda para firmar a
         mano: es preferible un hueco a atribuirle la revisión a alguien. */
      doc
        .font('Helvetica-Bold')
        .fontSize(8.5)
        .fillColor(COLOR.textoOscuro)
        .text(nombre || ' ', x + 20, y + 48, { width: anchoLinea, align: 'center' });

      doc
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor(COLOR.textoSuave)
        .text(rol, x + 20, y + 60, { width: anchoLinea, align: 'center' });
    });

    doc.fillColor(COLOR.textoOscuro);
    return y;
  }

  /** Abre página nueva y repite la cabecera si lo que viene no cabe. */
  private saltarPaginaSiHaceFalta(doc: Doc, y: number, alturaNecesaria: number): number {
    const limite = doc.page.height - MARGEN - ALTO_FIRMAS;
    if (y + alturaNecesaria <= limite) return y;

    doc.addPage();
    return this.cabeceraTabla(doc, MARGEN);
  }
}
