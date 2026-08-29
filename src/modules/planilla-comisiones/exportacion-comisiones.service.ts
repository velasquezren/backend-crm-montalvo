import { Injectable, NotFoundException } from '@nestjs/common';
import { AreaVendedora, ClasifComision, UnidadNegocio } from '@prisma/client';
import { TableColumnProperties, Workbook, Worksheet } from 'exceljs';
import { Writable } from 'stream';

import { PrismaService } from '../../prisma/prisma.service';
import {
  AnaliticaComisionesService,
  ETIQUETA_CANAL,
  ETIQUETA_CLASIF,
  ETIQUETA_UNIDAD,
} from './analitica-comisiones.service';
import { CalculoComisionesService, FotoConfiguracion, LineaDesglose } from './calculo-comisiones.service';
import { redondear } from './clasificador';
import { PlanCandidato, seleccionarPlanesComisionables, ultimoPrimero } from './reglas-calculo';

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
 *
 * ## Vocabulario: el mismo que usa administración, no el nuestro
 *
 * Las hojas "Tipo A (RA)" y "Planes por Vendedora" se diseñaron leyendo
 * `CALCULO COMISION DICIEMBRE 2025.xlsx` (hoja `BDEjecutivas`, columnas
 * AT-BD, y `PARAMETROS`). Donde el Excel de administración ya tiene un
 * nombre para un número — `MONTOBJETIVO`, `SUMA MONTO COMISIONABLE`,
 * `NIVEL n` — esa hoja lo usa entre paréntesis junto al nombre en español
 * llano, para que quien ya conoce su propio Excel reconozca el número al
 * primer vistazo. Ver las notas de celda (▲ roja en la cabecera) de cada
 * hoja para el detalle de cada fórmula.
 */

/** Colores de la identidad del CRM, en el formato ARGB que pide ExcelJS. */
const COLOR = {
  cabecera: 'FF1E293B',
  cabeceraTexto: 'FFFFFFFF',
  seccion: 'FFF1F5F9',
  totales: 'FFE2E8F0',
  borde: 'FFCBD5E1',
} as const;

/**
 * Formatos numéricos.
 *
 * `usd`/`bob` son moneda; `pct` espera el número YA en puntos porcentuales
 * (ej. `4.5` para "4,5%") — es un formato de texto, no el `0.0%` nativo de
 * Excel, que sí divide entre 100 solo.
 *
 * **Ojo: no todo lo que se llama "pct" está en la misma unidad.**
 * `pctMonto` (`AnaliticaComisionesService.porcentaje()`) parte de una
 * fracción y la multiplica por 100 a propósito. Pero `pctEmpresa`/`pctPropio`
 * de `NivelCirugia`/`NivelTipoARA`/`TarifaPlan`/`TarifaServicio` NACEN en
 * puntos porcentuales — así los siembra `configuracion-por-defecto.ts`
 * (`pctEmpresa: 4.5`) y así los usa el propio motor de cálculo
 * (`comisionUsd = base * porcentaje / 100`, sin dividir entre 100 antes).
 * Multiplicarlos por 100 de nuevo —lo que hacía esta hoja hasta que salió
 * "450.0%" en vez de "4.5%"— infla el número cien veces. Antes de tocar un
 * `%`, confirmar la unidad real contra el sembrado o el motor, nunca contra
 * el nombre del campo.
 */
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
   * Siete hojas fijas, en el orden en que se leen: el resumen para la firma,
   * la planilla para pagar, el desglose de los dos cubos que tienen más de un
   * paso (Tipo A (RA) y los planes elegidos), y el resto como respaldo de
   * cómo se llegó a esas cifras. **Más una hoja por vendedora (2026-08-26)**
   * con el cálculo completo de esa persona — ver `hojasPorVendedora()`, la
   * respuesta a que la tabla web (`tabla-liquidacion.component.ts`) resume
   * cada vendedora en 14 columnas por falta de ancho, cuando el cálculo real
   * tiene más de 20 números por persona.
   *
   * ## Vendedoras dadas de baja (`incluirOcultas`)
   *
   * Este archivo es el que sale de la clínica: se imprime, se firma y se
   * archiva. Por eso las vendedoras marcadas como ocultas **no salen por
   * defecto** en las hojas que van por persona — es exactamente para lo que
   * sirve la marca.
   *
   * Dos reglas que no son negociables, y conviene no "simplificarlas":
   *
   * 1. **Se oculta la persona, nunca el dinero.** Las hojas de facturación
   *    (Resumen, Distribución, Rankings y el Detalle línea a línea) siguen
   *    contando sus ventas: eso es ingreso de la clínica y borrarlo dejaría el
   *    informe mintiendo sobre cuánto se facturó el mes.
   * 2. **La exclusión se declara.** El Resumen dice cuántas y cuáles se
   *    dejaron fuera. Un informe al que le falta gente sin avisar es peor que
   *    uno completo: quien lo cuadra contra su propio Excel no encuentra la
   *    diferencia y termina desconfiando de todo el archivo.
   *
   * `incluirOcultas: true` las devuelve al libro, para reeditar un mes en el
   * que la persona sí trabajaba.
   */
  async exportar(periodoId: string, salida: Writable, incluirOcultas = false): Promise<void> {
    const [informe, consolidado] = await Promise.all([
      this.analitica.analitica(periodoId),
      this.calculo.reporteConsolidado(periodoId, incluirOcultas).catch(() => null),
    ]);

    const libro = new Workbook();
    libro.creator = 'CRM — Clínica Montalvo';
    libro.created = new Date();

    this.hojaResumen(libro, informe, consolidado);
    if (consolidado) {
      this.hojaLiquidacion(libro, consolidado);
      this.hojaTipoARA(libro, consolidado);
      await this.hojaPlanesPorVendedora(libro, consolidado);
      await this.hojasPorVendedora(libro, consolidado);
    }
    this.hojaDistribucion(libro, informe);
    this.hojaRankings(libro, informe);
    await this.hojaDetalle(libro, periodoId);

    await libro.xlsx.write(salida);
  }

  /* ── Hoja 1: resumen ejecutivo ──────────────────────────────────────── */

  private hojaResumen(
    libro: Workbook,
    informe: InformeAnalitica,
    consolidado: ConsolidadoPeriodo | null,
  ): void {
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

    /*
     * Facturación: TODOS estos montos vienen de `precio`/`ingresoNeto` de
     * `VentaImportada`, que el export de FileMaker trae en DÓLARES (ver
     * `CLAUDE.md` del backend). Hasta 2026-08-24 esta sección los mostraba
     * con formato "Bs" sin convertir un centavo — el número era correcto,
     * pero la etiqueta mentía: "Base de cálculo: Bs 45.000" era en realidad
     * 45.000 DÓLARES, casi 7 veces más de lo que decía la etiqueta. Nadie lo
     * notó porque el número en sí parecía razonable para cualquiera de las
     * dos monedas.
     */
    hoja.addRow([]);
    this.seccion(hoja, 'Facturación (en dólares, la moneda del Excel de FileMaker)', 3);
    this.dato(hoja, 'Ventas comisionables', resumen.filasComisionables, FORMATO.entero);
    this.dato(hoja, 'Ventas excluidas del cálculo', resumen.filasExcluidas, FORMATO.entero);
    this.dato(hoja, 'Monto facturado', resumen.montoVendido, FORMATO.usd);
    this.dato(hoja, 'Impuestos descontados (13%)', resumen.impuestosDescontados, FORMATO.usd);
    this.dato(hoja, 'Base de cálculo', resumen.baseCalculo, FORMATO.usd);
    this.dato(hoja, 'Ticket promedio', resumen.ticketPromedio, FORMATO.usd);
    this.dato(hoja, 'Venta mayor', resumen.ventaMayor, FORMATO.usd);
    this.dato(hoja, 'Pacientes atendidos', resumen.pacientesUnicos, FORMATO.entero);
    this.dato(hoja, 'Servicios distintos', resumen.serviciosDistintos, FORMATO.entero);

    hoja.addRow([]);
    this.seccion(hoja, 'Comisiones a pagar (en dólares)', 3);
    this.dato(hoja, 'Vendedoras liquidadas', resumen.vendedorasLiquidadas, FORMATO.entero);
    /*
     * Va pegada al número que descuadra, no en un pie al final: quien cuadra
     * este informe contra su Excel mira "Vendedoras liquidadas", cuenta las
     * filas de la hoja "Liquidación" y le salen menos. La explicación tiene que
     * estar ahí mismo o el archivo entero pierde credibilidad.
     */
    /* Igual que con las dadas de baja: si el número de arriba no coincide con
       las filas de la tabla de ventas, esta línea dice por qué. */
    const enMarketing = (consolidado?.filas ?? []).filter(esMarketing);
    if (enMarketing.length > 0) {
      this.dato(
        hoja,
        'De ellas, equipo de marketing (cobra bono, no comisiona)',
        enMarketing.length,
        FORMATO.entero,
      );
    }

    const ocultasFuera = consolidado?.incluyeOcultas ? [] : (consolidado?.ocultas ?? []);
    if (ocultasFuera.length > 0) {
      this.dato(
        hoja,
        'De ellas, dadas de baja y NO listadas',
        ocultasFuera.length,
        FORMATO.entero,
      );
      for (const v of ocultasFuera) {
        this.dato(
          hoja,
          `   · ${v.nombre} (${v.codigo})`,
          v.motivoOculta ?? 'Sin motivo registrado',
        );
      }
    }
    this.dato(hoja, 'Tipo A · Planes de maternidad y varios', resumen.comisionTipoAUsd, FORMATO.usd);
    /*
     * Antes de 2026-08-24 esta sección no tenía línea propia para Tipo A
     * (RA): el dinero SÍ estaba en el TOTAL, pero no había forma de ver
     * cuánto era ni de dónde salía sin abrir la hoja "Tipo A (RA)" nueva —
     * que hasta esa fecha tampoco existía. Es justo el hueco que este
     * informe existe para tapar.
     */
    this.dato(
      hoja,
      'Tipo A (RA) · Consultas y análisis del área RA',
      resumen.comisionTipoARAUsd,
      FORMATO.usd,
    );
    this.dato(hoja, 'Tipo B · Cirugías e internaciones', resumen.comisionTipoBUsd, FORMATO.usd);
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
    } else {
      hoja.addRow([]);
      const nota = hoja.addRow([
        'El desglose completo de Tipo A (RA) —de dónde sale cada dólar y por qué— está en la hoja "Tipo A (RA)". ' +
          'Qué planes concretos comisionaron y por qué está en la hoja "Planes por Vendedora".',
      ]);
      nota.font = { italic: true, size: 10, color: { argb: 'FF64748B' } };
      hoja.mergeCells(nota.number, 1, nota.number, 3);
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
      { titulo: 'Base de cálculo (USD)', clave: 'baseCalculo', ancho: 18, formato: FORMATO.usd },
      { titulo: 'Planes', clave: 'planesVendidos', ancho: 9, formato: FORMATO.entero },
      { titulo: 'Cumple objetivo', clave: 'cumpleObjetivo', ancho: 15 },
      { titulo: 'Cirugías acum. (USD)', clave: 'acumuladoCirugias', ancho: 18, formato: FORMATO.usd },
      { titulo: 'Nivel cirugía', clave: 'nivelCirugia', ancho: 11 },
      { titulo: 'Nivel Tipo A (RA)', clave: 'nivelTipoARA', ancho: 14 },
      { titulo: 'Tipo A ($)', clave: 'comisionA', ancho: 12, formato: FORMATO.usd },
      { titulo: 'Tipo A RA ($)', clave: 'comisionTipoARA', ancho: 13, formato: FORMATO.usd },
      { titulo: 'Tipo B ($)', clave: 'comisionB', ancho: 12, formato: FORMATO.usd },
      { titulo: 'Tipo C ($)', clave: 'comisionC', ancho: 12, formato: FORMATO.usd },
      { titulo: 'Bonos ($)', clave: 'bonos', ancho: 12, formato: FORMATO.usd },
      { titulo: 'Total ($)', clave: 'totalUsd', ancho: 13, formato: FORMATO.usd },
      { titulo: 'Total (Bs)', clave: 'totalBob', ancho: 14, formato: FORMATO.bob },
      { titulo: 'Sueldo base (Bs)', clave: 'sueldoBase', ancho: 16, formato: FORMATO.bob },
      { titulo: 'A PAGAR (Bs)', clave: 'totalGanado', ancho: 17, formato: FORMATO.bob },
    ];

    const hoja = this.hojaConCabecera(libro, 'Liquidación', columnas);
    this.nota(
      hoja,
      'nivelTipoARA',
      'Nivel del cubo Tipo A (RA) — distinto del nivel de cirugía. Ver el desglose completo en la hoja "Tipo A (RA)".',
    );

    /*
     * Marketing va en su propio bloque, debajo. No es una preferencia estética:
     * su fila tiene 14 de las 20 columnas en cero —no vende, no tiene planes, no
     * llega a ningún nivel— y mezclada entre las ejecutivas obliga a leer fila
     * por fila para entender por qué. La planilla de administración ya lo
     * resuelve así: hoja "CALCULO BONOS", el bloque "EQUIPO DE PUBLICIDAD" de
     * las filas 47-51, aparte de la tabla de vendedoras.
     *
     * Se queda en la MISMA cuadrícula de columnas, eso sí, para que "Bonos",
     * "Sueldo base" y "A PAGAR" sigan alineadas de arriba abajo y se puedan
     * leer de un vistazo para toda la planilla.
     */
    const equipoVentas = consolidado.filas.filter(f => !esMarketing(f));
    const equipoMarketing = consolidado.filas.filter(esMarketing);

    for (const f of equipoVentas) {
      const fila = hoja.addRow({
        ...f,
        cumpleObjetivo: f.cumpleObjetivoPlanes ? 'Sí' : 'No',
        nivelCirugia: f.nivelCirugia ?? '—',
        nivelTipoARA: f.nivelTipoARA ? `NIVEL ${f.nivelTipoARA}` : 'NA',
        bonos: f.totalBonos,
      });
      /* Solo aparecen si se pidió incluirlas; en cursiva porque son de alguien
         que ya no está en el equipo y quien lea la hoja tiene que notarlo sin
         cruzar con otro documento. El nombre NO se decora con un sufijo: es la
         clave con la que se cruza contra el Excel de administración. */
      if (f.oculta) {
        fila.font = { italic: true };
        fila.getCell(1).note = `Dada de baja${
          f.ocultaDesde ? ` el ${f.ocultaDesde.toLocaleDateString('es-BO')}` : ''
        }. Se incluye porque se exportó con "incluir dadas de baja".`;
      }
    }

    /* El pie suma las filas que están JUSTO ENCIMA, no el periodo entero: con
       marketing en su propio bloque, usar el total del backend dejaría un
       "TOTALES" que no es la suma de lo que se ve. Al final de la hoja va el
       total general, que sí los junta. */
    const totales = hoja.addRow({
      nombre: equipoMarketing.length > 0 ? 'TOTAL EQUIPO DE VENTAS' : 'TOTALES',
      ...this.sumarFilas(equipoVentas),
    });
    this.marcarTotales(totales, columnas.length);

    if (equipoMarketing.length > 0) {
      this.bloqueMarketing(hoja, columnas, equipoMarketing, consolidado.totales);
    }

    /* El pie de la hoja que se firma. Los TOTALES de arriba son la suma exacta
       de las filas listadas —se recalculan en `reporteConsolidado()`— así que
       sin esta línea cuadran perfectamente y aun así les falta gente. */
    const fuera = consolidado.incluyeOcultas ? [] : consolidado.ocultas;
    if (fuera.length > 0) {
      hoja.addRow([]);
      const aviso = hoja.addRow([
        `No se listan ${fuera.length} vendedora(s) dada(s) de baja: ` +
          `${fuera.map(v => `${v.nombre} (${v.codigo})`).join(', ')}. ` +
          'Sus ventas siguen contando en las hojas de facturación; lo que no figura ' +
          'aquí es su liquidación. Para incluirlas, exporta marcando "incluir dadas de baja".',
      ]);
      aviso.font = { italic: true, size: 10, color: { argb: 'FF64748B' } };
      hoja.mergeCells(aviso.number, 1, aviso.number, columnas.length);
    }
  }

  /**
   * El bloque del equipo de marketing, debajo de la tabla de ventas.
   *
   * Cobra la mitad del pote de jefatura cada una y **no comisiona**: las
   * columnas de facturación, planes y niveles se dejan VACÍAS en vez de en
   * `$ 0,00`. Un cero dice "vendió y no llegó"; un hueco dice "esto no le
   * aplica", que es lo cierto y es lo que evita que alguien busque por qué
   * "no cumplió objetivo".
   *
   * Cierra con el total general, que es el único número que junta los dos
   * bloques: sin él, quien firma la planilla tendría que sumar a mano las dos
   * cifras de "A PAGAR" para saber cuánto sale de caja.
   */
  private bloqueMarketing(
    hoja: Worksheet,
    columnas: ColumnaInforme[],
    marketing: FilaConsolidado[],
    totalesDelPeriodo: Record<string, number>,
  ): void {
    hoja.addRow([]);
    this.seccion(hoja, 'EQUIPO DE MARKETING — cobra bono, no comisiona', columnas.length);

    for (const f of marketing) {
      hoja.addRow({
        nombre: f.nombre,
        codigo: f.codigo,
        tipo: f.tipo,
        area: f.area,
        bonos: f.totalBonos,
        totalUsd: f.totalUsd,
        totalBob: f.totalBob,
        sueldoBase: f.sueldoBase,
        totalGanado: f.totalGanado,
      });
    }

    /* El pie repite las MISMAS columnas que las filas de arriba y ninguna más:
       con `sumarFilas()` entero salían `$ 0,00` en Facturado, Tipo A, Tipo B…
       justo en las columnas que las filas dejan en blanco por no aplicarles.
       Un subtotal en cero bajo una columna vacía invita a buscar el error. */
    const suma = this.sumarFilas(marketing);
    const subtotal = hoja.addRow({
      nombre: 'TOTAL MARKETING',
      bonos: suma['bonos'],
      totalUsd: suma['totalUsd'],
      totalBob: suma['totalBob'],
      sueldoBase: suma['sueldoBase'],
      totalGanado: suma['totalGanado'],
    });
    this.marcarTotales(subtotal, columnas.length);

    hoja.addRow([]);
    const general = hoja.addRow({
      nombre: 'TOTAL GENERAL A PAGAR',
      bonos: totalesDelPeriodo['bonos'],
      totalUsd: totalesDelPeriodo['totalUsd'],
      totalBob: totalesDelPeriodo['totalBob'],
      sueldoBase: totalesDelPeriodo['sueldoBase'],
      totalGanado: totalesDelPeriodo['totalGanado'],
    });
    this.marcarTotales(general, columnas.length);
    general.font = { bold: true, size: 12 };

    const nota = hoja.getRow(general.number).getCell(1);
    nota.note =
      'Los dos bloques juntos: equipo de ventas + marketing. Es lo que sale de caja este mes.';
  }

  /**
   * Subtotal de un grupo de filas, con las MISMAS claves que escribe la tabla.
   *
   * Se suma acá y no se reutiliza `consolidado.totales` porque ese número es el
   * del periodo completo: con la hoja partida en dos bloques serviría para el
   * total general y para ninguno de los dos subtotales. Un pie que no es la
   * suma de las filas que tiene encima es peor que no tener pie.
   */
  private sumarFilas(filas: FilaConsolidado[]): Record<string, number> {
    const sumar = (obtener: (f: FilaConsolidado) => number) =>
      redondear(filas.reduce((acc, f) => acc + obtener(f), 0));

    return {
      montoVendido: sumar(f => f.montoVendido),
      baseCalculo: sumar(f => f.baseCalculo),
      comisionA: sumar(f => f.comisionA),
      comisionTipoARA: sumar(f => f.comisionTipoARA),
      comisionB: sumar(f => f.comisionB),
      comisionC: sumar(f => f.comisionC),
      bonos: sumar(f => f.totalBonos),
      totalUsd: sumar(f => f.totalUsd),
      totalBob: sumar(f => f.totalBob),
      /* El sueldo faltaba en la fila de TOTALES: "A PAGAR" ya incluía los
         sueldos pero su columna salía en blanco, así que el pie no cuadraba a
         ojo (Total Bs + Sueldo ≠ A PAGAR) sobre la única hoja que se firma. */
      sueldoBase: sumar(f => f.sueldoBase),
      totalGanado: sumar(f => f.totalGanado),
    };
  }

  /* ── Hoja 3: de dónde sale Tipo A (RA), paso a paso ─────────────────── */

  /**
   * El cubo que menos se entiende de la planilla, con sus dos ingredientes
   * separados en vez de solo el resultado.
   *
   * Antes de 2026-08-24, `ingresoMaternidadTipoARA`/`ingresoRATipoARA`/
   * `excedenteTipoARA` se calculaban dentro de `liquidarVendedora()` y se
   * descartaban en el mismo momento: solo `nivelTipoARA` y `comisionTipoARA`
   * llegaban a `ResultadoComision`. El motor sabía "de dónde salía" el
   * número exactamente una vez, al calcular, y lo olvidaba enseguida — ni la
   * pantalla ni ningún informe podían explicarlo después. Ahora esos tres
   * números se PERSISTEN junto al resultado, así que esta hoja siempre
   * muestra la derivación real de lo que se pagó, no una que se recalcula
   * (y podría no coincidir si la configuración cambió después de liquidar).
   */
  private hojaTipoARA(libro: Workbook, consolidado: ConsolidadoPeriodo): void {
    const foto = consolidado.periodo.configuracionUsada as unknown as FotoConfiguracion | null;
    const nivelesPorNumero = new Map((foto?.nivelesTipoARA ?? []).map(n => [n.nivel, n]));

    const columnas: ColumnaInforme[] = [
      { titulo: 'Vendedora', clave: 'nombre', ancho: 32 },
      { titulo: 'Código', clave: 'codigo', ancho: 10 },
      { titulo: 'Ingreso planes maternidad (USD)', clave: 'ingresoMaternidad', ancho: 26, formato: FORMATO.usd },
      { titulo: 'Ingreso RA — consulta/lab/eco/otros (USD)', clave: 'ingresoRA', ancho: 32, formato: FORMATO.usd },
      { titulo: 'Ingreso combinado (USD)', clave: 'combinado', ancho: 20, formato: FORMATO.usd },
      { titulo: 'Objetivo mensual (USD)', clave: 'objetivo', ancho: 18, formato: FORMATO.usd },
      { titulo: 'Excedente sobre el objetivo (USD)', clave: 'excedente', ancho: 24, formato: FORMATO.usd },
      { titulo: 'Nivel', clave: 'nivel', ancho: 10 },
      { titulo: '% Empresa del nivel', clave: 'pctEmpresa', ancho: 16, formato: FORMATO.pct },
      { titulo: '% Propio del nivel', clave: 'pctPropio', ancho: 16, formato: FORMATO.pct },
      { titulo: 'Comisión Tipo A (RA) (USD)', clave: 'comisionTipoARA', ancho: 22, formato: FORMATO.usd },
    ];

    const hoja = this.hojaConCabecera(libro, 'Tipo A (RA)', columnas);

    this.nota(
      hoja,
      'combinado',
      'Ingreso planes de maternidad + ingreso RA. En el Excel de administración es la columna ' +
        '"SUMA MONTO COMISIONABLE" de la hoja BDEjecutivas.',
    );
    this.nota(
      hoja,
      'objetivo',
      'El mismo objetivo mensual en $ que usa el bono de jefatura (columna "MONTOBJETIVO" del Excel de ' +
        'administración) — NO el objetivo de CANTIDAD de planes, que es un número aparte.',
    );
    this.nota(
      hoja,
      'excedente',
      'Combinado − objetivo mensual. Negativo = todavía no llega ("NA" en el Excel de administración): ' +
        'el nivel queda vacío y la comisión en $0, aunque haya ventas RA.',
    );
    this.nota(
      hoja,
      'nivel',
      'Sale de ubicar el excedente en la escala de niveles (misma escala que usa Tipo B, tabla aparte). ' +
        'Columna "Asignación NIVEL (A)" en el Excel de administración.',
    );
    this.nota(
      hoja,
      'comisionTipoARA',
      'El % del nivel se aplica SOLO sobre el ingreso RA, no sobre el combinado: los planes ya cobran su ' +
        'propia comisión aparte (columna "Tipo A ($)" de la hoja Liquidación). Columna "COMISIÓN TIPO A (RA)" ' +
        'en el Excel de administración.',
    );

    let totalMaternidad = 0;
    let totalRA = 0;
    let totalComision = 0;
    let algunoConNivel = false;

    /* Marketing fuera: no tiene ingreso de maternidad ni de RA, así que su fila
       sería once columnas en cero explicando un cubo que no le aplica. */
    for (const f of consolidado.filas.filter(v => !esMarketing(v))) {
      const combinado = f.ingresoMaternidadTipoARA + f.ingresoRATipoARA;
      const objetivo = redondear(combinado - f.excedenteTipoARA);
      const escala = f.nivelTipoARA !== null ? nivelesPorNumero.get(f.nivelTipoARA) : undefined;
      if (f.nivelTipoARA !== null) algunoConNivel = true;

      hoja.addRow({
        nombre: f.nombre,
        codigo: f.codigo,
        ingresoMaternidad: f.ingresoMaternidadTipoARA,
        ingresoRA: f.ingresoRATipoARA,
        combinado: redondear(combinado),
        objetivo,
        excedente: f.excedenteTipoARA,
        nivel: f.nivelTipoARA ? `NIVEL ${f.nivelTipoARA}` : 'NA',
        /*
         * `pctEmpresa`/`pctPropio` de `NivelTipoARA` YA vienen en puntos
         * porcentuales (4.5 = 4,5%), no como fracción — así los siembra
         * `configuracion-por-defecto.ts` y así los consume el propio motor
         * de cálculo (`comisionUsd = base * porcentaje / 100`). Multiplicar
         * por 100 aquí (como si fueran fracción, igual que `pctMonto` de
         * `AnaliticaComisionesService`) los infla 100 veces: 4,5% salía
         * como "450.0%". Dos columnas con "%" en el nombre, dos convenciones
         * distintas — antes de tocar un formato de porcentaje, confirmar
         * SIEMPRE contra el sembrado o el motor, nunca asumir por el nombre.
         */
        pctEmpresa: escala ? Number(escala.pctEmpresa) : null,
        pctPropio: escala ? Number(escala.pctPropio) : null,
        comisionTipoARA: f.comisionTipoARA,
      });

      totalMaternidad += f.ingresoMaternidadTipoARA;
      totalRA += f.ingresoRATipoARA;
      totalComision += f.comisionTipoARA;
    }

    const totales = hoja.addRow({
      nombre: 'TOTALES',
      ingresoMaternidad: redondear(totalMaternidad),
      ingresoRA: redondear(totalRA),
      combinado: redondear(totalMaternidad + totalRA),
      comisionTipoARA: redondear(totalComision),
    });
    this.marcarTotales(totales, columnas.length);

    if (!algunoConNivel) {
      const aviso = hoja.addRow([
        'Ninguna vendedora superó su objetivo mensual combinado este periodo: el cubo Tipo A (RA) pagó $0 en total.',
      ]);
      aviso.font = { italic: true, size: 10, color: { argb: 'FF64748B' } };
      hoja.mergeCells(aviso.number, 1, aviso.number, columnas.length);
    }
  }

  /* ── Hoja 4: todos los planes, por vendedora, con el motivo de cada uno ── */

  /**
   * Cada plan de maternidad o varios vendido en el mes, agrupado por
   * vendedora, con **por qué** comisiona o no — no solo el número final de
   * "6 comisionan".
   *
   * Reutiliza `seleccionarPlanesComisionables` (la misma función pura que usa
   * el motor de cálculo) en vez de reproducir el criterio a mano: así esta
   * hoja no puede divergir del que decide qué se paga. El objetivo se lee de
   * `configuracionUsada`, la foto CONGELADA del periodo — no de la
   * configuración actual, que puede haber cambiado desde que se calculó.
   */
  private async hojaPlanesPorVendedora(libro: Workbook, consolidado: ConsolidadoPeriodo): Promise<void> {
    const foto = consolidado.periodo.configuracionUsada as unknown as FotoConfiguracion | null;
    const objetivoPorTipo = new Map((foto?.objetivos ?? []).map(o => [o.tipo, o]));
    const vendedorasLiquidadas = new Set(consolidado.filas.map(f => f.vendedoraId));

    const columnas: ColumnaInforme[] = [
      { titulo: 'Vendedora', clave: 'vendedora', ancho: 30 },
      { titulo: 'Tipo de plan', clave: 'tipoPlan', ancho: 12 },
      { titulo: 'Nivel', clave: 'nivel', ancho: 9 },
      { titulo: 'Fecha', clave: 'fecha', ancho: 12 },
      { titulo: 'Cod. Origen', clave: 'codOrigen', ancho: 12 },
      { titulo: 'Paciente', clave: 'paciente', ancho: 28 },
      { titulo: 'Plan', clave: 'detalle', ancho: 42 },
      { titulo: 'Canal', clave: 'canal', ancho: 10 },
      { titulo: 'Precio (USD)', clave: 'precio', ancho: 14, formato: FORMATO.usd },
      { titulo: 'Base de cálculo (USD)', clave: 'ingresoNeto', ancho: 20, formato: FORMATO.usd },
      { titulo: 'Anticipo pagado (USD)', clave: 'anticipoPlan', ancho: 20, formato: FORMATO.usd },
      { titulo: 'Estado del plan', clave: 'estadoPlan', ancho: 14 },
      { titulo: 'Comisiona', clave: 'comisiona', ancho: 11 },
      { titulo: 'Motivo', clave: 'motivo', ancho: 46 },
    ];

    const hoja = this.hojaConCabecera(libro, 'Planes por Vendedora', columnas);
    this.nota(
      hoja,
      'comisiona',
      'Solo comisionan los planes que SUPERAN el objetivo del mes (igualarlo paga $0). Cuáles concretos: ' +
        'los ÚLTIMOS vendidos por correlativo de registro, salvo que administración haya marcado uno a mano.',
    );
    this.nota(
      hoja,
      'ingresoNeto',
      'Precio × 0,87, SIEMPRE — el anticipo no la cambia. El plan comisiona por su base completa, cobre lo ' +
        'que cobre la paciente ese mes.',
    );

    const planes = await this.prisma.ventaImportada.findMany({
      where: {
        periodoId: consolidado.periodo.id,
        comisionable: true,
        clasif: { in: [ClasifComision.PLANPAQ, ClasifComision.PLANNIN] },
        vendedoraId: { in: [...vendedorasLiquidadas] },
      },
      include: { vendedora: true },
    });

    if (planes.length === 0) {
      const aviso = hoja.addRow(['No hay planes de maternidad ni varios comisionables en este periodo.']);
      aviso.font = { italic: true, size: 10, color: { argb: 'FF64748B' } };
      hoja.mergeCells(aviso.number, 1, aviso.number, columnas.length);
      return;
    }

    // Agrupa por vendedora + tipo de plan: mismo agrupamiento que usa el
    // motor para decidir el cupo (los dos objetivos —PLANPAQ y PLANNIN— son
    // independientes, así que no se pueden mezclar en una sola selección).
    const grupos = new Map<string, typeof planes>();
    for (const p of planes) {
      if (!p.vendedoraId) continue;
      const clave = `${p.vendedoraId}|${p.clasif}`;
      const lista = grupos.get(clave);
      if (lista) lista.push(p);
      else grupos.set(clave, [p]);
    }

    const clavesOrdenadas = [...grupos.keys()].sort((a, b) => {
      const grupoA = grupos.get(a)![0];
      const grupoB = grupos.get(b)![0];
      const nombreA = grupoA.vendedora?.nombre ?? '';
      const nombreB = grupoB.vendedora?.nombre ?? '';
      return nombreA.localeCompare(nombreB) || grupoA.clasif.localeCompare(grupoB.clasif);
    });

    let totalPrecio = 0;
    let totalBase = 0;
    let totalComisionan = 0;

    for (const clave of clavesOrdenadas) {
      const filasGrupo = grupos.get(clave)!;
      const primera = filasGrupo[0];
      const vendedora = primera.vendedora!;
      const esMaternidad = primera.clasif === ClasifComision.PLANPAQ;
      const objetivo = objetivoPorTipo.get(vendedora.tipo);
      const minimo = esMaternidad ? (objetivo?.planpaqMinimos ?? 0) : (objetivo?.planninMinimos ?? 0);

      const candidatos: PlanCandidato[] = filasGrupo.map(p => ({
        id: p.id,
        codOrigen: p.codOrigen,
        fecha: p.fecha,
        comisionaPlan: p.comisionaPlan,
      }));
      const seleccion = seleccionarPlanesComisionables(candidatos, minimo);
      totalComisionan += seleccion.elegidos.size;

      this.seccion(
        hoja,
        `${vendedora.nombre} — ${esMaternidad ? 'Maternidad' : 'Varios'}: ` +
          `${filasGrupo.length} vendido(s) · objetivo ${minimo} · comisionan ${seleccion.cupo}`,
        columnas.length,
      );

      const ordenados = [...filasGrupo].sort(ultimoPrimero);
      for (const p of ordenados) {
        const elegido = seleccion.elegidos.has(p.id);
        const descartado = seleccion.descartadosPorCupo.includes(p.id);

        let motivo: string;
        if (elegido && p.comisionaPlan === true) motivo = 'Elegido a mano por administración';
        else if (elegido) motivo = 'Elegido: entre los últimos vendidos (correlativo de registro)';
        else if (descartado) motivo = 'Marcado a mano, pero el cupo ya estaba lleno';
        else if (p.comisionaPlan === false) motivo = 'Descartado a mano por administración';
        else motivo = 'No alcanza el cupo (no está entre los últimos vendidos)';

        const precio = Number(p.precio);
        const ingresoNeto = Number(p.ingresoNeto);
        totalPrecio += precio;
        totalBase += ingresoNeto;

        const fila = hoja.addRow({
          vendedora: vendedora.nombre,
          tipoPlan: esMaternidad ? 'Maternidad' : 'Varios',
          nivel: p.nivel ?? '—',
          fecha: p.fecha ? p.fecha.toISOString().slice(0, 10) : '—',
          codOrigen: p.codOrigen ?? '—',
          paciente: p.paciente ?? '—',
          detalle: p.detalle,
          canal: p.canal,
          precio,
          ingresoNeto,
          anticipoPlan: p.anticipoPlan ? Number(p.anticipoPlan) : null,
          estadoPlan: p.estadoPlan ?? '—',
          comisiona: elegido ? 'Sí' : 'No',
          motivo,
        });

        if (!elegido) {
          fila.eachCell(celda => (celda.font = { color: { argb: 'FF94A3B8' } }));
        }
      }
    }

    hoja.addRow([]);
    const totales = hoja.addRow({
      vendedora: 'TOTALES',
      precio: redondear(totalPrecio),
      ingresoNeto: redondear(totalBase),
      comisiona: `${totalComisionan} de ${planes.length}`,
    });
    this.marcarTotales(totales, columnas.length);
  }

  /* ── Una hoja por vendedora: TODAS las columnas, sin resumir ─────────── */

  /**
   * La tabla web (`tabla-liquidacion.component.ts`) resume cada vendedora en
   * una fila de 14 columnas — es lo que cabe en pantalla —, pero el cálculo
   * real guarda más de 20 números por persona: los tres ingredientes de Tipo
   * A (RA) por separado, los dos objetivos de planes (paquetes/varios) sin
   * sumar, los tres bonos sueltos, el % efectivo de comisión… Ninguna vista
   * los muestra todos a la vez. Aquí sí, uno por hoja: el resumen completo de
   * esa persona, el desglose por tipo/canal/unidad de negocio (el mismo
   * agrupamiento — `clasif|canal|unidadNegocio|nivel` — que usa el motor
   * para decidir cuánto paga cada grupo, `calculo-comisiones.service.ts:agrupar`)
   * y cada venta del mes que le corresponde. Con esto se audita el pago de
   * una vendedora sin cruzar cinco pantallas ni sumar filas a mano.
   *
   * Reutiliza `consolidado.filas` (siete columnas fijas ya la trajeron) y
   * pide aparte el `desglose` guardado en `ResultadoComision` — es JSON
   * congelado con el que se pagó, no algo que se recalcule aquí.
   */
  private async hojasPorVendedora(libro: Workbook, consolidado: ConsolidadoPeriodo): Promise<void> {
    const resultados = await this.prisma.resultadoComision.findMany({
      where: { periodoId: consolidado.periodo.id },
      select: { vendedoraId: true, desglose: true },
    });
    const desglosePorVendedora = new Map(
      resultados.map(r => [r.vendedoraId, (r.desglose ?? []) as unknown as LineaDesglose[]]),
    );

    const nombresUsados = new Set<string>();

    /* Sin hoja propia para marketing: no tiene ventas, ni desglose, ni planes —
       la pestaña saldría vacía salvo el bono, que ya está en su bloque de la
       hoja "Liquidación". Dos pestañas en blanco entre las de las ejecutivas
       hacen más difícil encontrar la que sí tiene datos. */
    for (const f of consolidado.filas.filter(v => !esMarketing(v))) {
      const hoja = libro.addWorksheet(this.nombreHojaUnico(f.nombre, nombresUsados), {
        views: [{ showGridLines: false }],
      });
      hoja.getColumn(1).width = 34;
      for (let c = 2; c <= 14; c++) hoja.getColumn(c).width = 18;

      this.escribirResumenVendedora(hoja, f);
      hoja.addRow([]);
      hoja.addRow([]);
      this.escribirDesgloseVendedora(hoja, f, desglosePorVendedora.get(f.vendedoraId) ?? []);
      hoja.addRow([]);
      hoja.addRow([]);
      await this.escribirVentasVendedora(hoja, consolidado.periodo.id, f);
    }
  }

  /**
   * Nombre de hoja válido para Excel (máx. 31 caracteres, sin `: \ / ? * [ ]`)
   * y único dentro del libro — dos vendedoras con nombre largo pueden truncar
   * al mismo texto, y Excel rechaza el archivo entero si dos hojas coinciden.
   */
  private nombreHojaUnico(nombre: string, usados: Set<string>): string {
    const base = nombre.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Vendedora';
    let candidato = base;
    let sufijo = 2;
    while (usados.has(candidato.toLowerCase())) {
      const marca = ` (${sufijo})`;
      candidato = base.slice(0, 31 - marca.length) + marca;
      sufijo++;
    }
    usados.add(candidato.toLowerCase());
    return candidato;
  }

  private escribirResumenVendedora(hoja: Worksheet, f: FilaConsolidado): void {
    this.titulo(hoja, `Liquidación completa — ${f.nombre} (${f.codigo})`, 14);
    hoja.addRow([]);

    this.seccion(hoja, 'Datos de la vendedora', 14);
    this.dato(hoja, 'Tipo', f.tipo);
    this.dato(hoja, 'Área', f.area);

    hoja.addRow([]);
    this.seccion(hoja, 'Facturación (USD)', 14);
    this.dato(hoja, 'Facturado', f.montoVendido, FORMATO.usd);
    this.dato(hoja, 'Base de cálculo (facturado × 0,87)', f.baseCalculo, FORMATO.usd);

    hoja.addRow([]);
    this.seccion(hoja, 'Planes de maternidad y varios — el objetivo es una franquicia', 14);
    this.dato(hoja, 'Paquetes de maternidad vendidos', f.planpaqVendidos, FORMATO.entero);
    this.dato(hoja, 'Paquetes de maternidad que comisionan', f.planpaqComisionables, FORMATO.entero);
    this.dato(hoja, 'Planes varios vendidos', f.planninVendidos, FORMATO.entero);
    this.dato(hoja, 'Planes varios que comisionan', f.planninComisionables, FORMATO.entero);
    this.dato(hoja, 'Total planes vendidos', f.planesVendidos, FORMATO.entero);
    this.dato(hoja, 'Cumple objetivo de planes', f.cumpleObjetivoPlanes ? 'Sí' : 'No');

    hoja.addRow([]);
    this.seccion(hoja, 'Cirugías e internaciones — Tipo B', 14);
    this.dato(hoja, 'Acumulado de cirugías del mes', f.acumuladoCirugias, FORMATO.usd);
    this.dato(hoja, 'Nivel de cirugía', f.nivelCirugia ? `NIVEL ${f.nivelCirugia}` : 'NA');

    hoja.addRow([]);
    this.seccion(hoja, 'Tipo A (RA) — consulta/laboratorio/ecografía/otros del área RA', 14);
    this.dato(hoja, 'Ingreso planes de maternidad', f.ingresoMaternidadTipoARA, FORMATO.usd);
    this.dato(hoja, 'Ingreso RA (sin cirugía)', f.ingresoRATipoARA, FORMATO.usd);
    this.dato(
      hoja,
      'Ingreso combinado',
      redondear(f.ingresoMaternidadTipoARA + f.ingresoRATipoARA),
      FORMATO.usd,
    );
    this.dato(hoja, 'Excedente sobre el objetivo mensual', f.excedenteTipoARA, FORMATO.usd);
    this.dato(hoja, 'Nivel Tipo A (RA)', f.nivelTipoARA ? `NIVEL ${f.nivelTipoARA}` : 'NA');

    hoja.addRow([]);
    this.seccion(hoja, 'Comisiones por cubo (USD)', 14);
    this.dato(hoja, 'Tipo A · Planes de maternidad y varios', f.comisionA, FORMATO.usd);
    this.dato(hoja, 'Tipo A (RA) · Consultas y análisis del área RA', f.comisionTipoARA, FORMATO.usd);
    this.dato(hoja, 'Tipo B · Cirugías e internaciones', f.comisionB, FORMATO.usd);
    this.dato(hoja, 'Tipo C · Consultas, laboratorios y otros', f.comisionC, FORMATO.usd);

    hoja.addRow([]);
    this.seccion(hoja, 'Bonos (USD)', 14);
    this.dato(hoja, 'Bono de jefatura', f.bonoJefatura, FORMATO.usd);
    this.dato(hoja, 'Bono de publicidad', f.bonoPublicidad, FORMATO.usd);
    this.dato(hoja, 'Bono trimestral', f.bonoTrimestral, FORMATO.usd);
    this.dato(hoja, 'Total de bonos', f.totalBonos, FORMATO.usd);

    hoja.addRow([]);
    const totalUsd = this.dato(hoja, 'TOTAL COMISIÓN (USD)', f.totalUsd, FORMATO.usd);
    const totalBob = this.dato(hoja, 'TOTAL COMISIÓN (Bs)', f.totalBob, FORMATO.bob);
    const sueldo = this.dato(hoja, 'Sueldo base (Bs)', f.sueldoBase, FORMATO.bob);
    const aPagar = this.dato(hoja, 'A PAGAR (Bs)', f.totalGanado, FORMATO.bob);
    this.dato(hoja, '% efectivo de comisión sobre lo vendido', f.pctComision, FORMATO.pct);

    for (const fila of [totalUsd, totalBob, sueldo, aPagar]) fila.font = { bold: true };
    aPagar.font = { bold: true, size: 12 };
    for (const col of [1, 2]) {
      aPagar.getCell(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.totales } };
    }
  }

  private escribirDesgloseVendedora(hoja: Worksheet, f: FilaConsolidado, desglose: LineaDesglose[]): void {
    this.seccion(hoja, 'Desglose por tipo y sección — de dónde sale cada comisión', 14);

    if (desglose.length === 0) {
      const aviso = hoja.addRow(['Sin ventas comisionables agrupadas este periodo.']);
      aviso.font = { italic: true, size: 10, color: { argb: 'FF64748B' } };
      return;
    }

    const filaTabla = hoja.rowCount + 1;
    const columnas: TableColumnProperties[] = [
      { name: 'Categoría', filterButton: true },
      { name: 'Canal', filterButton: true },
      { name: 'Unidad de negocio', filterButton: true },
      { name: 'Tipo', filterButton: true },
      { name: 'Cantidad', filterButton: true },
      { name: 'Facturado (USD)', filterButton: true },
      { name: 'Base de cálculo (USD)', filterButton: true },
      { name: '% aplicado', filterButton: true },
      { name: 'Comisión (USD)', filterButton: true },
    ];
    const filas = desglose.map(d => [
      ETIQUETA_CLASIF[d.clasif] ?? d.clasif,
      ETIQUETA_CANAL[d.canal] ?? d.canal,
      ETIQUETA_UNIDAD[d.unidadNegocio] ?? d.unidadNegocio,
      this.etiquetaTipo(d),
      d.cantidad,
      d.montoVendido,
      d.baseCalculo,
      d.porcentaje,
      d.comisionUsd,
    ]);

    hoja.addTable({
      name: `Desglose_${this.claveTabla(f.codigo)}`,
      ref: `A${filaTabla}`,
      headerRow: true,
      style: { theme: 'TableStyleMedium9', showRowStripes: true },
      columns: columnas,
      rows: filas,
    });

    const inicio = filaTabla + 1;
    const fin = filaTabla + filas.length;
    this.formatoRangoColumna(hoja, inicio, fin, 6, FORMATO.usd);
    this.formatoRangoColumna(hoja, inicio, fin, 7, FORMATO.usd);
    this.formatoRangoColumna(hoja, inicio, fin, 8, FORMATO.pct);
    this.formatoRangoColumna(hoja, inicio, fin, 9, FORMATO.usd);
  }

  private async escribirVentasVendedora(hoja: Worksheet, periodoId: string, f: FilaConsolidado): Promise<void> {
    this.seccion(hoja, 'Ventas del mes que le corresponden a esta vendedora', 14);

    const ventas = await this.prisma.ventaImportada.findMany({
      where: { periodoId, vendedoraId: f.vendedoraId },
      orderBy: [{ fecha: 'asc' }, { detalle: 'asc' }],
      select: {
        fecha: true, modulo: true, detalle: true, paciente: true, medico: true,
        captacion: true, canal: true, clasif: true, tipo: true, nivel: true,
        precio: true, ingresoNeto: true, comisionable: true, motivoExclusion: true,
        codOrigen: true,
      },
    });

    if (ventas.length === 0) {
      const aviso = hoja.addRow(['Sin ventas asociadas a esta vendedora en el periodo.']);
      aviso.font = { italic: true, size: 10, color: { argb: 'FF64748B' } };
      return;
    }

    const filaTabla = hoja.rowCount + 1;
    const columnas: TableColumnProperties[] = [
      { name: 'Fecha', filterButton: true },
      { name: 'Cod. Origen', filterButton: true },
      { name: 'Módulo', filterButton: true },
      { name: 'Servicio', filterButton: true },
      { name: 'Paciente', filterButton: true },
      { name: 'Médico', filterButton: true },
      { name: 'Captación', filterButton: true },
      { name: 'Canal', filterButton: true },
      { name: 'Categoría', filterButton: true },
      { name: 'Tipo', filterButton: true },
      { name: 'Nivel', filterButton: true },
      { name: 'Precio (USD)', filterButton: true },
      { name: 'Base (USD)', filterButton: true },
      { name: 'Comisiona', filterButton: true },
      { name: 'Motivo de exclusión', filterButton: true },
    ];
    const filas = ventas.map(v => [
      v.fecha ? v.fecha.toISOString().slice(0, 10) : '—',
      v.codOrigen ?? '—',
      v.modulo ?? '—',
      v.detalle,
      v.paciente ?? '—',
      v.medico ?? '—',
      v.captacion ?? '—',
      ETIQUETA_CANAL[v.canal] ?? v.canal,
      ETIQUETA_CLASIF[v.clasif] ?? v.clasif,
      v.tipo,
      v.nivel ?? '—',
      Number(v.precio),
      Number(v.ingresoNeto),
      v.comisionable ? 'Sí' : 'No',
      v.motivoExclusion ?? '—',
    ]);

    hoja.addTable({
      name: `Ventas_${this.claveTabla(f.codigo)}`,
      ref: `A${filaTabla}`,
      headerRow: true,
      style: { theme: 'TableStyleMedium9', showRowStripes: true },
      columns: columnas,
      rows: filas,
    });

    const inicio = filaTabla + 1;
    const fin = filaTabla + filas.length;
    // Precio y Base se corrieron una columna por la nueva "Cod. Origen" en la posición 2.
    this.formatoRangoColumna(hoja, inicio, fin, 12, FORMATO.usd);
    this.formatoRangoColumna(hoja, inicio, fin, 13, FORMATO.usd);
  }

  /**
   * `LineaDesglose.tipo` sale de la misma letra 'A' tanto para un plan de
   * maternidad/varios como para una consulta/lab/eco/otros del área RA — son
   * dos bolsas con reglas de tarifa distintas (por plan elegido vs. por
   * nivel mensual combinado) que comparten letra porque así las marca
   * `PARAMETROS` en la planilla de administración (columna `TIPO COMISION`).
   * Mostrar "A" a secas en esta hoja invita a sumar peras con manzanas —
   * aquí se separan por `unidadNegocio`, la única pista que las distingue.
   */
  private etiquetaTipo(d: LineaDesglose): string {
    if (d.tipo === 'A' && d.unidadNegocio === UnidadNegocio.RA) return 'Tipo A (RA)';
    if (d.tipo === 'A') return 'Tipo A · Planes';
    if (d.tipo === 'B') return 'Tipo B · Cirugías';
    return 'Tipo C · Servicios';
  }

  /** Nombre de tabla Excel válido (letras/números/guión bajo) y único en el
   *  libro — el código de la vendedora ya es su clave de negocio, así que
   *  sirve de sufijo sin arriesgar colisión entre `Desglose_*`/`Ventas_*`. */
  private claveTabla(codigo: string): string {
    return codigo.replace(/[^A-Za-z0-9_]/g, '_');
  }

  /**
   * Aplica un formato numérico a un rango puntual de celdas, nunca a la
   * columna entera: en esta hoja la misma columna sirve al bloque de resumen,
   * al desglose y a las ventas, cada uno con su propio tipo de dato — un
   * `getColumn().numFmt` se filtraría hacia arriba o hacia abajo del bloque
   * que lo necesita. Es el mismo bug de fondo que ya rompió el % de Tipo A
   * (RA) en la hoja "Tipo A (RA)" (ver la cabecera de este archivo).
   */
  private formatoRangoColumna(
    hoja: Worksheet,
    filaDesde: number,
    filaHasta: number,
    columna: number,
    formato: string,
  ): void {
    for (let r = filaDesde; r <= filaHasta; r++) {
      const celda = hoja.getCell(r, columna);
      celda.numFmt = formato;
      celda.alignment = { horizontal: 'right' };
    }
  }

  /* ── Hoja 5: de dónde sale la facturación ───────────────────────────── */

  private hojaDistribucion(libro: Workbook, informe: InformeAnalitica): void {
    const columnas: ColumnaInforme[] = [
      { titulo: 'Agrupación', clave: 'grupo', ancho: 22 },
      { titulo: 'Concepto', clave: 'etiqueta', ancho: 36 },
      { titulo: 'Ventas', clave: 'cantidad', ancho: 10, formato: FORMATO.entero },
      { titulo: 'Facturado (USD)', clave: 'montoVendido', ancho: 17, formato: FORMATO.usd },
      { titulo: 'Base de cálculo (USD)', clave: 'baseCalculo', ancho: 19, formato: FORMATO.usd },
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

  /* ── Hoja 6: rankings y evolución ────────────────────────────────────── */

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

  /* ── Hoja 7: detalle línea a línea (respaldo de auditoría) ──────────── */

  private async hojaDetalle(libro: Workbook, periodoId: string): Promise<void> {
    const columnas: ColumnaInforme[] = [
      { titulo: 'Fecha', clave: 'fecha', ancho: 12 },
      { titulo: 'Cod. Origen', clave: 'codOrigen', ancho: 12 },
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
      { titulo: 'Precio (USD)', clave: 'precio', ancho: 14, formato: FORMATO.usd },
      { titulo: 'Base (USD)', clave: 'ingresoNeto', ancho: 14, formato: FORMATO.usd },
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
          motivoExclusion: true, codOrigen: true,
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
          codOrigen: f.codOrigen ?? '—',
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
    cabecera.alignment = { vertical: 'middle', horizontal: 'left', wrapText: false };
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

  /**
   * Nota de celda (▲ roja, aparece al pasar el mouse) sobre la cabecera de
   * una columna — para explicar una fórmula sin gastar una fila entera ni
   * romper el autofiltro de la fila 1, que solo funciona sobre una sola fila
   * de cabecera.
   */
  private nota(hoja: Worksheet, clave: string, texto: string): void {
    const columna = hoja.getColumn(clave);
    hoja.getRow(1).getCell(columna.number).note = texto;
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
type FilaConsolidado = ConsolidadoPeriodo['filas'][number];

/**
 * Quién va en el bloque aparte de la planilla.
 *
 * Se decide por ÁREA y no por "tiene ventas en cero": una ejecutiva puede tener
 * un mes malo y sigue perteneciendo a la tabla de ventas, con sus ceros, porque
 * esos ceros son información. Marketing no comisiona por definición.
 */
function esMarketing(fila: FilaConsolidado): boolean {
  return fila.area === AreaVendedora.PUBLICIDAD;
}
