import { PrismaService } from '../../prisma/prisma.service';

import { ReintentoSalienteService } from './reintento-saliente.service';

/**
 * F06 entrega 2 — el barrido de reintentos contra PostgreSQL de verdad.
 *
 * Las pruebas unitarias del barrido comprueban las decisiones; **la garantía
 * central no se puede probar ahí**. "De dos barridos que leen la misma fila,
 * exactamente uno despacha" no es una decisión del código: es una propiedad del
 * `UPDATE ... WHERE` de PostgreSQL bajo concurrencia. Con un prisma simulado
 * que devuelve `{ count: 1 }` siempre, la prueba pasa aunque el `where` esté mal
 * escrito — y lo que hay al otro lado de ese fallo es una paciente recibiendo el
 * mismo mensaje dos veces.
 *
 * Se ejecutan con `npm run test:integracion`; `npm test` las salta a propósito.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';

/* Mismo cerrojo que el resto de la integración: esta suite borra tablas. */
if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService(URL_TEST);

/** Anota a quién se despachó, sin hablar con Meta. */
class DespachadorEspia {
  readonly despachados: string[] = [];
  async texto(destino: { mensajeId: string }): Promise<void> {
    this.despachados.push(destino.mensajeId);
  }
}

let despachador: DespachadorEspia;
let servicio: ReintentoSalienteService;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.mensaje.deleteMany();
  await prisma.conversacion.deleteMany();
  await prisma.cliente.deleteMany();

  despachador = new DespachadorEspia();
  servicio = new ReintentoSalienteService(prisma, despachador as never);
  jest.spyOn(servicio['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(servicio['logger'], 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

/**
 * Una conversación con la ventana de 24 h abierta —hay un ENTRANTE reciente— y
 * un saliente FALLIDO con el turno ya vencido.
 */
async function conversacionConEnvioFallido(opciones: { entranteHaceMs?: number } = {}) {
  const { entranteHaceMs = 60_000 } = opciones;
  const ahora = Date.now();

  const cliente = await prisma.cliente.create({
    data: { nombre: 'Paciente de prueba', telefono: `+5917${Math.random().toString().slice(2, 9)}` },
  });
  const conversacion = await prisma.conversacion.create({ data: { clienteId: cliente.id } });

  await prisma.mensaje.create({
    data: {
      conversacionId: conversacion.id,
      direccion: 'ENTRANTE',
      contenido: 'hola',
      createdAt: new Date(ahora - entranteHaceMs),
    },
  });

  const fallido = await prisma.mensaje.create({
    data: {
      conversacionId: conversacion.id,
      direccion: 'SALIENTE',
      contenido: 'respuesta que no salió',
      estadoEnvio: 'FALLIDO',
      proximoIntento: new Date(ahora - 1000),
    },
  });

  return { cliente, conversacion, fallido };
}

describe('ReintentoSalienteService contra PostgreSQL', () => {
  it('reintenta un FALLIDO con el turno vencido y agenda el siguiente', async () => {
    const { fallido } = await conversacionConEnvioFallido();

    await servicio.barrerEnviosPendientes();

    expect(despachador.despachados).toEqual([fallido.id]);
    const despues = await prisma.mensaje.findUniqueOrThrow({ where: { id: fallido.id } });
    expect(despues.intentosEnvio).toBe(1);
    expect(despues.proximoIntento).not.toBeNull();
    /* El siguiente turno es más tarde que el que acaba de vencer: el backoff
       crece en vez de reintentar en bucle cada minuto. */
    expect(despues.proximoIntento!.getTime()).toBeGreaterThan(Date.now());
  });

  /**
   * **La prueba que justifica esta suite.** Dos barridos solapados —un
   * `systemctl restart` a destiempo, un intervalo que se atrasa— leen la misma
   * fila. Si los dos despacharan, la paciente recibiría el mensaje dos veces.
   * Quien lo impide es el `where` de la reclamación, y eso solo lo decide
   * PostgreSQL.
   *
   * Se ataca `reclamar` directamente y no dos `barrerEnviosPendientes()`
   * completos **porque eso no probaba nada**: los dos barridos se serializan, el
   * segundo ya no ve la fila que el primero acaba de reagendar, y el test pasaba
   * en verde con la condición del `where` borrada a propósito. Comprobado antes
   * de escribir esta versión.
   */
  it('dos reclamaciones simultáneas: exactamente una se queda con la fila', async () => {
    const { fallido } = await conversacionConEnvioFallido();
    const ahora = new Date();

    const ganadas = await Promise.all([
      servicio.reclamar(fallido.id, 1, ahora),
      servicio.reclamar(fallido.id, 1, ahora),
    ]);

    expect(ganadas.filter(Boolean)).toHaveLength(1);
    const despues = await prisma.mensaje.findUniqueOrThrow({ where: { id: fallido.id } });
    expect(despues.intentosEnvio).toBe(1);
  });

  it('reclamar no se queda con una fila que ya no está FALLIDO', async () => {
    const { fallido } = await conversacionConEnvioFallido();
    await prisma.mensaje.update({ where: { id: fallido.id }, data: { estadoEnvio: 'INCIERTO' } });

    await expect(servicio.reclamar(fallido.id, 1, new Date())).resolves.toBe(false);
  });

  it('no toca un INCIERTO: pudo haber llegado y reenviarlo lo duplicaría', async () => {
    const { fallido } = await conversacionConEnvioFallido();
    await prisma.mensaje.update({
      where: { id: fallido.id },
      /* Tal como lo deja el despachador ante un resultado desconocido. */
      data: { estadoEnvio: 'INCIERTO', proximoIntento: null },
    });

    await servicio.barrerEnviosPendientes();

    expect(despachador.despachados).toEqual([]);
  });

  it('no toca un FALLIDO cuyo turno todavía no vence', async () => {
    const { fallido } = await conversacionConEnvioFallido();
    await prisma.mensaje.update({
      where: { id: fallido.id },
      data: { proximoIntento: new Date(Date.now() + 60_000) },
    });

    await servicio.barrerEnviosPendientes();

    expect(despachador.despachados).toEqual([]);
  });

  /**
   * Fuera de la ventana de servicio al cliente, Meta rechaza el texto libre
   * pase lo que pase. Se deja de intentar en vez de gastar cuota y llenar el
   * journal — y `proximoIntento` queda en null para que la fila no vuelva a
   * aparecer en el barrido.
   */
  it('con la ventana de 24 h cerrada deja de reintentar', async () => {
    const { fallido } = await conversacionConEnvioFallido({
      entranteHaceMs: 25 * 60 * 60 * 1000,
    });

    await servicio.barrerEnviosPendientes();

    expect(despachador.despachados).toEqual([]);
    const despues = await prisma.mensaje.findUniqueOrThrow({ where: { id: fallido.id } });
    expect(despues.proximoIntento).toBeNull();
    expect(despues.estadoEnvio).toBe('FALLIDO');
  });

  /**
   * El backoff termina. Al cuarto intento `proximoReintento` devuelve null y la
   * fila deja de aparecer: sin esto, un mensaje que Meta rechaza siempre se
   * reintentaría para siempre.
   */
  it('se rinde tras el tercer intento y la fila sale del barrido', async () => {
    const { fallido } = await conversacionConEnvioFallido();
    await prisma.mensaje.update({ where: { id: fallido.id }, data: { intentosEnvio: 3 } });

    await servicio.barrerEnviosPendientes();

    const despues = await prisma.mensaje.findUniqueOrThrow({ where: { id: fallido.id } });
    expect(despues.intentosEnvio).toBe(4);
    expect(despues.proximoIntento).toBeNull();

    /* Y en la vuelta siguiente ya no la ve. */
    despachador.despachados.length = 0;
    await servicio.barrerEnviosPendientes();
    expect(despachador.despachados).toEqual([]);
  });

  it('el índice de proximoIntento existe: sin él el barrido recorre la tabla entera', async () => {
    const indices = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'Mensaje'`,
    );

    expect(indices.map(i => i.indexname)).toContain('Mensaje_proximoIntento_idx');
  });
});
