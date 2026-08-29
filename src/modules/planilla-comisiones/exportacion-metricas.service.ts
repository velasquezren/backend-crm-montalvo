import { Injectable, NotFoundException } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { Writable } from 'stream';

import { PrismaService } from '../../prisma/prisma.service';
import { CalculoComisionesService } from './calculo-comisiones.service';
import {
  armarInforme,
  FilaInforme,
  formatearNumero,
  formatearPorcentaje,
} from './informe-liquidacion';

/**
 * Métricas de comisiones por vendedora, en PDF.
 *
 * **Es el acompañante del informe Word, no su sustituto.** El Word es el
 * documento que se firma —cifras exactas, una tabla, tres firmas—; este
 * responde la otra pregunta, la que no se contesta con una tabla: quién vendió
 * más, de dónde salió la comisión de cada quien y quién cumplió su objetivo.
 * Por eso va en PDF y no en Word: no se edita, se imprime y se adjunta.
 *
 * ## Por qué se dibuja a mano
 *
 * Sin librería de gráficos: son barras, y una barra es un rectángulo. Meter
 * Chart.js obligaría a un canvas —y por tanto a `node-canvas`, binario nativo—
 * o a un navegador, que es justo lo que no cabe en un servicio con
 * `MemoryMax=400M`. PDFKit dibuja rectángulos sobre el stream de la respuesta.
 *
 * ## Los colores sí son funcionales acá
 *
 * El informe Word es negro sobre blanco a propósito. En un gráfico el color no
 * decora: es lo que separa una serie de otra. Se usa una rampa derivada del
 * verde de la clínica —ni arcoíris ni escala de grises, que en cinco segmentos
 * deja de distinguirse.
 */

const COLOR = {
  texto: '#1F2937',
  suave: '#6B7280',
  linea: '#E5E7EB',
  fondo: '#F8F9FA',
  blanco: '#FFFFFF',
} as const;

/**
 * La rampa de los cinco conceptos de comisión.
 *
 * Ordenada de más oscuro a más claro para que, apiladas, se lean como una sola
 * pieza y no como cinco colores peleándose. Sale del primary/secondary de la
 * marca mezclados con blanco, el mismo criterio que `crm-design-system` fija
 * para las rampas del frontend.
 */
const SERIES = [
  { clave: 'comisionA', titulo: 'Tipo A · Planes', color: '#00443C' },
  { clave: 'comisionTipoARA', titulo: 'Tipo A (RA)', color: '#006156' },
  { clave: 'comisionB', titulo: 'Tipo B · Cirugías', color: '#39ADA3' },
  { clave: 'comisionC', titulo: 'Tipo C · Servicios', color: '#8FD3CC' },
  { clave: 'totalBonos', titulo: 'Bonos', color: '#C3D4D1' },
] as const;

const MARGEN = 40;
const MESES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

type Doc = PDFKit.PDFDocument;

@Injectable()
export class ExportacionMetricasService {
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
    return `metricas-comisiones-${periodo.anio}-${String(periodo.mes).padStart(2, '0')}.pdf`;
  }

  async exportar(
    periodoId: string,
    salida: Writable,
    opciones: { incluirOcultas?: boolean } = {},
  ): Promise<void> {
    const consolidado = await this.calculo.reporteConsolidado(
      periodoId,
      opciones.incluirOcultas ?? false,
    );
    const informe = armarInforme(consolidado.filas);
    /* Las fichas individuales son de quien vende: marketing no tiene facturación
       ni objetivo que mostrar, y su bono ya sale en el panorama del equipo. */
    const vendedoras = informe.ventas;

    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGEN,
      info: {
        Title: `Métricas de Comisiones ${consolidado.periodo.mes}/${consolidado.periodo.anio}`,
        Author: 'Clínica Montalvo',
      },
    });
    doc.pipe(salida);

    this.panorama(doc, consolidado.periodo, informe.totalGeneral, vendedoras);
    this.fichas(doc, vendedoras);

    doc.end();
  }

  /* ── Página 1: el equipo de un vistazo ──────────────────────────────── */

  private panorama(
    doc: Doc,
    periodo: { mes: number; anio: number; tipoCambio: unknown },
    totales: { montoVendido: number; totalUsd: number; totalBob: number },
    vendedoras: FilaInforme[],
  ): void {
    const ancho = doc.page.width - MARGEN * 2;

    this.titulo(doc, 'Métricas de Comisiones', `${MESES[periodo.mes - 1]} ${periodo.anio}`);

    let y = MARGEN + 62;

    /* Cuatro cifras y ninguna más: si esta fila necesita explicación, deja de
       ser un panorama. */
    const efectivo =
      totales.montoVendido > 0 ? (totales.totalUsd / totales.montoVendido) * 100 : 0;
    y = this.filaKpis(doc, y, ancho, [
      ['Facturación del mes', `$us ${formatearNumero(totales.montoVendido)}`],
      ['Comisiones a pagar', `Bs ${formatearNumero(totales.totalBob)}`],
      ['Vendedoras liquidadas', String(vendedoras.length)],
      ['Comisión sobre venta', formatearPorcentaje(efectivo, 2)],
    ]);

    y += 26;
    y = this.grafico(
      doc,
      y,
      ancho,
      'Facturación por vendedora',
      '$us',
      vendedoras,
      f => f.montoVendido,
      '#006156',
    );

    y += 22;
    y = this.grafico(
      doc,
      y,
      ancho,
      'Comisión ganada por vendedora',
      'Bs',
      vendedoras,
      f => f.totalBob,
      '#39ADA3',
    );

    y += 22;
    this.composicionEquipo(doc, y, ancho, vendedoras);
  }

  /** Título de página, sobrio: texto y un filete. Sin bloques de color. */
  private titulo(doc: Doc, texto: string, subtitulo: string): void {
    const ancho = doc.page.width - MARGEN * 2;

    doc
      .font('Helvetica-Bold')
      .fontSize(16)
      .fillColor(COLOR.texto)
      .text('CLÍNICA MONTALVO', MARGEN, MARGEN, { width: ancho });

    doc
      .font('Helvetica')
      .fontSize(11)
      .fillColor(COLOR.suave)
      .text(`${texto} · ${subtitulo}`, MARGEN, MARGEN + 20, { width: ancho });

    doc
      .moveTo(MARGEN, MARGEN + 42)
      .lineTo(MARGEN + ancho, MARGEN + 42)
      .lineWidth(1)
      .strokeColor(COLOR.linea)
      .stroke();

    doc.fillColor(COLOR.texto);
  }

  private filaKpis(doc: Doc, y: number, ancho: number, kpis: Array<[string, string]>): number {
    const alto = 46;
    const separacion = 8;
    const anchoCaja = (ancho - separacion * (kpis.length - 1)) / kpis.length;

    kpis.forEach(([etiqueta, valor], i) => {
      const x = MARGEN + (anchoCaja + separacion) * i;
      doc.roundedRect(x, y, anchoCaja, alto, 4).fillAndStroke(COLOR.fondo, COLOR.linea);

      doc
        .font('Helvetica')
        .fontSize(7)
        .fillColor(COLOR.suave)
        .text(etiqueta.toUpperCase(), x + 9, y + 9, { width: anchoCaja - 18, lineBreak: false });

      doc
        .font('Helvetica-Bold')
        .fontSize(12)
        .fillColor(COLOR.texto)
        .text(valor, x + 9, y + 22, { width: anchoCaja - 18, lineBreak: false });
    });

    return y + alto;
  }

  /**
   * Barras horizontales, ordenadas de mayor a menor.
   *
   * Horizontales y no verticales porque la etiqueta es un nombre completo:
   * en vertical habría que rotarlo o abreviarlo, y un informe donde hay que
   * girar la cabeza no lo lee nadie.
   */
  private grafico(
    doc: Doc,
    y: number,
    ancho: number,
    titulo: string,
    unidad: string,
    filas: FilaInforme[],
    valorDe: (f: FilaInforme) => number,
    color: string,
  ): number {
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(COLOR.texto)
      .text(titulo, MARGEN, y, { width: ancho });

    let cursor = y + 16;
    const ordenadas = [...filas].sort((a, b) => valorDe(b) - valorDe(a));
    const maximo = Math.max(...ordenadas.map(valorDe), 1);

    const anchoNombre = 150;
    const anchoValor = 82;
    const anchoBarra = ancho - anchoNombre - anchoValor;
    const altoBarra = 11;

    for (const fila of ordenadas) {
      const valor = valorDe(fila);
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(COLOR.texto)
        .text(fila.nombre, MARGEN, cursor + 1, {
          width: anchoNombre - 8,
          lineBreak: false,
          ellipsis: true,
        });

      /* El carril completo, para que una barra corta se lea como "poco" y no
         como "no hay dato". */
      doc
        .rect(MARGEN + anchoNombre, cursor, anchoBarra, altoBarra)
        .fill(COLOR.fondo);

      const largo = Math.max((valor / maximo) * anchoBarra, valor > 0 ? 1.5 : 0);
      if (largo > 0) {
        doc.rect(MARGEN + anchoNombre, cursor, largo, altoBarra).fill(color);
      }

      doc
        .font('Helvetica-Bold')
        .fontSize(8)
        .fillColor(COLOR.texto)
        .text(`${unidad} ${formatearNumero(valor)}`, MARGEN + anchoNombre + anchoBarra + 6, cursor + 1, {
          width: anchoValor - 6,
          align: 'right',
          lineBreak: false,
        });

      cursor += altoBarra + 6;
    }

    return cursor;
  }

  /** De qué está hecha la comisión del equipo: una barra apilada y su leyenda. */
  private composicionEquipo(doc: Doc, y: number, ancho: number, filas: FilaInforme[]): void {
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(COLOR.texto)
      .text('De dónde sale la comisión del equipo', MARGEN, y, { width: ancho });

    const segmentos = SERIES.map(s => ({
      ...s,
      valor: filas.reduce((total, f) => total + f[s.clave], 0),
    }));

    this.barraApilada(doc, MARGEN, y + 16, ancho, 18, segmentos);
    this.leyenda(doc, MARGEN, y + 42, ancho, segmentos);
  }

  private barraApilada(
    doc: Doc,
    x: number,
    y: number,
    ancho: number,
    alto: number,
    segmentos: ReadonlyArray<{ valor: number; color: string }>,
  ): void {
    const total = segmentos.reduce((s, seg) => s + seg.valor, 0);
    if (total <= 0) {
      doc.rect(x, y, ancho, alto).fill(COLOR.fondo);
      return;
    }

    let cursor = x;
    for (const seg of segmentos) {
      if (seg.valor <= 0) continue;
      const largo = (seg.valor / total) * ancho;
      doc.rect(cursor, y, largo, alto).fill(seg.color);
      cursor += largo;
    }
  }

  private leyenda(
    doc: Doc,
    x: number,
    y: number,
    ancho: number,
    segmentos: ReadonlyArray<{ titulo: string; color: string; valor: number }>,
  ): number {
    const total = segmentos.reduce((s, seg) => s + seg.valor, 0);
    const porColumna = Math.ceil(segmentos.length / 3);
    const anchoColumna = ancho / 3;

    segmentos.forEach((seg, i) => {
      const columna = Math.floor(i / porColumna);
      const fila = i % porColumna;
      const cx = x + anchoColumna * columna;
      const cy = y + fila * 13;

      doc.rect(cx, cy + 2, 7, 7).fill(seg.color);
      const pct = formatearPorcentaje(total > 0 ? (seg.valor / total) * 100 : 0);
      doc
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor(COLOR.suave)
        .text(`${seg.titulo}  ·  $us ${formatearNumero(seg.valor)}  (${pct})`, cx + 12, cy + 1, {
          width: anchoColumna - 18,
          lineBreak: false,
          ellipsis: true,
        });
    });

    doc.fillColor(COLOR.texto);
    return y + porColumna * 13;
  }

  /* ── Fichas individuales ────────────────────────────────────────────── */

  /** Tres por página: caben sin apretarse y no obligan a pasar hoja por cada una. */
  private fichas(doc: Doc, vendedoras: FilaInforme[]): void {
    const ancho = doc.page.width - MARGEN * 2;
    const altoFicha = 178;
    const porPagina = 3;

    vendedoras.forEach((fila, indice) => {
      if (indice % porPagina === 0) {
        doc.addPage();
        this.titulo(doc, 'Detalle por vendedora', `${indice + 1}–${Math.min(indice + porPagina, vendedoras.length)} de ${vendedoras.length}`);
      }

      const y = MARGEN + 62 + (indice % porPagina) * altoFicha;
      this.ficha(doc, y, ancho, fila);
    });
  }

  private ficha(doc: Doc, y: number, ancho: number, f: FilaInforme): void {
    doc.roundedRect(MARGEN, y, ancho, 160, 5).fillAndStroke(COLOR.blanco, COLOR.linea);

    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(COLOR.texto)
      .text(f.nombre, MARGEN + 14, y + 12, { width: ancho - 28, lineBreak: false, ellipsis: true });

    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(COLOR.suave)
      .text(`Código ${f.codigo}`, MARGEN + 14, y + 26, { width: ancho - 28, lineBreak: false });

    /* Las tres cifras que se miran primero. El resto está en la tabla del Word;
       acá interesa la proporción, no el céntimo. */
    const efectivo = f.montoVendido > 0 ? (f.totalUsd / f.montoVendido) * 100 : 0;
    const datos: Array<[string, string]> = [
      ['Facturado', `$us ${formatearNumero(f.montoVendido)}`],
      ['Comisión', `Bs ${formatearNumero(f.totalBob)}`],
      ['Sobre venta', formatearPorcentaje(efectivo, 2)],
    ];
    datos.forEach(([etiqueta, valor], i) => {
      const x = MARGEN + 14 + i * ((ancho - 28) / 3);
      doc
        .font('Helvetica')
        .fontSize(7)
        .fillColor(COLOR.suave)
        .text(etiqueta.toUpperCase(), x, y + 44, { width: 110, lineBreak: false });
      doc
        .font('Helvetica-Bold')
        .fontSize(11)
        .fillColor(COLOR.texto)
        .text(valor, x, y + 55, { width: 130, lineBreak: false });
    });

    const segmentos = SERIES.map(s => ({ ...s, valor: f[s.clave] }));
    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .fillColor(COLOR.texto)
      .text('Composición de su comisión', MARGEN + 14, y + 80);
    this.barraApilada(doc, MARGEN + 14, y + 93, ancho - 28, 13, segmentos);
    this.leyenda(doc, MARGEN + 14, y + 111, ancho - 28, segmentos);

    this.objetivos(doc, y + 111, ancho, f);
  }

  /**
   * Si cumplió sus objetivos de planes, en texto.
   *
   * El objetivo no se guarda en la fila, pero se deduce: `comisionables` es
   * `vendidos − objetivo`, así que el objetivo es la resta. Se muestra porque
   * es la pregunta que sigue a "¿cuánto cobró?" — y explica un Tipo A en cero
   * mucho mejor que el propio cero.
   */
  private objetivos(doc: Doc, y: number, ancho: number, f: FilaInforme): void {
    const paqVendidos = f.planpaqVendidos ?? 0;
    const paqComisionan = f.planpaqComisionables ?? 0;
    const ninVendidos = f.planninVendidos ?? 0;
    const ninComisionan = f.planninComisionables ?? 0;

    const texto =
      `Paquetes de maternidad: ${paqVendidos} vendidos · meta ${paqVendidos - paqComisionan} · ` +
      `${paqComisionan} comisionan          ` +
      `Planes varios: ${ninVendidos} vendidos · meta ${ninVendidos - ninComisionan} · ` +
      `${ninComisionan} comisionan`;

    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(COLOR.suave)
      .text(texto, MARGEN + 14, y + 28, { width: ancho - 28, lineBreak: false, ellipsis: true });

    doc.fillColor(COLOR.texto);
  }
}
