import { PrismaService } from '../../prisma/prisma.service';

/**
 * Idempotencia del envío, contra PostgreSQL de verdad.
 *
 * La propiedad que se prueba aquí no se puede probar con un mock: depende del
 * índice único de PostgreSQL resolviendo dos INSERT simultáneos. Un doble
 * mockeado siempre "gana" la carrera que uno le programe.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';
if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService(URL_TEST);

const SUFIJO = `idem-${Date.now()}`;
let lineaId: string;
let clienteId: string;
let conversacionId: string;

beforeAll(async () => {
  await prisma.$connect();
  const linea = await prisma.lineaWhatsapp.create({
    data: { nombre: `Linea ${SUFIJO}`, tokenEnv: `TOK_${SUFIJO}`, telefono: `+5917${Date.now() % 10000000}`, activa: true, comercial: true },
  });
  lineaId = linea.id;
  const cliente = await prisma.cliente.create({
    data: { nombre: `Paciente ${SUFIJO}`, telefono: `+5916${Date.now() % 10000000}` },
  });
  clienteId = cliente.id;
  const conversacion = await prisma.conversacion.create({ data: { clienteId, lineaId } });
  conversacionId = conversacion.id;
});

afterAll(async () => {
  await prisma.mensaje.deleteMany({ where: { conversacionId } });
  await prisma.conversacion.deleteMany({ where: { id: conversacionId } });
  await prisma.cliente.deleteMany({ where: { id: clienteId } });
  await prisma.lineaWhatsapp.deleteMany({ where: { id: lineaId } });
  await prisma.$disconnect();
});

function crear(clientMessageId: string | null, contenido = 'Hola') {
  return prisma.mensaje.create({
    data: { conversacionId, direccion: 'SALIENTE', contenido, estadoEnvio: 'ENVIADO', clientMessageId },
  });
}

describe('idempotencia del envío · PostgreSQL real', () => {
  it('el índice único existe en la base, no solo en el schema', async () => {
    const filas = await prisma.$queryRawUnsafe<{ indexdef: string }[]>(
      `select indexdef from pg_indexes where tablename = 'Mensaje' and indexname = 'Mensaje_clientMessageId_key'`,
    );
    expect(filas).toHaveLength(1);
    expect(filas[0].indexdef).toContain('UNIQUE');
  });

  it('1 · un envío normal crea una fila', async () => {
    const id = `${SUFIJO}-normal`;
    const m = await crear(id);
    expect(m.clientMessageId).toBe(id);
    expect(await prisma.mensaje.count({ where: { clientMessageId: id } })).toBe(1);
  });

  it('2 · el mismo clientMessageId repetido NO crea una segunda fila', async () => {
    const id = `${SUFIJO}-repetido`;
    await crear(id);
    await expect(crear(id)).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.mensaje.count({ where: { clientMessageId: id } })).toBe(1);
  });

  it('3 · dos peticiones CONCURRENTES con el mismo id dejan una sola fila', async () => {
    const id = `${SUFIJO}-carrera`;
    /* Sin await entre medias: las dos salen a la vez y compiten de verdad
       por el índice. Es la prueba que un mock no puede dar. */
    const resultados = await Promise.allSettled([crear(id, 'A'), crear(id, 'B')]);

    const ok = resultados.filter(r => r.status === 'fulfilled');
    const fallidos = resultados.filter(r => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(fallidos).toHaveLength(1);
    expect((fallidos[0] as PromiseRejectedResult).reason.code).toBe('P2002');
    expect(await prisma.mensaje.count({ where: { clientMessageId: id } })).toBe(1);
  });

  it('4 · diez peticiones concurrentes siguen dejando una sola fila', async () => {
    const id = `${SUFIJO}-diez`;
    const resultados = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => crear(id, `intento ${i}`)),
    );
    expect(resultados.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.mensaje.count({ where: { clientMessageId: id } })).toBe(1);
  });

  it('5 · dos clientMessageId distintos son dos mensajes', async () => {
    const a = `${SUFIJO}-hola`;
    const b = `${SUFIJO}-horario`;
    await Promise.all([crear(a, 'Hola'), crear(b, '¿Tiene horario?')]);
    expect(await prisma.mensaje.count({ where: { clientMessageId: { in: [a, b] } } })).toBe(2);
  });

  it('6 · los históricos con NULL conviven: el índice único los ignora', async () => {
    const antes = await prisma.mensaje.count({ where: { conversacionId, clientMessageId: null } });
    await Promise.all([crear(null, 'viejo 1'), crear(null, 'viejo 2'), crear(null, 'viejo 3')]);
    const despues = await prisma.mensaje.count({ where: { conversacionId, clientMessageId: null } });
    expect(despues - antes).toBe(3);
  });

  it('7 · la fila recuperada tras el choque es la MISMA que se creó', async () => {
    const id = `${SUFIJO}-recuperar`;
    const creada = await crear(id, 'original');
    await expect(crear(id, 'duplicado')).rejects.toMatchObject({ code: 'P2002' });
    {
      const recuperada = await prisma.mensaje.findUnique({ where: { clientMessageId: id } });
      expect(recuperada?.id).toBe(creada.id);
      /* Y conserva el contenido del PRIMERO, no el del reintento. */
      expect(recuperada?.contenido).toBe('original');
    }
  });

  it('8 · el retry sobre una fila sin whatsappMsgId devuelve la misma fila', async () => {
    const id = `${SUFIJO}-sin-wamid`;
    const creada = await crear(id, 'en vuelo a Meta');
    expect(creada.whatsappMsgId).toBeNull();

    /* Meta sigue en segundo plano; el retry no puede leerlo como "no enviado". */
    await expect(crear(id, 'en vuelo a Meta')).rejects.toMatchObject({ code: 'P2002' });
    const recuperada = await prisma.mensaje.findUnique({ where: { clientMessageId: id } });
    expect(recuperada?.id).toBe(creada.id);
    expect(recuperada?.whatsappMsgId).toBeNull();
    expect(recuperada?.estadoEnvio).toBe('ENVIADO');
  });
});
