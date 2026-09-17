import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { ClientesService } from '../clientes/clientes.service';
import { ServiciosService } from './servicios.service';

/**
 * F10.2 · qué pasa cuando el historial de un paciente pasa del tope.
 *
 * `historialPaciente` corta en 500 y `historialServicios` en 200, y los dos
 * calculan su resumen SOBRE EL ARRAY YA RECORTADO. La pregunta que responden
 * estas pruebas no es si el tope existe —existe y es defensivo— sino si lo que
 * se devuelve por encima de él se presenta como si fuera el historial completo.
 *
 * Contra PostgreSQL real porque lo que se mide es el efecto del `take` de
 * Prisma sobre el `orderBy`, que es cosa de la base.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';

if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService(URL_TEST);
let servicios: ServiciosService;
let periodoId: string;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.ventaImportada.deleteMany();
  await prisma.periodoComision.deleteMany();
  await prisma.cliente.deleteMany();

  const periodo = await prisma.periodoComision.create({
    data: { anio: 2026, mes: 3, tipoCambio: 6.96 },
  });
  periodoId = periodo.id;
  servicios = new ServiciosService(prisma);
});

/**
 * `cuantas` visitas del mismo paciente, una por día hacia atrás desde 2026-03-01.
 * Cada una cuesta 100, así que el gasto real es `cuantas * 100` y es fácil ver
 * si la suma se quedó corta.
 */
async function historialDe(pac: string, cuantas: number): Promise<void> {
  const filas = Array.from({ length: cuantas }, (_, i) => {
    const fecha = new Date('2026-03-01T12:00:00.000Z');
    fecha.setUTCDate(fecha.getUTCDate() - i);
    return {
      periodoId, detalle: `Consulta ${i}`, modulo: 'CONSULTA', precio: 100,
      fecha, medicoPk: `M${i % 7}`, medico: `Doctor ${i % 7}`, pac,
      paciente: 'Paciente de prueba', canal: 'PROPIO' as const, ingresoNeto: 87,
      unidadNegocio: 'VARIOS' as const, clasif: 'CONSULTA' as const, tipo: 'A' as const,
    };
  });
  await prisma.ventaImportada.createMany({ data: filas });
}

describe('F10.2 · historial de paciente por encima del tope de 500', () => {
  const REALES = 520;

  it('cuenta y suma TODAS las filas, no solo las que caben en la lista', async () => {
    await historialDe('PAC-GRANDE', REALES);

    const historial = await servicios.historialPaciente('PAC-GRANDE');
    const enBase = await prisma.ventaImportada.count({ where: { pac: 'PAC-GRANDE' } });

    expect(enBase).toBe(REALES);
    // La lista sigue con su tope: es defensivo y se queda.
    expect(historial.servicios.length).toBe(500);
    /* El resumen ya no lo hereda. Antes decía 500 y 50.000 a quien tenía 520 y
       52.000, y la pantalla lo pintaba como «Servicios» y «Gastado». */
    expect(historial.resumen.servicios).toBe(REALES);
    expect(historial.resumen.gastado).toBe(REALES * 100);
  });

  it('«primera visita» es la primera de verdad, no la más vieja que cupo', async () => {
    await historialDe('PAC-GRANDE', REALES);

    const historial = await servicios.historialPaciente('PAC-GRANDE');
    const [primera, ultima] = await Promise.all([
      prisma.ventaImportada.findFirst({
        where: { pac: 'PAC-GRANDE' }, orderBy: { fecha: 'asc' }, select: { fecha: true },
      }),
      prisma.ventaImportada.findFirst({
        where: { pac: 'PAC-GRANDE' }, orderBy: { fecha: 'desc' }, select: { fecha: true },
      }),
    ]);

    /* El más engañoso de los cuatro. La lista va en `fecha desc`, así que
       `servicios.at(-1)` era la 500ª MÁS RECIENTE: ese dato no quedaba
       incompleto, quedaba equivocado — y el cajón lo imprime literalmente como
       «Línea de tiempo — del X al Y». */
    /* `fecha` es nullable en el schema, así que el encadenamiento va hasta el
       final: comparar dos `undefined` haría pasar la prueba sin comparar nada. */
    expect(primera?.fecha).not.toBeNull();
    expect(historial.resumen.primeraVisita?.toISOString()).toBe(primera?.fecha?.toISOString());
    expect(historial.resumen.ultimaVisita?.toISOString()).toBe(ultima?.fecha?.toISOString());
  });

  it('cuenta médicos distintos sobre todo el historial, incluidos los que no caben', async () => {
    await historialDe('PAC-GRANDE', REALES);
    /* Un médico que solo aparece en una visita MUY vieja, fuera de las 500 más
       recientes. Sin él, contar sobre el array recortado daba siete igual —los
       otros seis se repiten en toda la serie— y la prueba no distinguía nada. */
    await prisma.ventaImportada.create({
      data: {
        periodoId, detalle: 'Primera consulta', modulo: 'CONSULTA', precio: 100,
        fecha: new Date('2019-01-05T12:00:00.000Z'), medicoPk: 'M-JUBILADO',
        medico: 'Doctor que ya no está', pac: 'PAC-GRANDE', paciente: 'Paciente de prueba',
        canal: 'PROPIO', ingresoNeto: 87, unidadNegocio: 'VARIOS', clasif: 'CONSULTA', tipo: 'A',
      },
    });

    const historial = await servicios.historialPaciente('PAC-GRANDE');

    // Siete de `historialDe` (M0..M6) más el jubilado.
    expect(historial.resumen.medicos).toBe(8);
    expect(historial.servicios.some(v => v.medicoPk === 'M-JUBILADO')).toBe(false);
  });

  it('la respuesta dice cuántas filas caben, para que la vista sepa que hay recorte', async () => {
    await historialDe('PAC-GRANDE', REALES);

    const historial = await servicios.historialPaciente('PAC-GRANDE');

    expect(historial.limiteLista).toBe(500);
    /* Con esto y `resumen.servicios` la pantalla puede decir «500 de 520» en vez
       de afirmar que son 500. Antes no había forma de saberlo desde el cliente. */
    expect(historial.resumen.servicios > historial.servicios.length).toBe(true);
  });

  it('por debajo del tope el resumen sí es correcto', async () => {
    await historialDe('PAC-NORMAL', 20);

    const historial = await servicios.historialPaciente('PAC-NORMAL');

    expect(historial.resumen.servicios).toBe(20);
    expect(historial.resumen.gastado).toBe(2_000);
  });
});

describe('F10.2 · historial desde la ficha del cliente, tope de 200', () => {
  it('totalServicios y montoTotal cuentan todo el historial, no las 200 mostradas', async () => {
    const cliente = await prisma.cliente.create({
      data: { nombre: 'Paciente de prueba', telefono: '+59170009999', pac: 'PAC-FICHA' },
    });
    await historialDe('PAC-FICHA', 220);

    const clientes = new ClientesService(prisma, new AuditService(prisma), servicios);
    const resultado = await clientes.historialServicios(cliente.id);
    const enBase = await prisma.ventaImportada.count({ where: { pac: 'PAC-FICHA' } });

    expect(enBase).toBe(220);
    // La lista mostrada conserva su tope…
    expect(resultado.servicios.length).toBe(200);
    // …pero las cifras ya no salen de ella.
    expect(resultado.totalServicios).toBe(220);
    expect(resultado.montoTotal).toBe(220 * 100);
  });
});
