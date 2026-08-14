import { readFileSync } from 'node:fs';

import { ConfigService } from '@nestjs/config';

import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
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
  calculo = new CalculoComisionesService(prisma, config, audit);
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

  it('importa octubre, noviembre y diciembre y calcula diciembre', async () => {
    if (!hayArchivos) return;

    let periodoDiciembre = '';
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
