import { Injectable, NotFoundException } from '@nestjs/common';
import { ClasifComision, Prisma, UnidadNegocio } from '../../prisma/prisma-client';
import { TableColumnProperties, Workbook, Worksheet } from 'exceljs';
import { Writable } from 'stream';

import { PrismaService } from '../../prisma/prisma.service';
import {
  AnaliticaComisionesService,
  ETIQUETA_CANAL,
  ETIQUETA_CLASIF,
  ETIQUETA_UNIDAD,
} from './analitica-comisiones.service';
import { FotoConfiguracion, LineaDesglose } from './calculo-comisiones.service';
import { ReportesComisionesService } from './reportes-comisiones.service';
import { redondear } from './clasificador';
import { esDeMarketing } from './informe-liquidacion';
import {
  COLOR,
  ColumnaInforme,
  dato,
  FORMATO,
  formatoRangoColumna,
  hojaConCabecera,
  marcarTotales,
  nota,
  seccion,
  titulo,
} from './excel/estilo';
import {
  ConsolidadoPeriodo,
  FilaConsolidado,
  hojaDistribucion,
  hojaLiquidacion,
  hojaRankings,
  hojaResumen,
  hojaTipoARA,
} from './excel/hojas-del-consolidado';
import { PlanCandidato, seleccionarPlanesComisionables, ultimoPrimero } from './reglas-calculo';

/**
 * Exportación del informe mensual a Excel (requisito §12.7 del documento de
 * negocio: los reportes deben ser descargables).
 *
 * ## El libro NO va en streaming, y conviene saberlo
 *
 * Este archivo decía que sí —«un mes de 500 filas y uno de 50.000 cuestan lo
 * mismo en RAM»— y es exactamente al revés. `new Workbook()` construye el libro
 * ENTERO en memoria y `libro.xlsx.write(salida)` solo vuelca al stream lo que ya
 * está construido; el streaming de verdad en ExcelJS es
 * `stream.xlsx.WorkbookWriter`, que no se usa aquí. El `LOTE_DETALLE` de abajo
 * acota lo que se lee de PostgreSQL de una vez, no lo que ocupa el libro.
 *
 * Medido en esta misma máquina (Node 22, 21 hojas como las que genera el
 * export real, `heapUsed` antes/después y RSS al terminar):
 *
 * | filas de detalle | tiempo | heap tras construir | RSS al terminar |
 * |---|---|---|---|
 * | 500 (un mes real) | 0,27 s | +5 MB | 116 MB |
 * | 2.000 | 0,64 s | +19 MB | 164 MB |
 * | 10.000 | 2,7 s | +90 MB | **440 MB** |
 * | 50.000 | 13,4 s | +452 MB | **1,96 GB** |
 *
 * `crm_backend.service` corre con `MemoryMax=400M` sobre un VPS de 1,7 GB: a
 * 10.000 filas el proceso ya no cabe y systemd lo mata **durante la descarga**,
 * llevándose por delante a quien estuviera usando el CRM en ese momento. No es
 * un problema hoy —un mes ronda las 450-500 filas y suma ~450 al mes— pero el
 * margen es de años, no infinito. **El día que una exportación tarde varios
 * segundos, el arreglo es `WorkbookWriter`, no subir el `MemoryMax`.**
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
 *
 * ## Dónde está cada hoja
 *
 * Este servicio arma el libro y decide el orden de las hojas en `exportar()`.
 * Las que salen enteras del consolidado y la analítica —Resumen, Liquidación,
 * Tipo A (RA), Distribución y Rankings— están en `excel/hojas-del-consolidado.ts`;
 * el estilo común (colores, formatos, título, secciones, totales) en
 * `excel/estilo.ts`. Aquí quedan las que leen ventas del mes: Planes por
 * Vendedora, una hoja por persona y Detalle.
 */

/** Cuántas filas de detalle se leen por vuelta al volcar la hoja de auditoría. */
const LOTE_DETALLE = 1000;


@Injectable()
export class ExportacionComisionesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analitica: AnaliticaComisionesService,
    private readonly reportes: ReportesComisionesService,
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
      this.reportes.reporteConsolidado(periodoId, incluirOcultas).catch(() => null),
    ]);

    const libro = new Workbook();
    libro.creator = 'CRM — Clínica Montalvo';
    libro.created = new Date();

    hojaResumen(libro, informe, consolidado);
    if (consolidado) {
      hojaLiquidacion(libro, consolidado);
      hojaTipoARA(libro, consolidado);
      await this.hojaPlanesPorVendedora(libro, consolidado);
      await this.hojasPorVendedora(libro, consolidado);
    }
    hojaDistribucion(libro, informe);
    hojaRankings(libro, informe);
    await this.hojaDetalle(libro, periodoId);

    await libro.xlsx.write(salida);
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

    const hoja = hojaConCabecera(libro, 'Planes por Vendedora', columnas);
    nota(
      hoja,
      'comisiona',
      'Solo comisionan los planes que SUPERAN el objetivo del mes (igualarlo paga $0). Cuáles concretos: ' +
        'los ÚLTIMOS vendidos por correlativo de registro, salvo que administración haya marcado uno a mano.',
    );
    nota(
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

      seccion(
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
    marcarTotales(totales, columnas.length);
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
    const conHoja = consolidado.filas.filter(v => !esDeMarketing(v));

    /*
     * Las ventas del mes se piden UNA vez y se agrupan en memoria.
     *
     * Antes cada hoja hacía su propio `findMany` por `vendedoraId`: catorce
     * vendedoras eran catorce consultas en serie dentro de la descarga, cada
     * una con su ida y vuelta, para leer trozos de la misma tabla que la hoja
     * "Detalle" ya recorre entera. Un mes real ronda las 500 filas y ya están
     * acotadas por `periodoId`, así que traerlas juntas cuesta una consulta y
     * unos cientos de KB — la comparación no es contra "no leerlas", es contra
     * leerlas catorce veces.
     *
     * Se filtra por las vendedoras que de verdad van a tener hoja: si el libro
     * se pidió sin las ocultas, sus filas no se traen.
     */
    const [resultados, ventas] = await Promise.all([
      this.prisma.resultadoComision.findMany({
        where: { periodoId: consolidado.periodo.id },
        select: { vendedoraId: true, desglose: true },
      }),
      this.prisma.ventaImportada.findMany({
        where: {
          periodoId: consolidado.periodo.id,
          vendedoraId: { in: conHoja.map(f => f.vendedoraId) },
        },
        orderBy: [{ fecha: 'asc' }, { detalle: 'asc' }],
        select: {
          vendedoraId: true,
          fecha: true, modulo: true, detalle: true, paciente: true, medico: true,
          captacion: true, canal: true, clasif: true, tipo: true, nivel: true,
          precio: true, ingresoNeto: true, comisionable: true, motivoExclusion: true,
          codOrigen: true,
        },
      }),
    ]);
    const desglosePorVendedora = new Map(
      resultados.map(r => [r.vendedoraId, (r.desglose ?? []) as unknown as LineaDesglose[]]),
    );

    /* El `orderBy` de la consulta se conserva al agrupar: un `Map` mantiene el
       orden de inserción, así que cada lista sigue por fecha y detalle sin
       reordenar nada. */
    const ventasPorVendedora = new Map<string, VentaDeHoja[]>();
    for (const venta of ventas) {
      if (!venta.vendedoraId) continue;
      const suyas = ventasPorVendedora.get(venta.vendedoraId) ?? [];
      suyas.push(venta);
      ventasPorVendedora.set(venta.vendedoraId, suyas);
    }

    const nombresUsados = new Set<string>();

    /* Sin hoja propia para marketing: no tiene ventas, ni desglose, ni planes —
       la pestaña saldría vacía salvo el bono, que ya está en su bloque de la
       hoja "Liquidación". Dos pestañas en blanco entre las de las ejecutivas
       hacen más difícil encontrar la que sí tiene datos. */
    for (const f of conHoja) {
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
      this.escribirVentasVendedora(hoja, f, ventasPorVendedora.get(f.vendedoraId) ?? []);
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
    titulo(hoja, `Liquidación completa — ${f.nombre} (${f.codigo})`, 14);
    hoja.addRow([]);

    seccion(hoja, 'Datos de la vendedora', 14);
    dato(hoja, 'Tipo', f.tipo);
    dato(hoja, 'Área', f.area);

    hoja.addRow([]);
    seccion(hoja, 'Facturación (USD)', 14);
    dato(hoja, 'Facturado', f.montoVendido, FORMATO.usd);
    dato(hoja, 'Base de cálculo (facturado × 0,87)', f.baseCalculo, FORMATO.usd);

    hoja.addRow([]);
    seccion(hoja, 'Planes de maternidad y varios — el objetivo es una franquicia', 14);
    dato(hoja, 'Paquetes de maternidad vendidos', f.planpaqVendidos, FORMATO.entero);
    dato(hoja, 'Paquetes de maternidad que comisionan', f.planpaqComisionables, FORMATO.entero);
    dato(hoja, 'Planes varios vendidos', f.planninVendidos, FORMATO.entero);
    dato(hoja, 'Planes varios que comisionan', f.planninComisionables, FORMATO.entero);
    dato(hoja, 'Total planes vendidos', f.planesVendidos, FORMATO.entero);
    dato(hoja, 'Cumple objetivo de planes', f.cumpleObjetivoPlanes ? 'Sí' : 'No');

    hoja.addRow([]);
    seccion(hoja, 'Cirugías e internaciones — Tipo B', 14);
    dato(hoja, 'Acumulado de cirugías del mes', f.acumuladoCirugias, FORMATO.usd);
    dato(hoja, 'Nivel de cirugía', f.nivelCirugia ? `NIVEL ${f.nivelCirugia}` : 'NA');

    hoja.addRow([]);
    seccion(hoja, 'Tipo A (RA) — consulta/laboratorio/ecografía/otros del área RA', 14);
    dato(hoja, 'Ingreso planes de maternidad', f.ingresoMaternidadTipoARA, FORMATO.usd);
    dato(hoja, 'Ingreso RA (sin cirugía)', f.ingresoRATipoARA, FORMATO.usd);
    dato(
      hoja,
      'Ingreso combinado',
      redondear(f.ingresoMaternidadTipoARA + f.ingresoRATipoARA),
      FORMATO.usd,
    );
    dato(hoja, 'Excedente sobre el objetivo mensual', f.excedenteTipoARA, FORMATO.usd);
    dato(hoja, 'Nivel Tipo A (RA)', f.nivelTipoARA ? `NIVEL ${f.nivelTipoARA}` : 'NA');

    hoja.addRow([]);
    seccion(hoja, 'Comisiones por cubo (USD)', 14);
    dato(hoja, 'Tipo A · Planes de maternidad y varios', f.comisionA, FORMATO.usd);
    dato(hoja, 'Tipo A (RA) · Consultas y análisis del área RA', f.comisionTipoARA, FORMATO.usd);
    dato(hoja, 'Tipo B · Cirugías e internaciones', f.comisionB, FORMATO.usd);
    dato(hoja, 'Tipo C · Consultas, laboratorios y otros', f.comisionC, FORMATO.usd);

    hoja.addRow([]);
    seccion(hoja, 'Bonos (USD)', 14);
    dato(hoja, 'Bono de jefatura', f.bonoJefatura, FORMATO.usd);
    dato(hoja, 'Bono de publicidad', f.bonoPublicidad, FORMATO.usd);
    dato(hoja, 'Bono trimestral', f.bonoTrimestral, FORMATO.usd);
    dato(hoja, 'Total de bonos', f.totalBonos, FORMATO.usd);

    hoja.addRow([]);
    const totalUsd = dato(hoja, 'TOTAL COMISIÓN (USD)', f.totalUsd, FORMATO.usd);
    const totalBob = dato(hoja, 'TOTAL COMISIÓN (Bs)', f.totalBob, FORMATO.bob);
    const sueldo = dato(hoja, 'Sueldo base (Bs)', f.sueldoBase, FORMATO.bob);
    const aPagar = dato(hoja, 'A PAGAR (Bs)', f.totalGanado, FORMATO.bob);
    dato(hoja, '% efectivo de comisión sobre lo vendido', f.pctComision, FORMATO.pct);

    for (const fila of [totalUsd, totalBob, sueldo, aPagar]) fila.font = { bold: true };
    aPagar.font = { bold: true, size: 12 };
    for (const col of [1, 2]) {
      aPagar.getCell(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.totales } };
    }
  }

  private escribirDesgloseVendedora(hoja: Worksheet, f: FilaConsolidado, desglose: LineaDesglose[]): void {
    seccion(hoja, 'Desglose por tipo y sección — de dónde sale cada comisión', 14);

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
    formatoRangoColumna(hoja, inicio, fin, 6, FORMATO.usd);
    formatoRangoColumna(hoja, inicio, fin, 7, FORMATO.usd);
    formatoRangoColumna(hoja, inicio, fin, 8, FORMATO.pct);
    formatoRangoColumna(hoja, inicio, fin, 9, FORMATO.usd);
  }

  private escribirVentasVendedora(
    hoja: Worksheet,
    f: FilaConsolidado,
    ventas: readonly VentaDeHoja[],
  ): void {
    seccion(hoja, 'Ventas del mes que le corresponden a esta vendedora', 14);

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
    formatoRangoColumna(hoja, inicio, fin, 12, FORMATO.usd);
    formatoRangoColumna(hoja, inicio, fin, 13, FORMATO.usd);
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

    const hoja = hojaConCabecera(libro, 'Detalle', columnas);

    /* Se pagina la LECTURA, que es lo único que esto acota: el libro sigue
       creciendo fila a fila en memoria (ver la cabecera del archivo). Sirve
       para no traer 50.000 filas de PostgreSQL de una vez, no para que el
       Excel cueste lo mismo con 500 que con 50.000. */
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
}

/**
 * Una venta tal como la necesita la hoja individual de una vendedora.
 *
 * Sale del `select` que hace `hojasPorVendedora()` de una vez para todo el
 * libro: se declara con `Prisma.VentaImportadaGetPayload` en vez de a mano para
 * que añadir una columna al `select` y olvidarse de la tabla —o al revés— sea
 * un error de compilación y no una columna en blanco en el Excel que se firma.
 */
type VentaDeHoja = Prisma.VentaImportadaGetPayload<{
  select: {
    vendedoraId: true;
    fecha: true; modulo: true; detalle: true; paciente: true; medico: true;
    captacion: true; canal: true; clasif: true; tipo: true; nivel: true;
    precio: true; ingresoNeto: true; comisionable: true; motivoExclusion: true;
    codOrigen: true;
  };
}>;
