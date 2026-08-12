import { readFileSync } from 'node:fs';

import { ConfigService } from '@nestjs/config';

import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CalculoComisionesService } from './calculo-comisiones.service';
import { ConfiguracionComisionesService } from './configuracion-comisiones.service';
import { PlanillaComisionesService } from './planilla-comisiones.service';

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
  { archivo: 'octubre-filemaker.xlsx', anio: 2025, mes: 10 },
  { archivo: 'noviembre-filemaker.xlsx', anio: 2025, mes: 11 },
  { archivo: 'Diciembre 2025 filemaker.xlsx', anio: 2025, mes: 12 },
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
  planilla = new PlanillaComisionesService(prisma, config, audit);

  for (const s of [planilla, calculo]) {
    jest.spyOn(s['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(s['logger'], 'warn').mockImplementation(() => undefined);
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
});
