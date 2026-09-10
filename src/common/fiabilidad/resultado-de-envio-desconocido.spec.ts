import { ConfigService } from '@nestjs/config';

import { DespachadorSalienteService } from '../../modules/conversaciones/despachador-saliente.service';
import { WhatsappCloudService } from '../whatsapp/whatsapp-cloud.service';

/**
 * F06, entrega 2 — que el CRM no afirme "no salió" cuando lo que pasa es que
 * **no lo sabe**.
 *
 * La entrega 1 dejó escrito su propio límite: «un mensaje que no salió queda en
 * FALLIDO y una agente lo reintenta a mano». Eso es cierto y aceptable mientras
 * FALLIDO signifique de verdad "no salió". El problema es que hoy no lo
 * significa siempre.
 *
 * `WhatsappCloudService.enviar()` devuelve `null` en tres situaciones que no se
 * parecen en nada:
 *
 * | situación | ¿llegó a la paciente? |
 * | --- | --- |
 * | sin credenciales | no, seguro |
 * | Meta respondió 4xx | no, seguro |
 * | **excepción de red / socket colgado** | **no se sabe** |
 *
 * El despachador colapsa las tres en `estadoEnvio: 'FALLIDO'`. Si la tercera
 * ocurrió después de que el POST llegara a Meta, el mensaje SÍ está en el
 * WhatsApp de la paciente y el CRM dice lo contrario; la agente lo reintenta a
 * mano —que es exactamente lo que la entrega 1 le pide que haga— y la paciente
 * lo recibe dos veces. Es el mismo modo de fallo que ya documenta `enviarMensaje`
 * («la agente veía un 500 sobre un mensaje que ya aparecía en el hilo, y al
 * reintentar lo duplicaba»), por otra puerta.
 *
 * Y el socket colgado no es hipotético: **ninguna llamada a Meta tiene
 * timeout**. Sin `AbortSignal`, un `fetch` que nunca resuelve deja el despacho
 * esperando para siempre, en un proceso de un solo núcleo.
 *
 * Lo que se prueba aquí, en orden: que los tres desenlaces se distinguen, que
 * el despachador escribe INCIERTO —no FALLIDO— cuando no sabe, y que hay un
 * corte por tiempo.
 *
 * Escrito y ejecutado **antes** de tocar el código, igual que
 * `rechazos-fuera-de-peticion.spec.ts`: los cinco fallaban.
 */

const CREDENCIALES = { WHATSAPP_TOKEN: 'tok', WHATSAPP_PHONE_ID: '123' };
const TELEFONO = '+591 7 000 0001';
const TEXTO = { type: 'text' as const, text: { body: 'hola' } };
const DESTINO = { mensajeId: 'msg-1', conversacionId: 'conv-1', telefono: TELEFONO };

function servicio(config: Record<string, string> = CREDENCIALES): WhatsappCloudService {
  const s = new WhatsappCloudService({ get: (clave: string) => config[clave] } as ConfigService);
  jest.spyOn(s['logger'], 'error').mockImplementation(() => undefined);
  jest.spyOn(s['logger'], 'warn').mockImplementation(() => undefined);
  return s;
}

/** Deja `fetch` haciendo lo que se le diga y devuelve el espía para inspeccionarlo. */
function conFetch(implementacion: () => unknown): jest.Mock {
  const espia = jest.fn().mockImplementation(implementacion);
  global.fetch = espia as unknown as typeof fetch;
  return espia;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('WhatsappCloudService — los tres desenlaces de un envío', () => {
  it('Meta responde 4xx: consta que NO salió', async () => {
    conFetch(() => Promise.resolve({ ok: false, status: 400, text: async () => 'malformado' }));

    expect(await servicio().enviar(TELEFONO, TEXTO)).toEqual({
      estado: 'NO_SALIO',
      motivo: expect.stringContaining('400'),
    });
  });

  it('sin credenciales: consta que NO salió, y no se llama a nadie', async () => {
    const espia = conFetch(() => Promise.resolve(null));

    expect(await servicio({}).enviar(TELEFONO, TEXTO)).toEqual({
      estado: 'NO_SALIO',
      motivo: expect.any(String),
    });
    expect(espia).not.toHaveBeenCalled();
  });

  /**
   * El corazón de la entrega. La red se cae DESPUÉS de que el POST viajó: el
   * mensaje pudo entregarse perfectamente. Decir FALLIDO aquí es una afirmación
   * que el CRM no puede sostener.
   */
  it('la red revienta: el resultado es INCIERTO, no FALLIDO', async () => {
    conFetch(() => Promise.reject(new Error('ECONNRESET')));

    expect(await servicio().enviar(TELEFONO, TEXTO)).toEqual({
      estado: 'INCIERTO',
      motivo: expect.any(String),
    });
  });

  /**
   * Un 200 sin id es peor que un error: Meta ACEPTÓ el mensaje —lo dice el
   * propio 200— pero no queda con qué correlacionar el `statuses` de vuelta.
   * Es incierto, y es justo el caso que `biz_opaque_callback_data` rescata.
   */
  it('Meta acepta pero no devuelve id: INCIERTO', async () => {
    conFetch(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }));

    expect((await servicio().enviar(TELEFONO, TEXTO)).estado).toBe('INCIERTO');
  });

  it('todo bien: ENVIADO con el id de Meta', async () => {
    conFetch(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.ok' }] }) }),
    );

    expect(await servicio().enviar(TELEFONO, TEXTO)).toEqual({
      estado: 'ENVIADO',
      metaMsgId: 'wamid.ok',
    });
  });
});

describe('WhatsappCloudService — corte por tiempo', () => {
  /**
   * **Por qué no hay una prueba de reloj.** El corte son diez segundos, así que
   * esperarlo de verdad haría la suite diez segundos más lenta, y los temporizadores
   * falsos de Jest no sirven: `AbortSignal.timeout` no usa el `setTimeout` global
   * que Jest sustituye, sino un temporizador interno de Node. Se prueban entonces
   * las dos mitades que sí son observables —que la petición viaja con señal, y que
   * el aborto se traduce a INCIERTO con un motivo que se entiende en el journal—
   * en vez de una prueba lenta o una que quede verde por el motivo equivocado.
   */
  it('la petición viaja con AbortSignal: sin eso no hay corte posible', async () => {
    const espia = conFetch(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'x' }] }) }),
    );

    await servicio().enviar(TELEFONO, TEXTO);

    expect(espia.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('el corte por tiempo es INCIERTO, y el motivo lo dice sin ambigüedad', async () => {
    /* Lo que lanza `AbortSignal.timeout` al vencer. Sin tratarlo aparte sale al
       journal como "The operation was aborted", indistinguible de cualquier otra
       cancelación justo cuando importa saber que Meta no contestó. */
    const porTiempo = new Error('The operation was aborted due to timeout');
    porTiempo.name = 'TimeoutError';
    conFetch(() => Promise.reject(porTiempo));

    const resultado = await servicio().enviar(TELEFONO, TEXTO);

    expect(resultado.estado).toBe('INCIERTO');
    expect(resultado).toHaveProperty('motivo', expect.stringContaining('no respondió'));
  });
});

describe('WhatsappCloudService — correlación de vuelta', () => {
  /**
   * `biz_opaque_callback_data` es el único hilo que sobrevive a no recibir la
   * respuesta HTTP: Meta lo devuelve en el webhook de `statuses` («only included
   * if the business set a biz_opaque_callback_data value when sending the
   * message», *Status messages webhook reference*). Se manda el id de NUESTRA
   * fila, así que un incierto se resuelve solo en cuanto llega el status.
   *
   * Atado a la versión de la API: la documentación advierte que se omite entero
   * en v24. Este repo va en v25.0; bajar de versión rompe la correlación en
   * silencio.
   */
  it('manda el id de la fila como biz_opaque_callback_data', async () => {
    const espia = conFetch(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'x' }] }) }),
    );

    await servicio().enviar(TELEFONO, TEXTO, 'msg-1');

    expect(JSON.parse(espia.mock.calls[0][1].body).biz_opaque_callback_data).toBe('msg-1');
  });

  it('sin referencia no se manda el campo, que Meta no tiene por qué recibir vacío', async () => {
    const espia = conFetch(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'x' }] }) }),
    );

    await servicio().enviar(TELEFONO, TEXTO);

    expect(JSON.parse(espia.mock.calls[0][1].body)).not.toHaveProperty('biz_opaque_callback_data');
  });
});

describe('DespachadorSalienteService — qué se anota en la fila', () => {
  function montar(resultado: unknown) {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const despachador = new DespachadorSalienteService(
      { mensaje: { updateMany } } as never,
      { emitirActividad: jest.fn() } as never,
      { urlFirmada: jest.fn() } as never,
      { enviar: jest.fn().mockResolvedValue(resultado) } as never,
    );
    return { despachador, updateMany };
  }

  /** Lo que se escribió en la fila, sin el `where`. */
  function datos(updateMany: jest.Mock): Record<string, unknown> {
    return updateMany.mock.calls[0][0].data;
  }

  it('NO_SALIO se anota FALLIDO — eso el CRM sí lo sabe', async () => {
    const { despachador, updateMany } = montar({ estado: 'NO_SALIO', motivo: 'Meta 400' });

    await despachador.texto(DESTINO, 'hola');

    expect(datos(updateMany).estadoEnvio).toBe('FALLIDO');
  });

  /**
   * La regresión que motiva todo esto. Antes escribía FALLIDO y la agente
   * reintentaba a mano un mensaje que podía estar ya entregado.
   */
  it('INCIERTO NO se anota FALLIDO', async () => {
    const { despachador, updateMany } = montar({ estado: 'INCIERTO', motivo: 'ECONNRESET' });

    await despachador.texto(DESTINO, 'hola');

    expect(datos(updateMany).estadoEnvio).toBe('INCIERTO');
  });

  /**
   * El `estadoEnvio: 'ENVIADO'` no es redundante con el optimista del `create`:
   * en un reintento la fila viene de FALLIDO y hay que levantarla. Lo que
   * protege de que esto haga RETROCEDER un tick ya avanzado es el `where` del
   * `updateMany`, que excluye ENTREGADO y LEIDO.
   */
  it('ENVIADO guarda el id de Meta, levanta el tick y cancela el reintento', async () => {
    const { despachador, updateMany } = montar({ estado: 'ENVIADO', metaMsgId: 'wamid.ok' });

    await despachador.texto(DESTINO, 'hola');

    expect(datos(updateMany).whatsappMsgId).toBe('wamid.ok');
    expect(datos(updateMany).estadoEnvio).toBe('ENVIADO');
    expect(datos(updateMany).proximoIntento).toBeNull();
    expect(updateMany.mock.calls[0][0].where.estadoEnvio).toEqual({
      notIn: ['ENTREGADO', 'LEIDO'],
    });
  });

  it('NO_SALIO agenda el reintento; INCIERTO no agenda nada', async () => {
    const fallido = montar({ estado: 'NO_SALIO', motivo: 'Meta 400' });
    await fallido.despachador.texto(DESTINO, 'hola');

    const incierto = montar({ estado: 'INCIERTO', motivo: 'ECONNRESET' });
    await incierto.despachador.texto(DESTINO, 'hola');

    expect(datos(fallido.updateMany).proximoIntento).toBeInstanceOf(Date);
    expect(datos(incierto.updateMany).proximoIntento).toBeNull();
  });

  /** Ver la nota de `datosSegunResultado`: una plantilla no se puede rearmar. */
  it('una plantilla fallida NO se agenda para reintento', async () => {
    const { despachador, updateMany } = montar({ estado: 'NO_SALIO', motivo: 'Meta 400' });

    await despachador.plantilla(DESTINO, { plantilla: 'recordatorio', idioma: 'es' });

    expect(datos(updateMany).estadoEnvio).toBe('FALLIDO');
    expect(datos(updateMany)).not.toHaveProperty('proximoIntento');
  });
});
