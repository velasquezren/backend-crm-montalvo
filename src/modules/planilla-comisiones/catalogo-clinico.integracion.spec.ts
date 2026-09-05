import { PrismaService } from '../../prisma/prisma.service';
import { CatalogoClinicoService } from './catalogo-clinico.service';

/**
 * Pruebas contra el Postgres de verdad (`crm_test` en el :5433 local).
 *
 * Lo que se comprueba aquí lo decide Postgres: son tres `groupBy` con orden por
 * conteo. Una base falsa daría por buena la agregación sin ejecutarla, que es
 * justo donde puede estar el error.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';

if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService(URL_TEST);

let service: CatalogoClinicoService;
let periodoId: string;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.ventaImportada.deleteMany();
  await prisma.periodoComision.deleteMany();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.ventaImportada.deleteMany();
  await prisma.periodoComision.deleteMany();

  const periodo = await prisma.periodoComision.create({
    data: { anio: 2025, mes: 12, tipoCambio: 6.97 },
  });
  periodoId = periodo.id;
  service = new CatalogoClinicoService(prisma);
});

async function venta(detalle: string, modulo: string, medico: string | null) {
  await prisma.ventaImportada.create({
    data: {
      periodoId,
      detalle,
      modulo,
      medico,
      precio: 100,
      canal: 'PROPIO',
      ingresoNeto: 87,
      unidadNegocio: 'VARIOS',
      clasif: 'OTROSS',
      tipo: 'A',
    },
  });
}

describe('CatalogoClinicoService contra Postgres real', () => {
  it('ordena los servicios por lo más vendido, no alfabéticamente', async () => {
    await venta('Hemograma Completo', 'LABORATORIO', 'Dra. A');
    await venta('Hemograma Completo', 'LABORATORIO', 'Dra. A');
    await venta('Hemograma Completo', 'LABORATORIO', 'Dra. B');
    await venta('Abdominoplastia', 'INTERNACION', 'Dr. C');

    const { servicios } = await service.obtener();

    expect(servicios[0]).toMatchObject({ nombre: 'Hemograma Completo', veces: 3 });
    expect(servicios[1]).toMatchObject({ nombre: 'Abdominoplastia', veces: 1 });
  });

  it('conserva el módulo de FileMaker junto a cada servicio', async () => {
    await venta('Ecografia Transvaginal', 'CONSULTA', null);

    const { servicios } = await service.obtener();

    expect(servicios[0].modulo).toBe('CONSULTA');
  });

  /* El mismo servicio puede haberse facturado bajo dos módulos distintos. Sin
     agrupar, el desplegable mostraría la misma línea dos veces. */
  it('no duplica un servicio que aparece en dos módulos', async () => {
    await venta('Consulta (Externa)', 'CONSULTA', null);
    await venta('Consulta (Externa)', 'PLANES', null);

    const { servicios } = await service.obtener();

    expect(servicios.filter(s => s.nombre === 'Consulta (Externa)')).toHaveLength(1);
    expect(servicios[0].veces).toBe(2);
  });

  it('lista los médicos por frecuencia y descarta los vacíos', async () => {
    await venta('X', 'CONSULTA', 'Dr. Montalvo');
    await venta('Y', 'CONSULTA', 'Dr. Montalvo');
    await venta('Z', 'CONSULTA', 'Dra. Rivera');
    await venta('W', 'LABORATORIO', null);
    await venta('V', 'LABORATORIO', '   ');

    const { medicos } = await service.obtener();

    expect(medicos.map(m => m.nombre)).toEqual(['Dr. Montalvo', 'Dra. Rivera']);
    expect(medicos[0].veces).toBe(2);
  });

  it('informa cuántas ventas respaldan las sugerencias', async () => {
    await venta('A', 'CONSULTA', null);
    await venta('B', 'CONSULTA', null);

    expect((await service.obtener()).ventasAnalizadas).toBe(2);
  });

  /* Se cachea una hora: sin invalidar, importar un Excel nuevo no se vería. */
  it('la caché sirve lo mismo hasta que se invalida', async () => {
    await venta('Primero', 'CONSULTA', null);
    expect((await service.obtener()).servicios).toHaveLength(1);

    await venta('Segundo', 'CONSULTA', null);
    expect((await service.obtener()).servicios).toHaveLength(1);

    service.invalidar();
    expect((await service.obtener()).servicios).toHaveLength(2);
  });
});
