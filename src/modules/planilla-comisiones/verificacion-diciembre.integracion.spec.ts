import { readFileSync } from 'node:fs';

import { ClasifComision } from '@prisma/client';

import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AnaliticaComisionesService } from './analitica-comisiones.service';
import { CalculoComisionesService } from './calculo-comisiones.service';
import { ConfiguracionComisionesService } from './configuracion-comisiones.service';
import { CatalogoClinicoService } from './catalogo-clinico.service';
import { PlanillaComisionesService } from './planilla-comisiones.service';
import { ResumenAnualService } from './resumen-anual.service';

/**
 * ¿Importar los tres Excel reales reproduce la planilla de administración?
 *
 * No es una prueba de unidades: importa los mismos `.xlsx` que usa la clínica,
 * corre el cálculo completo y compara contra las cifras que administración pagó
 * en diciembre de 2025. Es la única forma honesta de responder "¿me va a dar
 * exactamente lo mismo?".
 *
 * Si los archivos no están en el disco, se omite en vez de fallar: no todo el
 * mundo que clone el repo tendrá la carpeta de Excels.
 */
const CARPETA = '/Users/macmini2024/Documents/CARPETA RENE/Excels';

const MESES = [
  { archivo: 'octubre.xlsx', anio: 2025, mes: 10 },
  { archivo: 'noviembre.xlsx', anio: 2025, mes: 11 },
  { archivo: 'diciembre.xlsx', anio: 2025, mes: 12 },
];

/**
 * Comisión de PLANES que pagó la planilla en diciembre 2025, en USD.
 *
 * Sale de la hoja `por Ejecutiva`, bloque PLANES, columna
 * `COMISIÓN MATERNIDAD PLAN NIÑO` (fila 14), que es la suma por vendedora de
 * `=SI(PLANPAG COMISIONABLE="COMISIONA"; % de la fila × base de la fila; 0)`.
 *
 * Es la cifra que ninguna prueba miraba, y por eso el motor pudo pasar meses
 * eligiendo los planes equivocados sin que nada fallara: con la regla anterior
 * —los de base más baja— Claudia cobraba 50,65 en vez de 100,93 y la
 * conciliación de `montoVendido` seguía en verde, porque lo vendido no cambia
 * según cuál plan comisione.
 *
 * Zuany igualó su objetivo (4 de 4) y Viviana no lo alcanzó (3 de 6): las dos
 * cobran cero, que es la franquicia funcionando.
 */
const ESPERADO_TIPO_A = [
  { codigo: 'Pe1342', nombre: 'Viviana', comisionAUsd: 0 },
  { codigo: 'Pe2455', nombre: 'Claudia', comisionAUsd: 100.93 },
  { codigo: 'Pe2456', nombre: 'Yelca', comisionAUsd: 78.73 },
  { codigo: 'Pe1535', nombre: 'Zuany', comisionAUsd: 0 },
];

/** Lo que administración pagó en diciembre 2025 (hoja "GRAL COM", filas 7-13). */
const ESPERADO_DICIEMBRE = [
  { codigo: 'Pe1342', nombre: 'Viviana', montoVendido: 26641.39, comisionBob: 2844.8, bonoTrimestralBob: 1063.76 },
  { codigo: 'Pe2455', nombre: 'Claudia', montoVendido: 18098.82, comisionBob: 1199.17, bonoTrimestralBob: 962.21 },
  { codigo: 'Pe2456', nombre: 'Yelca', montoVendido: 20759.43, comisionBob: 1138.71, bonoTrimestralBob: 576.07 },
  { codigo: 'Pe1535', nombre: 'Zuany', montoVendido: 18843.4, comisionBob: 698.21, bonoTrimestralBob: 611.34 },
];

const URL_TEST = process.env['DATABASE_URL_TEST'] ?? 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';
const prisma = new PrismaService({ datasources: { db: { url: URL_TEST } } });

let planilla: PlanillaComisionesService;
let calculo: CalculoComisionesService;
let anual: ResumenAnualService;
let hayArchivos = true;

beforeAll(async () => {
  try {
    for (const m of MESES) readFileSync(`${CARPETA}/${m.archivo}`);
  } catch {
    hayArchivos = false;
    return;
  }

  await prisma.$connect();
  const config = new ConfiguracionComisionesService(prisma);
  const audit = new AuditService(prisma);
  calculo = new CalculoComisionesService(prisma, config, audit, new AnaliticaComisionesService(prisma));
  planilla = new PlanillaComisionesService(prisma, config, audit, new CatalogoClinicoService(prisma));
  anual = new ResumenAnualService(prisma, config);

  /* Silencia los avisos del importador y del cálculo: esta prueba mueve 1.600
     filas reales y el log tapaba el resultado. */
  for (const servicio of [planilla, calculo]) {
    const conLogger = servicio as unknown as { logger: { log: () => void; warn: () => void } };
    jest.spyOn(conLogger.logger, 'log').mockImplementation(() => undefined);
    jest.spyOn(conLogger.logger, 'warn').mockImplementation(() => undefined);
  }
}, 60000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe('los tres Excel reales contra la planilla de diciembre 2025', () => {
  const resultados = new Map<string, Record<string, number>>();
  let montoVendidoPorCodigo = new Map<string, number>();
  const comisionAPorCodigo = new Map<string, number>();
  let periodoDiciembre = '';

  it('importa octubre, noviembre y diciembre y calcula diciembre', async () => {
    if (!hayArchivos) return;

    for (const m of MESES) {
      const buffer = readFileSync(`${CARPETA}/${m.archivo}`);
      const res = await planilla.importar(buffer, m.archivo, { anio: m.anio, mes: m.mes }, 'test');
      const periodoId = (res as { periodo: { id: string } }).periodo.id;
      await calculo.calcular(periodoId, 'test');
      if (m.mes === 12) periodoDiciembre = periodoId;
    }

    const filas = await prisma.resultadoComision.findMany({
      where: { periodoId: periodoDiciembre },
      include: { vendedora: true },
    });

    for (const f of filas) {
      comisionAPorCodigo.set(f.vendedora.codigo, Number(f.comisionA));
      resultados.set(f.vendedora.codigo, {
        montoVendido: Number(f.montoVendido),
        comisionBob: Number(f.totalBob) - Number(f.bonoTrimestral) * 1 - 0,
        bonoTrimestralBob: Number(f.bonoTrimestral),
        totalBob: Number(f.totalBob),
      });
    }

    montoVendidoPorCodigo = new Map(
      filas.map(f => [f.vendedora.codigo, Number(f.montoVendido)]),
    );

    expect(filas.length).toBeGreaterThan(0);
  }, 180000);

  it.each(ESPERADO_DICIEMBRE)(
    '$nombre: el monto vendido coincide con la planilla',
    ({ codigo, montoVendido }) => {
      if (!hayArchivos) return;
      expect(montoVendidoPorCodigo.get(codigo)).toBeCloseTo(montoVendido, 1);
    },
  );

  /*
   * El tipo de cambio que sirve el navbar sale del periodo más reciente, no de
   * una constante del frontend. Con octubre, noviembre y diciembre importados,
   * el vigente es el de diciembre.
   */
  it('el tipo de cambio vigente sale del último periodo importado', async () => {
    if (!hayArchivos) return;

    const vigente = await planilla.tipoCambioVigente();
    expect(vigente).toEqual({ tipoCambio: 6.97, anio: 2025, mes: 12, origen: 'periodo' });
  });

  it.each(ESPERADO_TIPO_A)(
    '$nombre: la comisión de planes coincide con la planilla ($comisionAUsd USD)',
    ({ codigo, comisionAUsd }) => {
      if (!hayArchivos) return;
      expect(comisionAPorCodigo.get(codigo)).toBeCloseTo(comisionAUsd, 1);
    },
  );

  /**
   * Los planes que comisionan son los ÚLTIMOS por correlativo de registro.
   *
   * Se comprueba sobre los datos importados y no solo en la prueba unitaria
   * porque lo que importa es que el correlativo sobreviva al parser y llegue al
   * motor: si `codOrigen` se perdiera por el camino, la selección caería a la
   * fecha y elegiría otros planes sin que nada avisara.
   */
  it('comisionan los últimos planes vendidos, no los más baratos', async () => {
    if (!hayArchivos) return;

    const planes = await prisma.ventaImportada.findMany({
      where: {
        periodoId: periodoDiciembre,
        clasif: { in: [ClasifComision.PLANPAQ, ClasifComision.PLANNIN] },
        comisionable: true,
        vendedoraId: { not: null },
      },
      select: { codOrigen: true, ingresoNeto: true, vendedoraId: true },
    });
    expect(planes.length).toBeGreaterThan(0);

    // Claudia superó su objetivo por 2, y la planilla marcó VE1458 y VE1462.
    const claudia = await prisma.vendedoraComision.findFirst({ where: { codigo: 'Pe2455' } });
    const suyos = planes
      .filter(p => p.vendedoraId === claudia?.id)
      .sort((a, b) => Number(a.codOrigen?.replace(/\D+/g, '')) - Number(b.codOrigen?.replace(/\D+/g, '')));

    expect(suyos.map(p => p.codOrigen)).toEqual([
      'VE1447',
      'VE1452',
      'VE1454',
      'VE1457',
      'VE1458',
      'VE1462',
    ]);

    // Y los dos últimos no son los dos más baratos: si lo fueran, esta prueba
    // pasaría con cualquiera de los dos criterios y no probaría nada.
    const dosMasBaratos = [...suyos]
      .sort((a, b) => Number(a.ingresoNeto) - Number(b.ingresoNeto))
      .slice(0, 2)
      .map(p => p.codOrigen)
      .sort();
    expect(dosMasBaratos).not.toEqual(['VE1458', 'VE1462']);
  }, 30000);

  /**
   * La base es SIEMPRE precio × 0,87, también en las filas con anticipo.
   *
   * Esto se comprueba aquí, sobre las filas que salieron de los tres Excel
   * reales, y no solo en una prueba unitaria con tres filas escritas a mano.
   * La regla anterior —"si hay anticipo, ese monto es la base"— se dio por
   * válida verificándola CONTRA LA BASE DE DATOS, que la había escrito ese mismo
   * código: una comprobación circular que no demuestra nada.
   *
   * La planilla de diciembre lo desmiente en sus 356 filas, y este mes trae 20
   * con anticipo, así que el caso está cubierto de verdad.
   */
  it('la base de TODAS las filas importadas es precio × 0,87', async () => {
    if (!hayArchivos) return;

    const filas = await prisma.ventaImportada.findMany({
      select: { precio: true, anticipoPlan: true, ingresoNeto: true },
    });

    expect(filas.length).toBeGreaterThan(300);

    const desviadas = filas.filter(
      f => Math.abs(Number(f.ingresoNeto) - Number(f.precio) * 0.87) > 0.02,
    );
    expect(desviadas).toHaveLength(0);
  });

  it('las filas con anticipo NO liquidan sobre el anticipo', async () => {
    if (!hayArchivos) return;

    const conAnticipo = await prisma.ventaImportada.findMany({
      where: { anticipoPlan: { not: null } },
      select: { precio: true, anticipoPlan: true, ingresoNeto: true },
    });

    // Los tres meses traen 61 filas con anticipo: el caso está cubierto de verdad.
    expect(conAnticipo.length).toBeGreaterThan(0);

    for (const f of conAnticipo) {
      const base = Number(f.ingresoNeto);
      /* Tolerancia de 2 céntimos, no exactitud al céntimo: `redondear` corrige el
         arrastre binario del flotante y alguna fila queda a menos de un céntimo
         del producto exacto. Lo que esta prueba fija es la REGLA —la base sale
         del precio, no del anticipo—, y para eso 0,02 sobra: el anticipo se
         desvía del precio en cientos o miles, no en céntimos. */
      expect(Math.abs(base - Number(f.precio) * 0.87)).toBeLessThan(0.02);
      /* Y la comprobación que de verdad importa: no es el anticipo. */
      if (Math.abs(Number(f.anticipoPlan) - Number(f.precio) * 0.87) > 1) {
        expect(Math.abs(base - Number(f.anticipoPlan))).toBeGreaterThan(0.02);
      }
    }
  });

  it('Gizelle no se liquida: no está en el equipo oficial', () => {
    if (!hayArchivos) return;
    expect(resultados.has('Pe2591')).toBe(false);
  });

  /**
   * La vista anual debe reproducir la tabla trimestral de administración
   * (hoja "CALCULO BONOS", filas 71-74) sin que nadie sume nada a mano.
   */
  describe('resumen anual — el cuarto trimestre contra la planilla', () => {
    const ESPERADO_T4 = [
      { codigo: 'Pe1342', nombre: 'Viviana', oct: 31908.22, nov: 33025.19, dic: 26641.39, promedio: 30524.93, bonoUsd: 152.62 },
      { codigo: 'Pe1535', nombre: 'Zuany', oct: 8421.73, nov: 25358.89, dic: 18843.4, promedio: 17541.34, bonoUsd: 87.71 },
      { codigo: 'Pe2455', nombre: 'Claudia', oct: 25970.21, nov: 38761.69, dic: 18098.82, promedio: 27610.24, bonoUsd: 138.05 },
      { codigo: 'Pe2456', nombre: 'Yelca', oct: 12653.21, nov: 16177.2, dic: 20759.43, promedio: 16529.95, bonoUsd: 82.65 },
    ];

    it.each(ESPERADO_T4)('$nombre: los tres meses y el promedio del T4', async ({ codigo, oct, nov, dic, promedio }) => {
      if (!hayArchivos) return;
      const r = await anual.porAnio(2025);
      const fila = r.filas.find(f => f.codigo === codigo);
      expect(fila).toBeDefined();

      expect(fila!.meses[9].montoVendido).toBeCloseTo(oct, 1);
      expect(fila!.meses[10].montoVendido).toBeCloseTo(nov, 1);
      expect(fila!.meses[11].montoVendido).toBeCloseTo(dic, 1);

      const t4 = fila!.trimestres[3];
      expect(t4.promedio).toBeCloseTo(promedio, 1);
      expect(t4.cumple).toBe(true);
    }, 60000);

    it.each(ESPERADO_T4)('$nombre: el bono del T4', async ({ codigo, bonoUsd }) => {
      if (!hayArchivos) return;
      const r = await anual.porAnio(2025);
      const t4 = r.filas.find(f => f.codigo === codigo)!.trimestres[3];
      expect(t4.bonoUsd).toBeCloseTo(bonoUsd, 1);
    }, 60000);

    it('los trimestres sin datos no inventan bono', async () => {
      if (!hayArchivos) return;
      const r = await anual.porAnio(2025);
      /* Solo se importaron octubre, noviembre y diciembre: T1, T2 y T3 están
         vacíos y deben salir en cero, no con un promedio de la nada. */
      for (const fila of r.filas) {
        for (const t of fila.trimestres.slice(0, 3)) {
          expect(t.mesesConDatos).toBe(0);
          expect(t.bonoUsd).toBe(0);
          expect(t.cumple).toBe(false);
        }
      }
    }, 60000);
  });
});
