import { AreaVendedora } from '../../prisma/prisma-client';
import { Workbook, Worksheet } from 'exceljs';
import { PassThrough } from 'stream';

import { CalculoComisionesService } from './calculo-comisiones.service';
import { ExportacionComisionesService } from './exportacion-comisiones.service';

/**
 * El libro que sale de aquí se imprime, se firma y se archiva: es el único
 * artefacto de este módulo que sale de la clínica. Que una vendedora dada de
 * baja no figure en él es el motivo entero por el que existe la marca `oculta`.
 *
 * Se comprueba sobre el .xlsx REAL —se escribe y se vuelve a leer con ExcelJS—
 * y no sobre lo que devuelve `reporteConsolidado()`. La diferencia importa: el
 * filtro vive en el consolidado, pero de ahí cuelgan cuatro hojas distintas
 * (Liquidación, Tipo A (RA), Planes por Vendedora y una hoja por persona) y
 * bastaría que una sola volviera a consultar la base por su cuenta para que el
 * nombre reapareciera en el archivo sin que ninguna otra prueba se enterara.
 * La hoja individual es la más delicada: lleva el desglose y las ventas de esa
 * persona, no solo su nombre.
 *
 * Las dos reglas que fija, y que no son simetría casual:
 *
 * - Se oculta la PERSONA, no el dinero. Las cifras de facturación del Resumen
 *   siguen contando sus ventas: es ingreso de la clínica.
 * - La exclusión se DECLARA. El Resumen dice cuántas y cuáles faltan, y la
 *   Liquidación lo repite al pie. Sin eso, los totales cuadran con sus filas y
 *   aun así falta gente: quien cotejara contra su Excel buscaría un error de
 *   cálculo que no existe.
 */

const TC = 6.97;

function resultado(
  id: string,
  nombre: string,
  oculta: boolean,
  comisionUsd: number,
  area: AreaVendedora = AreaVendedora.EJECUTIVA,
) {
  /* Marketing no comisiona: todo su pago es bono. Se modela igual que lo hace
     el motor —comisiones en cero y el importe en `bonoPublicidad`— para que la
     hoja reciba exactamente la forma que produce producción. */
  const esMarketing = area === AreaVendedora.PUBLICIDAD;
  return {
    vendedoraId: id,
    montoVendido: esMarketing ? 0 : comisionUsd * 10,
    baseCalculo: esMarketing ? 0 : comisionUsd * 8.7,
    planesVendidos: 0,
    cumpleObjetivoPlanes: false,
    planpaqVendidos: 0,
    planpaqComisionables: 0,
    planninVendidos: 0,
    planninComisionables: 0,
    acumuladoCirugias: 0,
    nivelCirugia: null,
    ingresoMaternidadTipoARA: 0,
    ingresoRATipoARA: 0,
    excedenteTipoARA: 0,
    nivelTipoARA: null,
    comisionA: esMarketing ? 0 : comisionUsd,
    comisionB: 0,
    comisionC: 0,
    comisionTipoARA: 0,
    bonoJefatura: 0,
    bonoPublicidad: esMarketing ? comisionUsd : 0,
    bonoTrimestral: 0,
    totalUsd: comisionUsd,
    totalBob: comisionUsd * TC,
    sueldoBase: 0,
    totalGanado: comisionUsd * TC,
    desglose: [],
    vendedora: {
      id,
      nombre,
      codigo: `C${id}`,
      tipo: 'VENDEDORA',
      area,
      oculta,
      ocultaDesde: oculta ? new Date('2026-03-01') : null,
      motivoOculta: oculta ? 'Ya no trabaja en la clínica' : null,
    },
  };
}

const PERIODO = {
  id: 'p1',
  anio: 2026,
  mes: 1,
  tipoCambio: TC,
  estado: 'CALCULADO',
  archivoNombre: 'enero.xlsx',
  filasTotales: 2,
  configuracionUsada: null,
};

/** Zuany sigue en el equipo; Yelca está dada de baja. */
function montar(conMarketing = false): ExportacionComisionesService {
  const prisma = {
    periodoComision: { findUnique: async () => PERIODO },
    resultadoComision: {
      findMany: async () => [
        resultado('v1', 'Zuany', false, 100),
        resultado('v2', 'Yelca', true, 40),
        ...(conMarketing
          ? [
              resultado('v3', 'Cristel', false, 33.35, AreaVendedora.PUBLICIDAD),
              resultado('v4', 'Araceli', false, 33.35, AreaVendedora.PUBLICIDAD),
            ]
          : []),
      ],
    },
    ventaImportada: { findMany: async () => [] },
  };

  const calculo = new CalculoComisionesService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  /* La analítica es facturación, no personas: sus cifras son las del mes
     COMPLETO (las dos vendedoras) se oculte a quien se oculte. */
  const analitica = {
    analitica: async () => ({
      periodo: PERIODO,
      resumen: {
        filasComisionables: 2,
        filasExcluidas: 0,
        montoVendido: 1400,
        baseCalculo: 1218,
        impuestosDescontados: 182,
        ticketPromedio: 700,
        ventaMayor: 1000,
        pacientesUnicos: 2,
        serviciosDistintos: 2,
        tipoCambio: TC,
        vendedorasLiquidadas: 2,
        comisionTipoAUsd: 140,
        comisionTipoBUsd: 0,
        comisionTipoCUsd: 0,
        comisionTipoARAUsd: 0,
        bonosUsd: 0,
        comisionTotalUsd: 140,
        comisionTotalBob: 975.8,
      },
      porClasificacion: [],
      porCanal: [],
      porModulo: [],
      porUnidadNegocio: [],
      porNivelPlan: [],
      topServicios: [],
      topMedicos: [],
      porDia: [],
    }),
  };

  return new ExportacionComisionesService(prisma as never, analitica as never, calculo as never);
}

/** Genera el .xlsx de verdad y lo vuelve a leer. */
async function libroDe(incluirOcultas: boolean, conMarketing = false): Promise<Workbook> {
  const trozos: Buffer[] = [];
  const salida = new PassThrough();
  salida.on('data', c => trozos.push(c as Buffer));
  const cerrado = new Promise<void>(resolver => salida.on('end', () => resolver()));

  await montar(conMarketing).exportar('p1', salida, incluirOcultas);
  salida.end();
  await cerrado;

  const libro = new Workbook();
  await libro.xlsx.load(Buffer.concat(trozos) as never);
  return libro;
}

/** Personas de la primera columna: sin cabecera, sin subtotales y sin avisos. */
function vendedorasDe(hoja: Worksheet | undefined): string[] {
  const nombres: string[] = [];
  hoja?.eachRow((fila, numero) => {
    if (numero === 1) return;
    const nombre = fila.getCell(1).value;
    if (typeof nombre !== 'string') return;
    if (nombre.startsWith('TOTAL') || nombre.startsWith('No se listan') || nombre.startsWith('EQUIPO')) {
      return;
    }
    nombres.push(nombre);
  });
  return nombres;
}

/** En qué fila está una etiqueta de la primera columna. */
function filaDe_(hoja: Worksheet | undefined, etiqueta: string): number {
  let encontrada = 0;
  hoja?.eachRow((fila, numero) => {
    if (fila.getCell(1).value === etiqueta) encontrada = numero;
  });
  return encontrada;
}

/**
 * Un valor de la fila TOTALES, localizado por el TÍTULO de su columna.
 *
 * Por título y no por `getColumn(clave)`: las claves de columna solo existen
 * en el libro que se está construyendo en memoria; al releer el .xlsx se
 * pierden. Y por título y no por número fijo: así insertar una columna en medio
 * del informe no convierte esta prueba en un falso verde comparando la de al
 * lado.
 */
function total(
  hoja: Worksheet | undefined,
  titulo: string,
  etiqueta = 'TOTALES',
): unknown {
  if (!hoja) return undefined;
  const cabecera = hoja.getRow(1).values as unknown[];
  const columna = cabecera.indexOf(titulo);
  if (columna < 1) throw new Error(`La hoja no tiene una columna "${titulo}"`);

  let valor: unknown;
  hoja.eachRow(fila => {
    if (fila.getCell(1).value === etiqueta) valor = fila.getCell(columna).value;
  });
  return valor;
}

function filaDe(hoja: Worksheet | undefined, etiqueta: string): unknown {
  let valor: unknown;
  hoja?.eachRow(fila => {
    if (fila.getCell(1).value === etiqueta) valor = fila.getCell(2).value;
  });
  return valor;
}

describe('Excel del periodo · vendedoras dadas de baja', () => {
  describe('por defecto (no se incluyen)', () => {
    it('la hoja Liquidación solo lista a quien sigue en el equipo', async () => {
      const libro = await libroDe(false);

      expect(vendedorasDe(libro.getWorksheet('Liquidación'))).toEqual(['Zuany']);
    });

    /* La hoja individual es la que lleva su desglose y sus ventas del mes: si
       el filtro se olvidara en `hojasPorVendedora()`, el nombre desaparecería
       de la planilla y seguiría habiendo una pestaña con su nombre al lado. */
    it('no se crea la hoja individual de la vendedora dada de baja', async () => {
      const libro = await libroDe(false);
      const hojas = libro.worksheets.map(h => h.name);

      expect(hojas).toContain('Zuany');
      expect(hojas).not.toContain('Yelca');
    });

    it('los TOTALES de la planilla son la suma de las filas listadas', async () => {
      const hoja = (await libroDe(false)).getWorksheet('Liquidación');

      // Los de Zuany sola, no los del mes entero.
      expect(total(hoja, 'Total ($)')).toBe(100);
      expect(total(hoja, 'A PAGAR (Bs)')).toBe(697);
    });

    it('el Resumen declara cuántas faltan y por qué', async () => {
      const libro = await libroDe(false);
      const resumen = libro.getWorksheet('Resumen');

      expect(filaDe(resumen, 'De ellas, dadas de baja y NO listadas')).toBe(1);
      expect(filaDe(resumen, '   · Yelca (Cv2)')).toBe('Ya no trabaja en la clínica');
    });

    /* Se oculta la persona, no el dinero: sus ventas son facturación de la
       clínica y borrarlas haría que el informe mintiera sobre el mes. */
    it('la facturación del mes sigue contando sus ventas', async () => {
      const libro = await libroDe(false);
      const resumen = libro.getWorksheet('Resumen');

      expect(filaDe(resumen, 'Monto facturado')).toBe(1400);
      expect(filaDe(resumen, 'Ventas comisionables')).toBe(2);
    });
  });

  describe('con incluirOcultas', () => {
    it('vuelve a la planilla y a su hoja individual', async () => {
      const libro = await libroDe(true);

      expect(vendedorasDe(libro.getWorksheet('Liquidación')).sort()).toEqual(['Yelca', 'Zuany']);
      expect(libro.worksheets.map(h => h.name)).toContain('Yelca');
    });

    it('los TOTALES vuelven a sumar a todo el equipo', async () => {
      const hoja = (await libroDe(true)).getWorksheet('Liquidación');

      expect(total(hoja, 'Total ($)')).toBe(140);
      expect(total(hoja, 'A PAGAR (Bs)')).toBe(975.8);
    });

    /* Nada que declarar: no falta nadie. */
    it('el Resumen ya no anuncia exclusiones', async () => {
      const libro = await libroDe(true);

      expect(filaDe(libro.getWorksheet('Resumen'), 'De ellas, dadas de baja y NO listadas')).toBeUndefined();
    });
  });

  /**
   * El equipo de marketing va en un bloque aparte de la hoja "Liquidación".
   *
   * No es preferencia estética: su fila tiene 14 de las 20 columnas en cero
   * —no vende, no tiene planes, no llega a ningún nivel— y mezclada entre las
   * ejecutivas obliga a leer fila por fila para entender por qué. La planilla
   * de administración ya lo resuelve así: el bloque "EQUIPO DE PUBLICIDAD" de
   * la hoja "CALCULO BONOS", aparte de la tabla de vendedoras.
   */
  describe('equipo de marketing', () => {
    it('va DEBAJO de la tabla de ventas, después de su subtotal', async () => {
      const hoja = (await libroDe(false, true)).getWorksheet('Liquidación');

      const zuany = filaDe_(hoja, 'Zuany');
      const subtotalVentas = filaDe_(hoja, 'TOTAL EQUIPO DE VENTAS');
      const cristel = filaDe_(hoja, 'Cristel');

      expect(zuany).toBeLessThan(subtotalVentas);
      expect(subtotalVentas).toBeLessThan(cristel);
    });

    it('las dos están listadas en su bloque', async () => {
      const hoja = (await libroDe(false, true)).getWorksheet('Liquidación');

      expect(vendedorasDe(hoja)).toEqual(['Zuany', 'Cristel', 'Araceli']);
    });

    /* Cada pie suma las filas que tiene ENCIMA. Si el subtotal de ventas
       reutilizara el total del periodo diría 166,70 sobre una sola fila de 100. */
    it('el subtotal de ventas no incluye a marketing', async () => {
      const hoja = (await libroDe(false, true)).getWorksheet('Liquidación');

      expect(total(hoja, 'Total ($)', 'TOTAL EQUIPO DE VENTAS')).toBeCloseTo(100, 2);
    });

    it('el subtotal de marketing suma solo a marketing', async () => {
      const hoja = (await libroDe(false, true)).getWorksheet('Liquidación');

      expect(total(hoja, 'Total ($)', 'TOTAL MARKETING')).toBeCloseTo(66.7, 2);
    });

    /* El único número que junta los dos bloques: lo que sale de caja. */
    it('cierra con el total general de los dos bloques', async () => {
      const hoja = (await libroDe(false, true)).getWorksheet('Liquidación');

      expect(total(hoja, 'Total ($)', 'TOTAL GENERAL A PAGAR')).toBeCloseTo(166.7, 2);
    });

    /* Sin marketing la hoja no cambia de vocabulario: el pie sigue diciendo
       "TOTALES", que es lo que administración ya conoce. */
    it('sin marketing, el pie se sigue llamando TOTALES', async () => {
      const hoja = (await libroDe(false)).getWorksheet('Liquidación');

      expect(filaDe_(hoja, 'TOTALES')).toBeGreaterThan(0);
      expect(filaDe_(hoja, 'TOTAL MARKETING')).toBe(0);
    });

    /* Su pestaña saldría vacía: no tiene ventas, ni desglose, ni planes. */
    it('no se les crea hoja individual', async () => {
      const hojas = (await libroDe(false, true)).worksheets.map(h => h.name);

      expect(hojas).toContain('Zuany');
      expect(hojas).not.toContain('Cristel');
      expect(hojas).not.toContain('Araceli');
    });

    it('el Resumen dice cuántas son de marketing', async () => {
      const resumen = (await libroDe(false, true)).getWorksheet('Resumen');

      expect(filaDe(resumen, 'De ellas, equipo de marketing (cobra bono, no comisiona)')).toBe(2);
    });
  });
});
