import { Logger } from '@nestjs/common';

import { ActividadesService } from '../../modules/actividades/actividades.service';
import { DespachadorSalienteService } from '../../modules/conversaciones/despachador-saliente.service';
import { TipoCambioService } from '../../modules/tipo-cambio/tipo-cambio.service';

import { enSegundoPlano } from './en-segundo-plano';

/**
 * F06, entrega 1 — que una promesa disparada FUERA de una petición HTTP no
 * pueda tumbar el proceso.
 *
 * Node aborta ante una promesa rechazada sin manejar. Dentro de una petición
 * eso no pasa: el filtro global de excepciones la convierte en un 500. Pero
 * este backend dispara trabajo con `void` a propósito en doce sitios, y ahí no
 * hay nadie escuchando.
 *
 * **Cómo se comprueba que un rechazo no escapa.** No hay una aserción explícita
 * para eso y no es un olvido: Jest ejecuta el código bajo prueba dentro de un
 * contexto `vm`, así que un `process.on('unhandledRejection')` montado desde el
 * propio test no llega a ver nada —se intentó y devolvía la lista vacía
 * mientras Jest sí reportaba el rechazo—. Quien detecta es Jest, que falla la
 * suite entera cuando una promesa rechaza sin manejar durante el archivo. Es
 * decir: **si alguien quita un `enSegundoPlano` de los sitios de abajo, estos
 * tests fallan aunque sus `expect` sigan pasando.** Se verificó a propósito
 * antes del arreglo: los tres reventaban con "Timed out fetching a new
 * connection from the connection pool".
 *
 * El fallo que se inyecta es siempre el mismo porque es el realista: Prisma
 * rechazando porque la base no responde. No hace falta que PostgreSQL caiga
 * entero —basta el `max_connections` agotado, o el reinicio de la base durante
 * un despliegue— y en ese momento todos estos caminos rechazan a la vez.
 *
 * Los webhooks de Meta y WhatsApp también se disparan con `void`, pero cada
 * elemento de su lote ya va en su propio try/catch: se envuelven igual por
 * consistencia y porque `verificar-skills.mjs` ahora lo exige, no porque se
 * reprodujera un escape. Está documentado en `docs/auditoria-f06.md`.
 */

/** El fallo realista: la base dejó de responder. */
const BASE_CAIDA = new Error('Timed out fetching a new connection from the connection pool');

/**
 * `onModuleInit` de ambos servicios sale por la puerta de atrás cuando
 * `NODE_ENV === 'test'`, que es justo el camino que hay que ejercitar.
 */
async function comoEnProduccion<T>(fn: () => Promise<T>): Promise<T> {
  const previo = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    return await fn();
  } finally {
    process.env.NODE_ENV = previo;
  }
}

let errores: Array<{ mensaje: string; causa: unknown }>;

beforeEach(() => {
  errores = [];
  jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation((mensaje: unknown, causa?: unknown) => {
      errores.push({ mensaje: String(mensaje), causa });
    });
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('enSegundoPlano', () => {
  it('se traga el rechazo y lo deja en el log con su contexto', async () => {
    await enSegundoPlano('barrido de prueba', new Logger('T'), () => Promise.reject(BASE_CAIDA));

    expect(errores).toHaveLength(1);
    expect(errores[0].mensaje).toContain('barrido de prueba');
    expect(errores[0].causa).toBe(BASE_CAIDA);
  });

  it('también atrapa lo que lance antes de existir la promesa', async () => {
    await enSegundoPlano('trabajo que revienta al construirse', new Logger('T'), () => {
      throw BASE_CAIDA;
    });

    expect(errores).toHaveLength(1);
  });

  it('no ensucia el log cuando el trabajo sale bien', async () => {
    await enSegundoPlano('trabajo sano', new Logger('T'), () => Promise.resolve('ok'));

    expect(errores).toEqual([]);
  });
});

describe('ActividadesService — el barrido de recordatorios', () => {
  /**
   * El `findMany` que abre el barrido está fuera de todo try/catch. El
   * try/catch por elemento de `notificarRecordatorio` protege lo de dentro del
   * bucle, pero nunca se llega a él: si la consulta inicial rechaza, la promesa
   * que el `setInterval` dispara queda sin manejar. Corre cada cinco minutos,
   * para siempre, mientras el CRM esté levantado.
   */
  it('no deja escapar el rechazo de su consulta inicial', async () => {
    const prisma = {
      actividad: { findMany: jest.fn().mockRejectedValue(BASE_CAIDA), update: jest.fn() },
    };
    const service = new ActividadesService(
      prisma as never,
      {} as never,
      { enviarAUsuario: jest.fn() } as never,
      { emitirRecordatorioActividad: jest.fn() } as never,
    );

    jest.useFakeTimers();
    try {
      await comoEnProduccion(async () => {
        service.onModuleInit();
        jest.advanceTimersByTime(5 * 60 * 1000);
        jest.useRealTimers();
        /* Deja correr las microtareas del barrido ya disparado. */
        await new Promise(resolver => setImmediate(resolver));
      });

      expect(prisma.actividad.findMany).toHaveBeenCalled();
      expect(errores.map(e => e.mensaje).join(' ')).toContain('recordatorios');
    } finally {
      jest.useRealTimers();
      service.onModuleDestroy();
    }
  });
});

describe('TipoCambioService — la sincronización automática', () => {
  /**
   * Este no lo citaba la auditoría y está peor que el anterior: el try/catch
   * que rodea el `fetch` al espejo del BCB **termina antes** de las dos
   * consultas a la base, así que un `findUnique` que rechace escapa igual. Y
   * aquí hay dos disparos, uno al arrancar el módulo y otro cada seis horas.
   *
   * El del arranque es el que muerde: un PostgreSQL que todavía no acepta
   * conexiones cuando systemd levanta el backend tumbaba el proceso, systemd lo
   * reiniciaba por `Restart=always`, y vuelta a empezar.
   */
  it('no deja escapar el rechazo de la base tras un fetch exitoso', async () => {
    const fetchOriginal = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tc_oficial: { valor: 11.92, fecha: '2026-09-07' } }),
    }) as never;

    const prisma = {
      tipoCambioDiario: {
        findUnique: jest.fn().mockRejectedValue(BASE_CAIDA),
        upsert: jest.fn(),
      },
    };
    const service = new TipoCambioService(prisma as never, { registrar: jest.fn() } as never);

    try {
      await comoEnProduccion(async () => {
        service.onModuleInit();
        await new Promise(resolver => setImmediate(resolver));
      });

      expect(prisma.tipoCambioDiario.findUnique).toHaveBeenCalled();
      expect(errores.map(e => e.mensaje).join(' ')).toContain('tipo de cambio');
    } finally {
      service.onModuleDestroy();
      global.fetch = fetchOriginal;
    }
  });
});

describe('DespachadorSalienteService — anotar lo que contestó Meta', () => {
  /**
   * La cabecera de la clase promete que "ninguno lanza". No se cumplía de punta
   * a punta, que es lo que la auditoría señalaba: `registrarResultadoEnvio`
   * cambió `update` por `updateMany` para tolerar que la fila ya no exista —y
   * eso resuelve el caso de la conversación borrada—, pero `updateMany` rechaza
   * igual si la base no responde, y sus dos llamadores lo disparaban con `void`.
   *
   * El arreglo va en el llamador, no aquí: quien despacha desde el acuse
   * automático sí espera el resultado dentro de su propio try/catch, y tragarse
   * el fallo dentro del despachador le quitaría esa información.
   */
  function montarDespachador(): DespachadorSalienteService {
    const prisma = { mensaje: { updateMany: jest.fn().mockRejectedValue(BASE_CAIDA) } };
    return new DespachadorSalienteService(
      prisma as never,
      { emitirActividad: jest.fn() } as never,
      { urlFirmada: jest.fn().mockResolvedValue('https://r2.example/firmada') } as never,
      { enviar: jest.fn().mockResolvedValue('wamid.MOCK') } as never,
    );
  }

  const destino = { mensajeId: 'msg-1', conversacionId: 'conv-1', telefono: '+59170000001' };

  it('texto() propaga el fallo a quien lo espere', async () => {
    await expect(montarDespachador().texto(destino, 'hola')).rejects.toThrow(BASE_CAIDA);
  });

  it('envuelto en enSegundoPlano, ese mismo fallo no escapa', async () => {
    const despachador = montarDespachador();

    await enSegundoPlano('envío a Meta de prueba', new Logger('T'), () =>
      despachador.texto(destino, 'hola'),
    );

    expect(errores).toHaveLength(1);
    expect(errores[0].causa).toBe(BASE_CAIDA);
  });
});
