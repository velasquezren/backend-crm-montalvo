import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { ServiciosService } from '../servicios/servicios.service';
import { ActividadesService } from './actividades.service';

/**
 * A5.1 · las ocurrencias de una repetición comparten identidad de serie.
 *
 * Esto es SOLO identidad: agrupa, y nada más. Las operaciones sobre «esta y
 * las siguientes» son A5.2, y a propósito no existen todavía — quien lea esta
 * suite no debe creer que ya se puede editar una serie entera.
 *
 * Contra PostgreSQL real porque lo que se prueba es que las filas quedan
 * escritas juntas, en una transacción, y que las columnas e índices existen de
 * verdad en la base.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';

if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService(URL_TEST);
let service: ActividadesService;
let agenteId: string;
let clienteId: string;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.actividad.deleteMany();
  await prisma.cliente.deleteMany();
  await prisma.usuario.deleteMany();

  const servicios = new ServiciosService(prisma);
  const clientes = new ClientesService(prisma, new AuditService(prisma), servicios);
  service = new ActividadesService(
    prisma,
    clientes,
    { enviarAUsuario: jest.fn() } as never,
    { emitirRecordatorioActividad: jest.fn() } as never,
  );

  const usuario = await prisma.usuario.create({
    data: { nombre: 'Agente A5', email: 'a51@test.local', passwordHash: 'x', rol: 'AGENTE' },
  });
  agenteId = usuario.id;
  const cliente = await prisma.cliente.create({
    data: { nombre: 'Ana', telefono: '+59170000051', agenteId },
  });
  clienteId = cliente.id;
});

const INICIO = new Date('2026-10-05T13:00:00.000Z');

async function crear(repetir?: { frecuencia: 'SEMANAL' | 'QUINCENAL' | 'MENSUAL'; veces: number }) {
  return service.create(
    { tipo: 'TAREA', titulo: 'Seguimiento', fechaProgramada: INICIO, clienteId, repetir } as never,
    { sub: agenteId, rol: 'AGENTE' } as never,
  );
}

describe('A5.1 · identidad de serie al crear', () => {
  it.each([2, 12])('una repetición de %i deja a todas con el mismo serieId', async veces => {
    await crear({ frecuencia: 'SEMANAL', veces });

    const todas = await prisma.actividad.findMany({ orderBy: { fechaProgramada: 'asc' } });
    expect(todas).toHaveLength(veces);

    // Una sola identidad para toda el alta.
    const series = new Set(todas.map(a => a.serieId));
    expect(series.size).toBe(1);
    expect([...series][0]).not.toBeNull();
  });

  it('todas comparten también la frecuencia con la que nacieron', async () => {
    await crear({ frecuencia: 'QUINCENAL', veces: 4 });

    const todas = await prisma.actividad.findMany();
    expect(new Set(todas.map(a => a.frecuenciaSerie))).toEqual(new Set(['QUINCENAL']));
  });

  it('dos altas repetidas distintas no se mezclan', async () => {
    await crear({ frecuencia: 'SEMANAL', veces: 3 });
    await crear({ frecuencia: 'SEMANAL', veces: 3 });

    const series = new Set((await prisma.actividad.findMany()).map(a => a.serieId));
    /* Mismo cliente, mismo título, misma frecuencia y mismas fechas: lo único
       que las distingue es haber sido creadas en altas distintas. Sin esto,
       «esta y las siguientes» tocaría las de la otra. */
    expect(series.size).toBe(2);
  });

  it('una actividad sin repetición no pertenece a ninguna serie', async () => {
    await crear();

    const sola = await prisma.actividad.findFirstOrThrow();
    /* `null` y no una serie de uno: donde no hay hermanas no debe ofrecerse
       propagar nada. */
    expect(sola.serieId).toBeNull();
    expect(sola.frecuenciaSerie).toBeNull();
  });

  /*
   * NO hay aquí una prueba de rollback, y conviene decir por qué.
   *
   * La transacción que envuelve el alta repetida es anterior a A5.1 y no se
   * tocó: lo único que se añadió a `data` son dos campos. Forzar un fallo en la
   * SEGUNDA escritura exigiría interceptar el cliente `tx` de dentro de la
   * transacción —espiar `prisma.actividad` no sirve, es otra instancia—, y eso
   * pide un doble con `any` que el proyecto rechaza.
   *
   * Lo que A5.1 sí puede romper es que cada ocurrencia reciba un `serieId`
   * distinto, y de eso se ocupan las dos pruebas de arriba. El todo-o-nada
   * queda cubierto por `actividades.integracion.spec.ts`, que comprueba que un
   * alta repetida deja exactamente las N filas esperadas.
   */

});

describe('A5.1 · el esquema físico de la base', () => {
  it('las dos columnas existen, son nullable y tienen el tipo esperado', async () => {
    const columnas = await prisma.$queryRaw<Array<{ column_name: string; is_nullable: string; udt_name: string }>>`
      SELECT column_name, is_nullable, udt_name
      FROM information_schema.columns
      WHERE table_name = 'Actividad' AND column_name IN ('serieId', 'frecuenciaSerie')
      ORDER BY column_name
    `;

    expect(columnas).toEqual([
      { column_name: 'frecuenciaSerie', is_nullable: 'YES', udt_name: 'FrecuenciaRepeticion' },
      { column_name: 'serieId', is_nullable: 'YES', udt_name: 'text' },
    ]);
  });

  it('el enum tiene exactamente los tres valores', async () => {
    const valores = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
      SELECT e.enumlabel
      FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'FrecuenciaRepeticion'
      ORDER BY e.enumsortorder
    `;

    expect(valores.map(v => v.enumlabel)).toEqual(['SEMANAL', 'QUINCENAL', 'MENSUAL']);
  });

  it('existe el índice compuesto que usará «esta y las siguientes»', async () => {
    const indices = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'Actividad' AND indexname = 'Actividad_serieId_fechaProgramada_idx'
    `;

    expect(indices).toHaveLength(1);
    expect(indices[0].indexdef).toContain('"serieId"');
    expect(indices[0].indexdef).toContain('"fechaProgramada"');
  });

  it('la migración es aditiva: lo que ya existía sigue intacto', async () => {
    /* Una actividad escrita sin saber de series —como todas las de producción
       antes de esta migración— se lee sin problema y queda fuera de cualquier
       serie. */
    const anterior = await prisma.actividad.create({
      data: { tipo: 'TAREA', titulo: 'De antes', fechaProgramada: INICIO, clienteId, agenteId },
    });

    expect(anterior.serieId).toBeNull();
    expect(anterior.frecuenciaSerie).toBeNull();
    expect(await prisma.actividad.count({ where: { serieId: null } })).toBe(1);
  });
});
