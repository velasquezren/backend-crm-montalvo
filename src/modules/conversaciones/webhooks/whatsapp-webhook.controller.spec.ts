import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AlertasWhatsappService } from '../../../common/whatsapp/alertas-whatsapp.service';
import { ConversacionesService } from '../conversaciones.service';
import { IngestaWhatsappService } from '../ingesta-whatsapp.service';
import { WhatsappWebhookDto } from './dto/whatsapp-webhook.dto';
import { WhatsappWebhookController } from './whatsapp-webhook.controller';

/**
 * Esta es la única puerta por la que entra lo que escriben los pacientes. Lo que
 * se fija acá es, sobre todo, que un mensaje que falla no se lleve puestos a los
 * demás del lote: como se responde 200 antes de procesar, lo que se pierda acá
 * Meta no lo reintenta nunca — son mensajes de pacientes desapareciendo sin que
 * nadie se entere.
 */

interface ServicioConversaciones {
  procesarEstadoMensaje: jest.Mock;
}

interface ServicioIngesta {
  procesarEntrante: jest.Mock;
}

/** Registra los avisos de plataforma sin tocar push ni base. */
class AlertasEspia {
  readonly recibidos: Array<{ field?: string; value: unknown }> = [];
  async procesar(field: string | undefined, value: unknown): Promise<void> {
    this.recibidos.push({ field, value });
  }
}

function montar(config: Record<string, string> = {}) {
  const conversaciones: ServicioConversaciones = {
    procesarEstadoMensaje: jest.fn().mockResolvedValue(undefined),
  };
  const ingesta: ServicioIngesta = {
    procesarEntrante: jest.fn().mockResolvedValue({ id: 'msg' }),
  };
  /* Alias con el nombre que usaban las pruebas antes del split de
     ConversacionesService/IngestaWhatsappService, para no reescribir cada
     `servicio.procesarEntrante` de abajo — sigue siendo el mismo objeto. */
  const servicio = { ...conversaciones, ...ingesta };
  const alertas = new AlertasEspia();
  const controller = new WhatsappWebhookController(
    { get: (clave: string) => config[clave] } as ConfigService,
    conversaciones as unknown as ConversacionesService,
    ingesta as unknown as IngestaWhatsappService,
    alertas as unknown as AlertasWhatsappService,
  );
  jest.spyOn(controller['logger'], 'error').mockImplementation(() => undefined);
  jest.spyOn(controller['logger'], 'log').mockImplementation(() => undefined);
  return { controller, servicio, alertas };
}

/** Envuelve mensajes y estados en la estructura anidada real de Meta. */
function payload(value: Record<string, unknown>): WhatsappWebhookDto {
  return { object: 'whatsapp_business_account', entry: [{ changes: [{ value }] }] };
}

const texto = (id: string, from = '59170000001') => ({
  from,
  id,
  type: 'text',
  text: { body: `cuerpo de ${id}` },
});

describe('WhatsappWebhookController', () => {
  describe('verificación de la suscripción (GET)', () => {
    it('devuelve el challenge cuando el verify token coincide', () => {
      const { controller } = montar({ META_VERIFY_TOKEN: 'secreto' });
      expect(controller.verificar('subscribe', 'secreto', 'desafio-123')).toBe('desafio-123');
    });

    it('rechaza un verify token incorrecto o un mode distinto de subscribe', () => {
      const { controller } = montar({ META_VERIFY_TOKEN: 'secreto' });
      expect(() => controller.verificar('subscribe', 'otro', 'x')).toThrow(ForbiddenException);
      expect(() => controller.verificar('unsubscribe', 'secreto', 'x')).toThrow(ForbiddenException);
    });

    /* Sin esto, un META_VERIFY_TOKEN ausente haría `undefined === undefined`:
       cualquiera podría dar de alta su propia suscripción contra este CRM. */
    it('rechaza si META_VERIFY_TOKEN no está configurado', () => {
      const { controller } = montar({});
      expect(() => controller.verificar('subscribe', undefined as unknown as string, 'x')).toThrow(
        ForbiddenException,
      );
    });
  });

  describe('respuesta a Meta', () => {
    it('responde 200 sin esperar el procesamiento (Meta corta a los 3s)', () => {
      const { controller } = montar();
      const lento = jest
        .spyOn(controller, 'procesarWebhook')
        .mockReturnValue(new Promise(() => undefined)); // nunca resuelve

      expect(controller.recibir(payload({ messages: [texto('wamid.1')] }))).toEqual({ received: true });
      expect(lento).toHaveBeenCalled();
    });
  });

  describe('aislamiento de fallos dentro del lote', () => {
    it('procesa los mensajes siguientes aunque uno del medio lance', async () => {
      const { controller, servicio } = montar();
      servicio.procesarEntrante.mockImplementation((_tel: string, contenido: string) =>
        contenido.includes('wamid.2')
          ? Promise.reject(new Error('caída de base simulada'))
          : Promise.resolve({ id: 'ok' }),
      );

      await controller.procesarWebhook(
        payload({ messages: [texto('wamid.1'), texto('wamid.2'), texto('wamid.3')] }),
      );

      expect(servicio.procesarEntrante).toHaveBeenCalledTimes(3);
      expect(servicio.procesarEntrante.mock.calls.map(c => c[2])).toEqual([
        'wamid.1',
        'wamid.2',
        'wamid.3',
      ]);
    });

    it('procesa los statuses aunque todos los mensajes del lote hayan fallado', async () => {
      const { controller, servicio } = montar();
      servicio.procesarEntrante.mockRejectedValue(new Error('caída de base simulada'));

      await controller.procesarWebhook(
        payload({
          messages: [texto('wamid.1')],
          statuses: [{ id: 'wamid.out.1', status: 'delivered' }],
        }),
      );

      expect(servicio.procesarEstadoMensaje).toHaveBeenCalledWith('wamid.out.1', 'delivered');
    });

    it('sigue con el resto de statuses si uno lanza', async () => {
      const { controller, servicio } = montar();
      servicio.procesarEstadoMensaje.mockImplementation((id: string) =>
        id === 'wamid.out.2' ? Promise.reject(new Error('boom')) : Promise.resolve(undefined),
      );

      await controller.procesarWebhook(
        payload({
          statuses: [
            { id: 'wamid.out.1', status: 'sent' },
            { id: 'wamid.out.2', status: 'delivered' },
            { id: 'wamid.out.3', status: 'read' },
          ],
        }),
      );

      expect(servicio.procesarEstadoMensaje).toHaveBeenCalledTimes(3);
    });

    it('no propaga la excepción al llamador (se dispara con `void`)', async () => {
      const { controller, servicio } = montar();
      servicio.procesarEntrante.mockRejectedValue(new Error('boom'));
      await expect(
        controller.procesarWebhook(payload({ messages: [texto('wamid.1')] })),
      ).resolves.toBeUndefined();
    });
  });

  describe('extracción de mensajes entrantes', () => {
    it('persiste un mensaje de texto con el nombre de perfil del contacto', async () => {
      const { controller, servicio } = montar();
      await controller.procesarWebhook(
        payload({
          contacts: [{ wa_id: '59170000001', profile: { name: '  Ana Pérez  ' } }],
          messages: [texto('wamid.1')],
        }),
      );

      expect(servicio.procesarEntrante).toHaveBeenCalledWith(
        '+59170000001',
        'cuerpo de wamid.1',
        'wamid.1',
        'Ana Pérez',
      );
    });

    it('no confunde el perfil de otro contacto del mismo lote', async () => {
      const { controller, servicio } = montar();
      await controller.procesarWebhook(
        payload({
          contacts: [
            { wa_id: '59199999999', profile: { name: 'Otra Persona' } },
            { wa_id: '59170000001', profile: { name: 'Ana Pérez' } },
          ],
          messages: [texto('wamid.1', '59170000001')],
        }),
      );

      expect(servicio.procesarEntrante.mock.calls[0][3]).toBe('Ana Pérez');
    });

    it('deja el nombre en undefined si el perfil viene vacío', async () => {
      const { controller, servicio } = montar();
      await controller.procesarWebhook(
        payload({
          contacts: [{ wa_id: '59170000001', profile: { name: '   ' } }],
          messages: [texto('wamid.1')],
        }),
      );

      expect(servicio.procesarEntrante.mock.calls[0][3]).toBeUndefined();
    });

    /* Estas dos son las respuestas que antes se descartaban: el paciente toca
       "Confirmar" en una plantilla y su respuesta no llegaba al CRM. */
    it('registra la respuesta a un botón de plantilla', async () => {
      const { controller, servicio } = montar();
      await controller.procesarWebhook(
        payload({
          messages: [
            { from: '59170000001', id: 'wamid.b', type: 'button', button: { text: 'Confirmar' } },
          ],
        }),
      );

      expect(servicio.procesarEntrante).toHaveBeenCalledWith(
        '+59170000001',
        'Confirmar',
        'wamid.b',
        undefined,
      );
    });

    it('registra la opción elegida en un mensaje interactivo (botón y lista)', async () => {
      const { controller, servicio } = montar();
      await controller.procesarWebhook(
        payload({
          messages: [
            {
              from: '59170000001',
              id: 'wamid.i1',
              type: 'interactive',
              interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Sí' } },
            },
            {
              from: '59170000001',
              id: 'wamid.i2',
              type: 'interactive',
              interactive: { type: 'list_reply', list_reply: { id: 'l1', title: 'Consulta' } },
            },
          ],
        }),
      );

      expect(servicio.procesarEntrante.mock.calls.map(c => c[1])).toEqual(['Sí', 'Consulta']);
    });

    it('guarda la media con su tipo, mime y nombre, usando el caption como contenido', async () => {
      const { controller, servicio } = montar();
      await controller.procesarWebhook(
        payload({
          messages: [
            {
              from: '59170000001',
              id: 'wamid.doc',
              type: 'document',
              document: {
                id: 'media-123',
                mime_type: 'application/pdf',
                filename: 'estudio.pdf',
                caption: 'Mi estudio',
              },
            },
          ],
        }),
      );

      expect(servicio.procesarEntrante).toHaveBeenCalledWith(
        '+59170000001',
        'Mi estudio',
        'wamid.doc',
        undefined,
        { tipo: 'DOCUMENTO', mediaId: 'media-123', mime: 'application/pdf', nombre: 'estudio.pdf' },
      );
    });

    it('usa un mime por defecto y contenido vacío cuando la media no los trae', async () => {
      const { controller, servicio } = montar();
      await controller.procesarWebhook(
        payload({
          messages: [{ from: '59170000001', id: 'wamid.img', type: 'image', image: { id: 'media-9' } }],
        }),
      );

      expect(servicio.procesarEntrante.mock.calls[0][1]).toBe('');
      expect(servicio.procesarEntrante.mock.calls[0][4]).toEqual({
        tipo: 'IMAGEN',
        mediaId: 'media-9',
        mime: 'application/octet-stream',
        nombre: undefined,
      });
    });

    it('extrae y reenvía el contexto de campaña / anuncio de Meta Ads (referral)', async () => {
      const { controller, servicio } = montar();
      await controller.procesarWebhook(
        payload({
          messages: [
            {
              from: '59170000001',
              id: 'wamid.ad1',
              type: 'text',
              text: { body: 'Hola, quiero info de Rinoplastia' },
              referral: {
                source_type: 'ad',
                source_id: '120215839201920',
                headline: 'Promoción Rinoplastia Agosto',
                body: 'Agenda tu cita de valoración con descuento',
                source_url: 'https://fb.me/ad123',
                image_url: 'https://facebook.com/ad-img.jpg',
              },
            },
          ],
        }),
      );

      expect(servicio.procesarEntrante).toHaveBeenCalledWith(
        '+59170000001',
        'Hola, quiero info de Rinoplastia',
        'wamid.ad1',
        undefined,
        undefined,
        {
          origenTipo: 'ad',
          anuncioId: '120215839201920',
          titular: 'Promoción Rinoplastia Agosto',
          cuerpo: 'Agenda tu cita de valoración con descuento',
          origenUrl: 'https://fb.me/ad123',
          imagenUrl: 'https://facebook.com/ad-img.jpg',
        },
      );
    });

    it('ignora mensajes sin `from`, sin cuerpo, o de tipos que el CRM no registra', async () => {
      const { controller, servicio } = montar();
      await controller.procesarWebhook(
        payload({
          messages: [
            { id: 'sin-from', type: 'text', text: { body: 'hola' } },
            { from: '59170000001', id: 'wamid.vacio', type: 'text', text: {} },
            { from: '59170000001', id: 'wamid.loc', type: 'location' },
            { from: '59170000001', id: 'wamid.reaccion', type: 'reaction' },
          ],
        }),
      );

      expect(servicio.procesarEntrante).not.toHaveBeenCalled();
    });

    it('procesa todos los cambios de todas las entries, no solo el primero', async () => {
      const { controller, servicio } = montar();
      await controller.procesarWebhook({
        object: 'whatsapp_business_account',
        entry: [
          { changes: [{ value: { messages: [texto('wamid.1')] } }] },
          {
            changes: [
              { value: { messages: [texto('wamid.2')] } },
              { value: { messages: [texto('wamid.3')] } },
            ],
          },
        ],
      });

      expect(servicio.procesarEntrante).toHaveBeenCalledTimes(3);
    });

    it('no explota con un payload vacío o sin las claves esperadas', async () => {
      const { controller, servicio } = montar();
      await expect(controller.procesarWebhook({})).resolves.toBeUndefined();
      await expect(controller.procesarWebhook({ entry: [{}] })).resolves.toBeUndefined();
      await expect(controller.procesarWebhook(payload({}))).resolves.toBeUndefined();
      expect(servicio.procesarEntrante).not.toHaveBeenCalled();
    });
  });

  describe('estados de entrega', () => {
    it('reenvía id y estado al service', async () => {
      const { controller, servicio } = montar();
      await controller.procesarWebhook(
        payload({ statuses: [{ id: 'wamid.out.1', status: 'read' }] }),
      );
      expect(servicio.procesarEstadoMensaje).toHaveBeenCalledWith('wamid.out.1', 'read');
    });

    it('ignora statuses incompletos', async () => {
      const { controller, servicio } = montar();
      await controller.procesarWebhook(
        payload({ statuses: [{ id: 'wamid.out.1' }, { status: 'read' }, {}] }),
      );
      expect(servicio.procesarEstadoMensaje).not.toHaveBeenCalled();
    });

    it('registra el detalle del error de Meta en un status failed y lo procesa igual', async () => {
      const { controller, servicio } = montar();
      const log = jest.spyOn(controller['logger'], 'error');

      await controller.procesarWebhook(
        payload({
          statuses: [
            {
              id: 'wamid.out.1',
              status: 'failed',
              errors: [{ code: 131047, title: 'Re-engagement message' }],
            },
          ],
        }),
      );

      expect(log).toHaveBeenCalledWith(expect.stringContaining('131047: Re-engagement message'));
      expect(servicio.procesarEstadoMensaje).toHaveBeenCalledWith('wamid.out.1', 'failed');
    });
  });

  describe('avisos de plataforma', () => {
    /** Los avisos van en `change.field`, no dentro de `value` como los mensajes. */
    function conCampo(field: string, value: Record<string, unknown>): WhatsappWebhookDto {
      return { object: 'whatsapp_business_account', entry: [{ changes: [{ field, value }] }] };
    }

    it('una restricción de la cuenta llega al servicio de alertas', async () => {
      const { controller, alertas } = montar();

      await controller.procesarWebhook(
        conCampo('account_update', {
          event: 'ACCOUNT_RESTRICTION',
          restriction_info: [{ restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING' }],
        }),
      );

      expect(alertas.recibidos).toHaveLength(1);
      expect(alertas.recibidos[0].field).toBe('account_update');
    });

    it('un aviso que revienta no se lleva el resto del lote', async () => {
      /* Mismo criterio que los mensajes: ya se respondió 200, así que lo que se
         pierda aquí Meta no lo reintenta. */
      const { controller, alertas, servicio } = montar();
      jest.spyOn(alertas, 'procesar').mockRejectedValueOnce(new Error('boom'));

      await controller.procesarWebhook({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              { field: 'account_update', value: { event: 'ACCOUNT_VIOLATION' } },
              { field: 'messages', value: { messages: [texto('wamid.tras.aviso')] } },
            ],
          },
        ],
      });

      expect(servicio.procesarEntrante).toHaveBeenCalledTimes(1);
    });

    it('un cambio de `messages` NO se desvía a alertas', async () => {
      const { controller, alertas, servicio } = montar();

      await controller.procesarWebhook(
        conCampo('messages', { messages: [texto('wamid.normal')] }),
      );

      expect(alertas.recibidos).toHaveLength(0);
      expect(servicio.procesarEntrante).toHaveBeenCalledTimes(1);
    });
  });
});
