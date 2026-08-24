import { Injectable, NotFoundException } from '@nestjs/common';
import { ClasifComision } from '@prisma/client';
import { Workbook, Worksheet } from 'exceljs';
import { Writable } from 'stream';

import { PrismaService } from '../../prisma/prisma.service';
import { AnaliticaComisionesService } from './analitica-comisiones.service';
import { CalculoComisionesService, FotoConfiguracion } from './calculo-comisiones.service';
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
   * Siete hojas, en el orden en que se leen: el resumen para la firma, la
   * planilla para pagar, el desglose de los dos cubos que tienen más de un
   * paso (Tipo A (RA) y los planes elegidos), y el resto como respaldo de
   * cómo se llegó a esas cifras.
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
      this.hojaTipoARA(libro, consolidado);
      await this.hojaPlanesPorVendedora(libro, consolidado);
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

    for (const f of consolidado.filas) {
      hoja.addRow({
        ...f,
        cumpleObjetivo: f.cumpleObjetivoPlanes ? 'Sí' : 'No',
        nivelCirugia: f.nivelCirugia ?? '—',
        nivelTipoARA: f.nivelTipoARA ? `NIVEL ${f.nivelTipoARA}` : 'NA',
        bonos: f.totalBonos,
      });
    }

    const t = consolidado.totales;
    const totales = hoja.addRow({
      nombre: 'TOTALES',
      montoVendido: t['montoVendido'],
      baseCalculo: t['baseCalculo'],
      comisionA: t['comisionA'],
      comisionTipoARA: t['comisionTipoARA'],
      comisionB: t['comisionB'],
      comisionC: t['comisionC'],
      bonos: t['bonos'],
      totalUsd: t['totalUsd'],
      totalBob: t['totalBob'],
      totalGanado: t['totalGanado'],
    });
    this.marcarTotales(totales, columnas.length);
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

    for (const f of consolidado.filas) {
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
