import { Workbook, Worksheet } from 'exceljs';

import { AnaliticaComisionesService } from '../analitica-comisiones.service';
import { FotoConfiguracion } from '../calculo-comisiones.service';
import { redondear } from '../clasificador';
import { esDeMarketing, nombreMes } from '../informe-liquidacion';
import { ReportesComisionesService } from '../reportes-comisiones.service';
import { COLOR, ColumnaInforme, dato, FORMATO, hojaConCabecera, marcarTotales, nota, seccion, titulo } from './estilo';

/*
 * Las hojas del Excel mensual que salen enteras del consolidado y de la
 * analítica, sin volver a consultar la base: Resumen, Liquidación (con el
 * bloque de Marketing), Tipo A (RA), Distribución y Rankings.
 *
 * Son funciones y no métodos porque no tienen estado: reciben el libro y los
 * datos que ya reunió `ExportacionComisionesService.exportar()`, que decide
 * el orden de las hojas. Las que sí leen ventas del mes (Planes por Vendedora,
 * una hoja por persona y Detalle) siguen en el servicio, que es quien tiene
 * la base. La cabecera de `exportacion-comisiones.service.ts` explica el
 * vocabulario y las unidades; vale para todas.
 */


/* ── Hoja 1: resumen ejecutivo ──────────────────────────────────────── */

export function hojaResumen(
  libro: Workbook,
  informe: InformeAnalitica,
  consolidado: ConsolidadoPeriodo | null,
): void {
  const hoja = libro.addWorksheet('Resumen', { views: [{ showGridLines: false }] });
  hoja.columns = [{ width: 38 }, { width: 20 }, { width: 30 }];

  const { periodo, resumen } = informe;
  titulo(hoja, `Informe de Comisiones · ${nombreMes(periodo.mes)} ${periodo.anio}`, 3);

  hoja.addRow([]);
  seccion(hoja, 'Periodo', 3);
  dato(hoja, 'Estado', periodo.estado);
  dato(hoja, 'Archivo importado', periodo.archivoNombre ?? '—');
  dato(hoja, 'Filas en el archivo', periodo.filasTotales, FORMATO.entero);
  dato(hoja, 'Tipo de cambio aplicado', resumen.tipoCambio);

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
  seccion(hoja, 'Facturación (en dólares, la moneda del Excel de FileMaker)', 3);
  dato(hoja, 'Ventas comisionables', resumen.filasComisionables, FORMATO.entero);
  dato(hoja, 'Ventas excluidas del cálculo', resumen.filasExcluidas, FORMATO.entero);
  dato(hoja, 'Monto facturado', resumen.montoVendido, FORMATO.usd);
  dato(hoja, 'Impuestos descontados (13%)', resumen.impuestosDescontados, FORMATO.usd);
  dato(hoja, 'Base de cálculo', resumen.baseCalculo, FORMATO.usd);
  dato(hoja, 'Ticket promedio', resumen.ticketPromedio, FORMATO.usd);
  dato(hoja, 'Venta mayor', resumen.ventaMayor, FORMATO.usd);
  dato(hoja, 'Pacientes atendidos', resumen.pacientesUnicos, FORMATO.entero);
  dato(hoja, 'Servicios distintos', resumen.serviciosDistintos, FORMATO.entero);

  hoja.addRow([]);
  seccion(hoja, 'Comisiones a pagar (en dólares)', 3);
  dato(hoja, 'Vendedoras liquidadas', resumen.vendedorasLiquidadas, FORMATO.entero);
  /*
   * Va pegada al número que descuadra, no en un pie al final: quien cuadra
   * este informe contra su Excel mira "Vendedoras liquidadas", cuenta las
   * filas de la hoja "Liquidación" y le salen menos. La explicación tiene que
   * estar ahí mismo o el archivo entero pierde credibilidad.
   */
  /* Igual que con las dadas de baja: si el número de arriba no coincide con
     las filas de la tabla de ventas, esta línea dice por qué. */
  const enMarketing = (consolidado?.filas ?? []).filter(esDeMarketing);
  if (enMarketing.length > 0) {
    dato(
      hoja,
      'De ellas, equipo de marketing (cobra bono, no comisiona)',
      enMarketing.length,
      FORMATO.entero,
    );
  }

  const ocultasFuera = consolidado?.incluyeOcultas ? [] : (consolidado?.ocultas ?? []);
  if (ocultasFuera.length > 0) {
    dato(
      hoja,
      'De ellas, dadas de baja y NO listadas',
      ocultasFuera.length,
      FORMATO.entero,
    );
    for (const v of ocultasFuera) {
      dato(
        hoja,
        `   · ${v.nombre} (${v.codigo})`,
        v.motivoOculta ?? 'Sin motivo registrado',
      );
    }
  }
  dato(hoja, 'Tipo A · Planes de maternidad y varios', resumen.comisionTipoAUsd, FORMATO.usd);
  /*
   * Antes de 2026-08-24 esta sección no tenía línea propia para Tipo A
   * (RA): el dinero SÍ estaba en el TOTAL, pero no había forma de ver
   * cuánto era ni de dónde salía sin abrir la hoja "Tipo A (RA)" nueva —
   * que hasta esa fecha tampoco existía. Es justo el hueco que este
   * informe existe para tapar.
   */
  dato(
    hoja,
    'Tipo A (RA) · Consultas y análisis del área RA',
    resumen.comisionTipoARAUsd,
    FORMATO.usd,
  );
  dato(hoja, 'Tipo B · Cirugías e internaciones', resumen.comisionTipoBUsd, FORMATO.usd);
  dato(hoja, 'Tipo C · Consultas, laboratorios y otros', resumen.comisionTipoCUsd, FORMATO.usd);
  dato(hoja, 'Bonos', resumen.bonosUsd, FORMATO.usd);

  const total = dato(hoja, 'TOTAL EN DÓLARES', resumen.comisionTotalUsd, FORMATO.usd);
  const totalBs = dato(hoja, 'TOTAL EN BOLIVIANOS', resumen.comisionTotalBob, FORMATO.bob);
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

export function hojaLiquidacion(libro: Workbook, consolidado: ConsolidadoPeriodo): void {
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

  const hoja = hojaConCabecera(libro, 'Liquidación', columnas);
  nota(
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
  const equipoVentas = consolidado.filas.filter(f => !esDeMarketing(f));
  const equipoMarketing = consolidado.filas.filter(esDeMarketing);

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
    ...sumarFilas(equipoVentas),
  });
  marcarTotales(totales, columnas.length);

  if (equipoMarketing.length > 0) {
    bloqueMarketing(hoja, columnas, equipoMarketing, consolidado.totales);
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
export function bloqueMarketing(
  hoja: Worksheet,
  columnas: ColumnaInforme[],
  marketing: FilaConsolidado[],
  totalesDelPeriodo: Record<string, number>,
): void {
  hoja.addRow([]);
  seccion(hoja, 'EQUIPO DE MARKETING — cobra bono, no comisiona', columnas.length);

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
  const suma = sumarFilas(marketing);
  const subtotal = hoja.addRow({
    nombre: 'TOTAL MARKETING',
    bonos: suma['bonos'],
    totalUsd: suma['totalUsd'],
    totalBob: suma['totalBob'],
    sueldoBase: suma['sueldoBase'],
    totalGanado: suma['totalGanado'],
  });
  marcarTotales(subtotal, columnas.length);

  hoja.addRow([]);
  const general = hoja.addRow({
    nombre: 'TOTAL GENERAL A PAGAR',
    bonos: totalesDelPeriodo['bonos'],
    totalUsd: totalesDelPeriodo['totalUsd'],
    totalBob: totalesDelPeriodo['totalBob'],
    sueldoBase: totalesDelPeriodo['sueldoBase'],
    totalGanado: totalesDelPeriodo['totalGanado'],
  });
  marcarTotales(general, columnas.length);
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
export function sumarFilas(filas: FilaConsolidado[]): Record<string, number> {
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
export function hojaTipoARA(libro: Workbook, consolidado: ConsolidadoPeriodo): void {
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

  const hoja = hojaConCabecera(libro, 'Tipo A (RA)', columnas);

  nota(
    hoja,
    'combinado',
    'Ingreso planes de maternidad + ingreso RA. En el Excel de administración es la columna ' +
      '"SUMA MONTO COMISIONABLE" de la hoja BDEjecutivas.',
  );
  nota(
    hoja,
    'objetivo',
    'El mismo objetivo mensual en $ que usa el bono de jefatura (columna "MONTOBJETIVO" del Excel de ' +
      'administración) — NO el objetivo de CANTIDAD de planes, que es un número aparte.',
  );
  nota(
    hoja,
    'excedente',
    'Combinado − objetivo mensual. Negativo = todavía no llega ("NA" en el Excel de administración): ' +
      'el nivel queda vacío y la comisión en $0, aunque haya ventas RA.',
  );
  nota(
    hoja,
    'nivel',
    'Sale de ubicar el excedente en la escala de niveles (misma escala que usa Tipo B, tabla aparte). ' +
      'Columna "Asignación NIVEL (A)" en el Excel de administración.',
  );
  nota(
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
  for (const f of consolidado.filas.filter(v => !esDeMarketing(v))) {
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
  marcarTotales(totales, columnas.length);

  if (!algunoConNivel) {
    const aviso = hoja.addRow([
      'Ninguna vendedora superó su objetivo mensual combinado este periodo: el cubo Tipo A (RA) pagó $0 en total.',
    ]);
    aviso.font = { italic: true, size: 10, color: { argb: 'FF64748B' } };
    hoja.mergeCells(aviso.number, 1, aviso.number, columnas.length);
  }
}

/* ── Hoja 5: de dónde sale la facturación ───────────────────────────── */

export function hojaDistribucion(libro: Workbook, informe: InformeAnalitica): void {
  const columnas: ColumnaInforme[] = [
    { titulo: 'Agrupación', clave: 'grupo', ancho: 22 },
    { titulo: 'Concepto', clave: 'etiqueta', ancho: 36 },
    { titulo: 'Ventas', clave: 'cantidad', ancho: 10, formato: FORMATO.entero },
    { titulo: 'Facturado (USD)', clave: 'montoVendido', ancho: 17, formato: FORMATO.usd },
    { titulo: 'Base de cálculo (USD)', clave: 'baseCalculo', ancho: 19, formato: FORMATO.usd },
    { titulo: '% del mes', clave: 'pctMonto', ancho: 11, formato: FORMATO.pct },
  ];

  const hoja = hojaConCabecera(libro, 'Distribución', columnas);

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

export function hojaRankings(libro: Workbook, informe: InformeAnalitica): void {
  const columnas: ColumnaInforme[] = [
    { titulo: 'Ranking', clave: 'grupo', ancho: 22 },
    { titulo: 'Concepto', clave: 'etiqueta', ancho: 48 },
    { titulo: 'Cantidad', clave: 'cantidad', ancho: 11, formato: FORMATO.entero },
    { titulo: 'Facturado (USD)', clave: 'montoVendido', ancho: 17, formato: FORMATO.usd },
    { titulo: '% del mes', clave: 'pctMonto', ancho: 11, formato: FORMATO.pct },
  ];

  const hoja = hojaConCabecera(libro, 'Rankings', columnas);

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

/* Tipos de lo que devuelven los servicios de analítica y cálculo. Se declaran
   aquí para no exponer los internos de Prisma en la firma de la exportación. */

export interface PorcionInforme {
  etiqueta: string;
  cantidad: number;
  montoVendido: number;
  baseCalculo: number;
  pctMonto: number;
}

export type InformeAnalitica = Awaited<ReturnType<AnaliticaComisionesService['analitica']>>;
export type ConsolidadoPeriodo = Awaited<ReturnType<ReportesComisionesService['reporteConsolidado']>>;
export type FilaConsolidado = ConsolidadoPeriodo['filas'][number];
