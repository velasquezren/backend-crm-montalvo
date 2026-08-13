import { Injectable, NotFoundException } from '@nestjs/common';
import { Workbook, Worksheet } from 'exceljs';
import { Writable } from 'stream';

import { PrismaService } from '../../prisma/prisma.service';
import { AnaliticaComisionesService } from './analitica-comisiones.service';
import { CalculoComisionesService } from './calculo-comisiones.service';

/**
 * Exportación del informe mensual a Excel (requisito §12.7 del documento de
 * negocio: los reportes deben ser descargables).
 *
 * Se escribe en **streaming** contra la respuesta HTTP: el libro nunca se
 * materializa entero en memoria, así que un mes de 500 filas y uno de 50.000
 * cuestan lo mismo en RAM. Por eso también el detalle se pagina por lotes en
 * vez de traerse de golpe.
 *
 * Se usa ExcelJS y no el `xlsx` que ya estaba: la versión comunitaria de
 * SheetJS no escribe estilos, y este archivo lo abre administración para
 * revisarlo y firmarlo — necesita leerse como un documento, con cabeceras
 * legibles, formatos de moneda y totales, no como un volcado de datos.
 */

/** Colores de la identidad del CRM, en el formato ARGB que pide ExcelJS. */
const COLOR = {
  cabecera: 'FF1E293B',
  cabeceraTexto: 'FFFFFFFF',
  seccion: 'FFF1F5F9',
  totales: 'FFE2E8F0',
  borde: 'FFCBD5E1',
} as const;

/** Formatos numéricos: bolivianos, dólares y porcentaje. */
const FORMATO = {
  bob: '"Bs" #,##0.00',
  usd: '"$" #,##0.00',
  pct: '0.0"%"',
  entero: '#,##0',
} as const;

/** Cuántas filas de detalle se leen por vuelta al volcar la hoja de auditoría. */
const LOTE_DETALLE = 1000;

interface ColumnaInforme {
  titulo: string;
  clave: string;
  ancho: number;
  formato?: string;
}

@Injectable()
export class ExportacionComisionesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analitica: AnaliticaComisionesService,
    private readonly calculo: CalculoComisionesService,
  ) {}

  /** Nombre del archivo que verá quien lo descargue. */
  async nombreArchivo(periodoId: string): Promise<string> {
    const periodo = await this.prisma.periodoComision.findUnique({
      where: { id: periodoId },
      select: { anio: true, mes: true },
    });
    if (!periodo) {
      throw new NotFoundException(`Periodo ${periodoId} no encontrado`);
    }
    const mes = String(periodo.mes).padStart(2, '0');
    return `comisiones-${periodo.anio}-${mes}.xlsx`;
  }

  /**
   * Escribe el libro completo sobre el stream de salida.
   *
   * Cinco hojas, en el orden en que se leen: el resumen para la firma, la
   * planilla para pagar, y el resto como respaldo de cómo se llegó a esas
   * cifras.
   */
  async exportar(periodoId: string, salida: Writable): Promise<void> {
    const [informe, consolidado] = await Promise.all([
      this.analitica.analitica(periodoId),
      this.calculo.reporteConsolidado(periodoId).catch(() => null),
    ]);

    const libro = new Workbook();
    libro.creator = 'CRM — Clínica Montalvo';
    libro.created = new Date();

    this.hojaResumen(libro, informe);
    if (consolidado) {
      this.hojaLiquidacion(libro, consolidado);
    }
    this.hojaDistribucion(libro, informe);
    this.hojaRankings(libro, informe);
    await this.hojaDetalle(libro, periodoId);

    await libro.xlsx.write(salida);
  }

  /* ── Hoja 1: resumen ejecutivo ──────────────────────────────────────── */

  private hojaResumen(libro: Workbook, informe: InformeAnalitica): void {
    const hoja = libro.addWorksheet('Resumen', { views: [{ showGridLines: false }] });
    hoja.columns = [{ width: 38 }, { width: 20 }, { width: 30 }];

    const { periodo, resumen } = informe;
    this.titulo(hoja, `Informe de Comisiones · ${this.nombreMes(periodo.mes)} ${periodo.anio}`, 3);

    hoja.addRow([]);
    this.seccion(hoja, 'Periodo', 3);
    this.dato(hoja, 'Estado', periodo.estado);
    this.dato(hoja, 'Archivo importado', periodo.archivoNombre ?? '—');
    this.dato(hoja, 'Filas en el archivo', periodo.filasTotales, FORMATO.entero);
    this.dato(hoja, 'Tipo de cambio aplicado', resumen.tipoCambio);

    hoja.addRow([]);
    this.seccion(hoja, 'Facturación', 3);
    this.dato(hoja, 'Ventas comisionables', resumen.filasComisionables, FORMATO.entero);
    this.dato(hoja, 'Ventas excluidas del cálculo', resumen.filasExcluidas, FORMATO.entero);
    this.dato(hoja, 'Monto facturado', resumen.montoVendido, FORMATO.usd);
    this.dato(hoja, 'Impuestos descontados', resumen.impuestosDescontados, FORMATO.bob);
    this.dato(hoja, 'Base de cálculo', resumen.baseCalculo, FORMATO.bob);
    this.dato(hoja, 'Ticket promedio', resumen.ticketPromedio, FORMATO.bob);
    this.dato(hoja, 'Venta mayor', resumen.ventaMayor, FORMATO.bob);
    this.dato(hoja, 'Pacientes atendidos', resumen.pacientesUnicos, FORMATO.entero);
    this.dato(hoja, 'Servicios distintos', resumen.serviciosDistintos, FORMATO.entero);

    hoja.addRow([]);
    this.seccion(hoja, 'Comisiones a pagar', 3);
    this.dato(hoja, 'Vendedoras liquidadas', resumen.vendedorasLiquidadas, FORMATO.entero);
    this.dato(hoja, 'Tipo A · Planes y paquetes', resumen.comisionTipoAUsd, FORMATO.usd);
    this.dato(hoja, 'Tipo B · Cirugías y Reproducción Asistida', resumen.comisionTipoBUsd, FORMATO.usd);
    this.dato(hoja, 'Tipo C · Consultas, laboratorios y otros', resumen.comisionTipoCUsd, FORMATO.usd);
    this.dato(hoja, 'Bonos', resumen.bonosUsd, FORMATO.usd);

    const total = this.dato(hoja, 'TOTAL EN DÓLARES', resumen.comisionTotalUsd, FORMATO.usd);
    const totalBs = this.dato(hoja, 'TOTAL EN BOLIVIANOS', resumen.comisionTotalBob, FORMATO.bob);
    for (const fila of [total, totalBs]) {
      fila.font = { bold: true, size: 12 };
      fila.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.totales } };
      fila.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.totales } };
    }

    if (resumen.vendedorasLiquidadas === 0) {
      hoja.addRow([]);
      const aviso = hoja.addRow(['El periodo aún no se ha calculado: las cifras de comisión están en cero.']);
      aviso.font = { italic: true, color: { argb: 'FFB91C1C' } };
    }
  }

  /* ── Hoja 2: la planilla que se paga ────────────────────────────────── */

  private hojaLiquidacion(libro: Workbook, consolidado: ConsolidadoPeriodo): void {
    const columnas: ColumnaInforme[] = [
      { titulo: 'Vendedora', clave: 'nombre', ancho: 32 },
      { titulo: 'Código', clave: 'codigo', ancho: 10 },
      { titulo: 'Tipo', clave: 'tipo', ancho: 12 },
      { titulo: 'Área', clave: 'area', ancho: 14 },
      { titulo: 'Facturado (USD)', clave: 'montoVendido', ancho: 16, formato: FORMATO.usd },
      { titulo: 'Base de cálculo (Bs)', clave: 'baseCalculo', ancho: 18, formato: FORMATO.bob },
      { titulo: 'Planes', clave: 'planesVendidos', ancho: 9, formato: FORMATO.entero },
      { titulo: 'Cumple objetivo', clave: 'cumpleObjetivo', ancho: 15 },
      { titulo: 'Cirugías acum. (USD)', clave: 'acumuladoCirugias', ancho: 18, formato: FORMATO.usd },
      { titulo: 'Nivel', clave: 'nivelCirugia', ancho: 8 },
      { titulo: 'Tipo A ($)', clave: 'comisionA', ancho: 12, formato: FORMATO.usd },
      { titulo: 'Tipo B ($)', clave: 'comisionB', ancho: 12, formato: FORMATO.usd },
      { titulo: 'Tipo C ($)', clave: 'comisionC', ancho: 12, formato: FORMATO.usd },
      { titulo: 'Bonos ($)', clave: 'bonos', ancho: 12, formato: FORMATO.usd },
      { titulo: 'Total ($)', clave: 'totalUsd', ancho: 13, formato: FORMATO.usd },
      { titulo: 'Total (Bs)', clave: 'totalBob', ancho: 14, formato: FORMATO.bob },
      { titulo: 'Sueldo base (Bs)', clave: 'sueldoBase', ancho: 16, formato: FORMATO.bob },
      { titulo: 'A PAGAR (Bs)', clave: 'totalGanado', ancho: 17, formato: FORMATO.bob },
    ];

    const hoja = this.hojaConCabecera(libro, 'Liquidación', columnas);

    for (const f of consolidado.filas) {
      hoja.addRow({
        ...f,
        cumpleObjetivo: f.cumpleObjetivoPlanes ? 'Sí' : 'No',
        nivelCirugia: f.nivelCirugia ?? '—',
        bonos: f.totalBonos,
      });
    }

    const t = consolidado.totales;
    const totales = hoja.addRow({
      nombre: 'TOTALES',
      montoVendido: t['montoVendido'],
      baseCalculo: t['baseCalculo'],
      comisionA: t['comisionA'],
      comisionB: t['comisionB'],
      comisionC: t['comisionC'],
      bonos: t['bonos'],
      totalUsd: t['totalUsd'],
      totalBob: t['totalBob'],
      totalGanado: t['totalGanado'],
    });
    this.marcarTotales(totales, columnas.length);
  }

  /* ── Hoja 3: de dónde sale la facturación ───────────────────────────── */

  private hojaDistribucion(libro: Workbook, informe: InformeAnalitica): void {
    const columnas: ColumnaInforme[] = [
      { titulo: 'Agrupación', clave: 'grupo', ancho: 22 },
      { titulo: 'Concepto', clave: 'etiqueta', ancho: 36 },
      { titulo: 'Ventas', clave: 'cantidad', ancho: 10, formato: FORMATO.entero },
      { titulo: 'Facturado (USD)', clave: 'montoVendido', ancho: 17, formato: FORMATO.usd },
      { titulo: 'Base de cálculo (Bs)', clave: 'baseCalculo', ancho: 19, formato: FORMATO.bob },
      { titulo: '% del mes', clave: 'pctMonto', ancho: 11, formato: FORMATO.pct },
    ];

    const hoja = this.hojaConCabecera(libro, 'Distribución', columnas);

    const bloques: Array<[string, readonly PorcionInforme[]]> = [
      ['Categoría de servicio', informe.porClasificacion],
      ['Canal de venta', informe.porCanal],
      ['Módulo de origen', informe.porModulo],
      ['Unidad de negocio', informe.porUnidadNegocio],
      ['Nivel de plan', informe.porNivelPlan],
    ];

    for (const [grupo, porciones] of bloques) {
      for (const p of porciones) {
        hoja.addRow({ grupo, ...p });
      }
    }
  }

  /* ── Hoja 4: rankings y evolución ───────────────────────────────────── */

  private hojaRankings(libro: Workbook, informe: InformeAnalitica): void {
    const columnas: ColumnaInforme[] = [
      { titulo: 'Ranking', clave: 'grupo', ancho: 22 },
      { titulo: 'Concepto', clave: 'etiqueta', ancho: 48 },
      { titulo: 'Cantidad', clave: 'cantidad', ancho: 11, formato: FORMATO.entero },
      { titulo: 'Facturado (USD)', clave: 'montoVendido', ancho: 17, formato: FORMATO.usd },
      { titulo: '% del mes', clave: 'pctMonto', ancho: 11, formato: FORMATO.pct },
    ];

    const hoja = this.hojaConCabecera(libro, 'Rankings', columnas);

    for (const s of informe.topServicios) {
      hoja.addRow({ grupo: 'Servicio más facturado', ...s });
    }
    for (const m of informe.topMedicos) {
      hoja.addRow({ grupo: 'Médico', ...m });
    }
    for (const d of informe.porDia) {
      hoja.addRow({
        grupo: 'Día del mes',
        etiqueta: d.dia,
        cantidad: d.cantidad,
        montoVendido: d.montoVendido,
      });
    }
  }

  /* ── Hoja 5: detalle línea a línea (respaldo de auditoría) ──────────── */

  private async hojaDetalle(libro: Workbook, periodoId: string): Promise<void> {
    const columnas: ColumnaInforme[] = [
      { titulo: 'Fecha', clave: 'fecha', ancho: 12 },
      { titulo: 'Módulo', clave: 'modulo', ancho: 14 },
      { titulo: 'Servicio', clave: 'detalle', ancho: 44 },
      { titulo: 'Paciente', clave: 'paciente', ancho: 30 },
      { titulo: 'Médico', clave: 'medico', ancho: 30 },
      { titulo: 'Vendedora', clave: 'vendedoraNombre', ancho: 30 },
      { titulo: 'Captación', clave: 'captacion', ancho: 12 },
      { titulo: 'Canal', clave: 'canal', ancho: 11 },
      { titulo: 'Categoría', clave: 'clasif', ancho: 14 },
      { titulo: 'Tipo', clave: 'tipo', ancho: 7 },
      { titulo: 'Nivel', clave: 'nivel', ancho: 9 },
      { titulo: 'Precio (Bs)', clave: 'precio', ancho: 14, formato: FORMATO.bob },
      { titulo: 'Base (Bs)', clave: 'ingresoNeto', ancho: 14, formato: FORMATO.bob },
      { titulo: 'Comisiona', clave: 'comisiona', ancho: 11 },
      { titulo: 'Motivo de exclusión', clave: 'motivoExclusion', ancho: 38 },
    ];

    const hoja = this.hojaConCabecera(libro, 'Detalle', columnas);

    // Se pagina para que el consumo de memoria no dependa del tamaño del mes.
    let saltar = 0;
    for (;;) {
      const filas = await this.prisma.ventaImportada.findMany({
        where: { periodoId },
        orderBy: [{ fecha: 'asc' }, { detalle: 'asc' }],
        skip: saltar,
        take: LOTE_DETALLE,
        select: {
          fecha: true, modulo: true, detalle: true, paciente: true, medico: true,
          vendedoraNombre: true, captacion: true, canal: true, clasif: true, tipo: true,
          nivel: true, precio: true, ingresoNeto: true, comisionable: true,
          motivoExclusion: true,
        },
      });
      if (filas.length === 0) break;

      for (const f of filas) {
        hoja.addRow({
          ...f,
          fecha: f.fecha ? f.fecha.toISOString().slice(0, 10) : '',
          nivel: f.nivel ?? '',
          precio: Number(f.precio),
          ingresoNeto: Number(f.ingresoNeto),
          comisiona: f.comisionable ? 'Sí' : 'No',
          motivoExclusion: f.motivoExclusion ?? '',
        });
      }

      if (filas.length < LOTE_DETALLE) break;
      saltar += LOTE_DETALLE;
    }
  }

  /* ── Utilidades de formato ──────────────────────────────────────────── */

  /** Hoja tabular con cabecera fija, autofiltro y formatos por columna. */
  private hojaConCabecera(libro: Workbook, nombre: string, columnas: ColumnaInforme[]): Worksheet {
    const hoja = libro.addWorksheet(nombre, {
      views: [{ state: 'frozen', ySplit: 1 }], // la cabecera acompaña al scroll
    });

    hoja.columns = columnas.map(c => ({ header: c.titulo, key: c.clave, width: c.ancho }));

    const cabecera = hoja.getRow(1);
    cabecera.height = 22;
    cabecera.font = { bold: true, color: { argb: COLOR.cabeceraTexto }, size: 11 };
    cabecera.alignment = { vertical: 'middle', horizontal: 'left' };
    cabecera.eachCell(celda => {
      celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.cabecera } };
      celda.border = { bottom: { style: 'thin', color: { argb: COLOR.borde } } };
    });

    columnas.forEach((c, i) => {
      if (!c.formato) return;
      const columna = hoja.getColumn(i + 1);
      columna.numFmt = c.formato;
      columna.alignment = { horizontal: 'right' };
    });

    // Filtrar y ordenar desde el propio Excel, que es como se revisa el informe.
    hoja.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columnas.length } };
    return hoja;
  }

  private titulo(hoja: Worksheet, texto: string, columnas: number): void {
    const fila = hoja.addRow([texto]);
    fila.height = 28;
    fila.font = { bold: true, size: 15 };
    hoja.mergeCells(fila.number, 1, fila.number, columnas);
  }

  private seccion(hoja: Worksheet, texto: string, columnas: number): void {
    const fila = hoja.addRow([texto]);
    fila.font = { bold: true, size: 11 };
    fila.eachCell(celda => {
      celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.seccion } };
    });
    hoja.mergeCells(fila.number, 1, fila.number, columnas);
  }

  private dato(hoja: Worksheet, etiqueta: string, valor: string | number, formato?: string) {
    const fila = hoja.addRow([etiqueta, valor]);
    if (formato) {
      fila.getCell(2).numFmt = formato;
      fila.getCell(2).alignment = { horizontal: 'right' };
    }
    return fila;
  }

  private marcarTotales(fila: ReturnType<Worksheet['addRow']>, columnas: number): void {
    fila.font = { bold: true };
    for (let i = 1; i <= columnas; i++) {
      const celda = fila.getCell(i);
      celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.totales } };
      celda.border = { top: { style: 'medium', color: { argb: COLOR.cabecera } } };
    }
  }

  private nombreMes(mes: number): string {
    const meses = [
      'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
      'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
    ];
    return meses[mes - 1] ?? String(mes);
  }
}

/* Tipos de lo que devuelven los servicios de analítica y cálculo. Se declaran
   aquí para no exponer los internos de Prisma en la firma de la exportación. */

interface PorcionInforme {
  etiqueta: string;
  cantidad: number;
  montoVendido: number;
  baseCalculo: number;
  pctMonto: number;
}

type InformeAnalitica = Awaited<ReturnType<AnaliticaComisionesService['analitica']>>;
type ConsolidadoPeriodo = Awaited<ReturnType<CalculoComisionesService['reporteConsolidado']>>;
