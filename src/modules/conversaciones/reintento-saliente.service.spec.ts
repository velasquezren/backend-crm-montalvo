
import { proximoReintento } from './despachador-saliente.service';
import { ReintentoSalienteService } from './reintento-saliente.service';

/**
 * F06 entrega 2 — el barrido que reintenta lo que **consta** que no salió.
 *
 * Lo que se fija aquí no es que el barrido funcione: es que no reenvíe de más.
 * Un reintento indebido no da error, le llega a la paciente. Por eso las
 * pruebas se concentran en las tres puertas que lo impiden —la reclamación, la
 * ventana de 24 h y la marca `reintento`— y no en el camino feliz.
 */

const AHORA = new Date('2026-09-09T12:00:00.000Z');

/** Una fila lista para reintentar, con la forma exacta que pide el `select`. */
function fila(sobrescribir: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'msg-1',
    conversacionId: 'conv-1',
    contenido: 'hola',
    mediaKey: null,
    intentosEnvio: 0,
    conversacion: { cliente: { telefono: '+59170000001' } },
    ...sobrescribir,
  };
}

function montar(opciones: {
  pendientes?: ReturnType<typeof fila>[];
  reclamadas?: number;
  ultimoEntranteHace?: number | null;
}) {
  const { pendientes = [fila()], reclamadas = 1, ultimoEntranteHace = 60_000 } = opciones;

  const prisma = {
    mensaje: {
      findMany: jest.fn().mockResolvedValue(pendientes),
      updateMany: jest.fn().mockResolvedValue({ count: reclamadas }),
      findFirst: jest.fn().mockResolvedValue(
        ultimoEntranteHace === null
          ? null
          : { createdAt: new Date(AHORA.getTime() - ultimoEntranteHace) },
      ),
    },
    /* Lo usa `purgarInteracciones`, que el barrido llama antes de reintentar. */
    interaccionMensaje: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const despachador = { texto: jest.fn().mockResolvedValue(undefined) };
  const servicio = new ReintentoSalienteService(prisma as never, despachador as never);
  jest.spyOn(servicio['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(servicio['logger'], 'error').mockImplementation(() => undefined);

  return { servicio, prisma, despachador };
}

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(AHORA);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('proximoReintento', () => {
  it('espacia 1, 5 y 25 minutos', () => {
    expect(proximoReintento(1, AHORA)).toEqual(new Date(AHORA.getTime() + 60_000));
    expect(proximoReintento(2, AHORA)).toEqual(new Date(AHORA.getTime() + 5 * 60_000));
    expect(proximoReintento(3, AHORA)).toEqual(new Date(AHORA.getTime() + 25 * 60_000));
  });

  /* El tope no es prudencia decorativa: pasada la ventana de 24 h Meta rechaza
     el texto libre igual, así que insistir solo gasta cuota. */
  it('al cuarto intento se rinde', () => {
    expect(proximoReintento(4, AHORA)).toBeNull();
    expect(proximoReintento(9, AHORA)).toBeNull();
  });
});

describe('ReintentoSalienteService', () => {
  it('solo mira los FALLIDO con el turno vencido, y de a poco', async () => {
    const { servicio, prisma } = montar({});

    await servicio.barrerEnviosPendientes();

    const consulta = prisma.mensaje.findMany.mock.calls[0][0];
    expect(consulta.where).toMatchObject({ estadoEnvio: 'FALLIDO', permiteReintento: true, intentosEnvio: { lt: 3 }, proximoIntento: { lte: AHORA } });
    expect(consulta.take).toBe(50);
  });

  /**
   * La puerta más importante. Dos barridos solapados —un `systemctl restart` a
   * destiempo, un intervalo que se atrasa— leen la misma fila; si los dos
   * despacharan, la paciente recibiría el mensaje dos veces. El `where` de la
   * reclamación exige que el turno siga vencido: de dos, exactamente uno gana.
   */
  it('reclama la fila antes de despachar, y agenda el turno siguiente', async () => {
    const { servicio, prisma, despachador } = montar({});

    await servicio.barrerEnviosPendientes();

    const reclamo = prisma.mensaje.updateMany.mock.calls.find(c => c[0].where.id === 'msg-1')![0];
    expect(reclamo.where).toMatchObject({
      id: 'msg-1',
      estadoEnvio: 'FALLIDO',
      proximoIntento: { lte: AHORA },
    });
    expect(reclamo.data).toEqual({
      intentosEnvio: 1,
      proximoIntento: new Date(AHORA.getTime() + 5 * 60_000),
    });
    expect(despachador.texto).toHaveBeenCalledTimes(1);
  });

  it('si otro barrido se le adelantó, no despacha nada', async () => {
    const { servicio, despachador } = montar({ reclamadas: 0 });

    await servicio.barrerEnviosPendientes();

    expect(despachador.texto).not.toHaveBeenCalled();
  });

  /**
   * Fuera de la CSW Meta rechaza el texto libre pase lo que pase. Gastar los
   * intentos ahí solo llena el journal de errores que no dicen nada nuevo.
   */
  it('con la ventana de 24 h cerrada deja de reintentar en vez de insistir', async () => {
    const { servicio, prisma, despachador } = montar({ ultimoEntranteHace: 25 * 60 * 60 * 1000 });

    await servicio.barrerEnviosPendientes();

    expect(despachador.texto).not.toHaveBeenCalled();
    expect(prisma.mensaje.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'msg-1' },
      data: { proximoIntento: null },
    });
  });

  it('sin ningún mensaje entrante la ventana nunca estuvo abierta', async () => {
    const { servicio, despachador } = montar({ ultimoEntranteHace: null });

    await servicio.barrerEnviosPendientes();

    expect(despachador.texto).not.toHaveBeenCalled();
  });

  /**
   * Sin esta marca el despachador volvería a agendar desde cero en cada vuelta
   * y el backoff no crecería nunca: un mensaje muerto se reintentaría cada
   * minuto para siempre.
   */
  it('despacha marcado como reintento, con el contenido y la media guardados', async () => {
    const { servicio, despachador } = montar({ pendientes: [fila({ mediaKey: 'r2/abc.jpg', mediaMime: 'image/jpeg', mediaNombre: null })] });

    await servicio.barrerEnviosPendientes();

    expect(despachador.texto).toHaveBeenCalledWith(
      {
        mensajeId: 'msg-1',
        conversacionId: 'conv-1',
        telefono: '+59170000001',
        reintento: true,
      },
      'hola',
      { key: 'r2/abc.jpg', mime: 'image/jpeg', nombre: null },
    );
  });

  it('un mensaje que revienta no se lleva a los demás de la tanda', async () => {
    const { servicio, despachador } = montar({
      pendientes: [fila({ id: 'msg-1' }), fila({ id: 'msg-2' }), fila({ id: 'msg-3' })],
    });
    despachador.texto.mockImplementation((destino: { mensajeId: string }) =>
      destino.mensajeId === 'msg-2' ? Promise.reject(new Error('Meta caído')) : Promise.resolve(),
    );

    await expect(servicio.barrerEnviosPendientes()).resolves.toBe(2);
    expect(despachador.texto).toHaveBeenCalledTimes(3);
  });

  /**
   * El VPS tiene un núcleo y el pool de Prisma se comparte con las agentes.
   * Soltar los cincuenta de golpe no acelera el barrido: hace lento el chat que
   * alguien está abriendo. Se comprueba contando cuántos hay en vuelo a la vez.
   */
  it('no despacha más de cinco a la vez', async () => {
    const pendientes = Array.from({ length: 12 }, (_, i) => fila({ id: `msg-${i}` }));
    const { servicio, despachador } = montar({ pendientes });

    let enVuelo = 0;
    let pico = 0;
    despachador.texto.mockImplementation(async () => {
      pico = Math.max(pico, ++enVuelo);
      await Promise.resolve();
      enVuelo--;
    });

    await servicio.barrerEnviosPendientes();

    expect(despachador.texto).toHaveBeenCalledTimes(12);
    expect(pico).toBeLessThanOrEqual(5);
  });

  it('avisa cuando el tope del barrido se alcanza, que significa envíos esperando', async () => {
    const pendientes = Array.from({ length: 50 }, (_, i) => fila({ id: `msg-${i}` }));
    const { servicio } = montar({ pendientes });
    const avisos: string[] = [];
    jest
      .spyOn(servicio['logger'], 'warn')
      .mockImplementation((m: unknown) => void avisos.push(String(m)));

    await servicio.barrerEnviosPendientes();

    expect(avisos.some(a => a.includes('tope de 50'))).toBe(true);
  });

  /* El barrido no debe ser el motivo por el que el proceso sigue vivo, y en la
     suite no debe arrancar nunca. */
  it('no monta el temporizador bajo NODE_ENV=test', () => {
    const { servicio } = montar({});

    servicio.onModuleInit();

    expect(servicio['intervalo']).toBeUndefined();
  });
});

/**
 * La purga de retención no es una optimización: es el plazo con el que se
 * conservan datos de pacientes. `privado` (el payload cifrado de la
 * interacción) se borra a los 7 días y los metadatos a los 30.
 *
 * Corre sola mientras las interacciones están encendidas. El caso delicado es
 * el otro: al APAGARLAS —pausar el piloto, por ejemplo— la purga se iría con
 * ellas y lo ya guardado se quedaría pasado su plazo, en silencio.
 * `WHATSAPP_INTERACCIONES_RETENCION` existe solo para eso, y hasta el
 * 2026-10-08 ninguna prueba la encendía.
 */
describe('purga de retención con las interacciones apagadas', () => {
  const previo = {
    on: process.env['WHATSAPP_INTERACCIONES'],
    retencion: process.env['WHATSAPP_INTERACCIONES_RETENCION'],
  };

  beforeEach(() => {
    delete process.env['WHATSAPP_INTERACCIONES'];
  });

  afterEach(() => {
    for (const [nombre, valor] of [
      ['WHATSAPP_INTERACCIONES', previo.on],
      ['WHATSAPP_INTERACCIONES_RETENCION', previo.retencion],
    ] as const) {
      if (valor === undefined) delete process.env[nombre];
      else process.env[nombre] = valor;
    }
  });

  it('sin la bandera de retención, no purga', async () => {
    delete process.env['WHATSAPP_INTERACCIONES_RETENCION'];
    const { servicio, prisma } = montar({});

    await servicio.barrerEnviosPendientes();

    expect(prisma.interaccionMensaje.updateMany).not.toHaveBeenCalled();
    expect(prisma.interaccionMensaje.deleteMany).not.toHaveBeenCalled();
  });

  it('con `WHATSAPP_INTERACCIONES_RETENCION=on`, sigue purgando', async () => {
    process.env['WHATSAPP_INTERACCIONES_RETENCION'] = 'on';
    const { servicio, prisma } = montar({});

    await servicio.barrerEnviosPendientes();

    /* Dos `updateMany` (borrar `privado`, poner la lápida RETENIDA) y un
       `deleteMany` (los metadatos de las entrantes). */
    expect(prisma.interaccionMensaje.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.interaccionMensaje.deleteMany).toHaveBeenCalledTimes(1);
  });
});
