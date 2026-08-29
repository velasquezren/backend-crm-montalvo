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

function resultado(id: string, nombre: string, oculta: boolean, comisionUsd: number) {
  return {
    vendedoraId: id,
    montoVendido: comisionUsd * 10,
    baseCalculo: comisionUsd * 8.7,
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
    comisionA: comisionUsd,
    comisionB: 0,
    comisionC: 0,
    comisionTipoARA: 0,
    bonoJefatura: 0,
    bonoPublicidad: 0,
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
      area: 'EJECUTIVA',
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
function montar(): ExportacionComisionesService {
  const prisma = {
    periodoComision: { findUnique: async () => PERIODO },
    resultadoComision: {
      findMany: async () => [
        resultado('v1', 'Zuany', false, 100),
        resultado('v2', 'Yelca', true, 40),
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
async function libroDe(incluirOcultas: boolean): Promise<Workbook> {
  const trozos: Buffer[] = [];
  const salida = new PassThrough();
  salida.on('data', c => trozos.push(c as Buffer));
  const cerrado = new Promise<void>(resolver => salida.on('end', () => resolver()));

  await montar().exportar('p1', salida, incluirOcultas);
  salida.end();
  await cerrado;

  const libro = new Workbook();
  await libro.xlsx.load(Buffer.concat(trozos) as never);
  return libro;
}

/** Los nombres de la primera columna, sin cabecera, TOTALES ni el pie del aviso. */
function vendedorasDe(hoja: Worksheet | undefined): string[] {
  const nombres: string[] = [];
  hoja?.eachRow((fila, numero) => {
    if (numero === 1) return;
    const nombre = fila.getCell(1).value;
    if (typeof nombre !== 'string' || nombre === 'TOTALES' || nombre.startsWith('No se listan')) {
      return;
    }
    nombres.push(nombre);
  });
  return nombres;
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
function total(hoja: Worksheet | undefined, titulo: string): unknown {
  if (!hoja) return undefined;
  const cabecera = hoja.getRow(1).values as unknown[];
  const columna = cabecera.indexOf(titulo);
  if (columna < 1) throw new Error(`La hoja no tiene una columna "${titulo}"`);

  let valor: unknown;
  hoja.eachRow(fila => {
    if (fila.getCell(1).value === 'TOTALES') valor = fila.getCell(columna).value;
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
});
