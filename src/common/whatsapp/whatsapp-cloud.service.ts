import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Único punto del CRM que habla con la Cloud API de Meta.
 *
 * Antes había **cuatro métodos** en `ConversacionesService` que repetían lo
 * mismo: leer el token con su `||`, leer el phoneId con el suyo, montar la URL
 * y hacer el POST. Eso traía dos problemas concretos:
 *
 * - Los pares de variables (`WHATSAPP_TOKEN` / `WHATSAPP_ACCESS_TOKEN`) se leían
 *   en cuatro sitios. El día que se rote una y se olvide la otra, los cuatro
 *   caminos usan la vieja **en silencio** y los envíos fallan sin motivo
 *   aparente. Ahora se resuelve una vez.
 * - La versión de la API estaba escrita seis veces. Subir de v25 a v26 era
 *   buscar cadenas por el archivo; ahora es una constante.
 *
 * El `estadoEnvio` y el `whatsappMsgId` NO se tocan aquí a propósito: este
 * servicio no conoce la base. Devuelve lo que Meta contestó y quien llama decide
 * qué guardar — así se puede probar con `fetch` simulado sin levantar Postgres,
 * y el día que otro módulo necesite mandar un WhatsApp no arrastra Conversaciones.
 */

/** Se sube tocando solo esta línea. Meta publica v26; se sigue en v25 porque no
 *  hay deprecaciones señaladas y cambiar de versión merece su propia prueba. */
const VERSION_API = 'v25.0';
const BASE = `https://graph.facebook.com/${VERSION_API}`;

/**
 * Cuánto se espera a Meta antes de cortar.
 *
 * No había ninguno: sin `AbortSignal`, un socket que Meta deja abierto sin
 * contestar dejaba el despacho esperando para siempre, en un proceso de un solo
 * núcleo. El round-trip típico son 300-900 ms; diez segundos es holgado sin ser
 * indefinido. La media va aparte porque descarga archivos, no JSON.
 */
const ESPERA_MS = 10_000;
const ESPERA_MEDIA_MS = 30_000;

/**
 * Qué pasó con un envío, que NO es lo mismo que si tenemos su id.
 *
 * El `string | null` anterior colapsaba tres desenlaces distintos —sin
 * credenciales, Meta lo rechazó, y la red se cayó sin saber si el POST llegó—
 * y el despachador los anotaba todos como FALLIDO. Los dos primeros constan;
 * el tercero es una afirmación que el CRM no puede sostener, y sostenerla hacía
 * que una agente reintentara a mano un mensaje que la paciente quizá ya tenía.
 * Ver `resultado-de-envio-desconocido.spec.ts`.
 *
 * `motivo` es para el journal, no para la paciente: sale en el log del
 * despachador junto al id de la fila.
 */
export type ResultadoEnvio =
  | { estado: 'ENVIADO'; metaMsgId: string }
  | { estado: 'NO_SALIO'; motivo: string }
  | { estado: 'INCIERTO'; motivo: string };

/** Lo que Meta acepta como cuerpo de `/messages`, sin el `to` ni las constantes. */
export type ContenidoMensaje =
  | { type: 'text'; text: { body: string } }
  | { type: 'image'; image: { link: string } }
  | { type: 'document'; document: { link: string; filename: string } }
  | { type: 'template'; template: Record<string, unknown> }
  | { type: 'interactive'; interactive: Record<string, unknown> };

@Injectable()
export class WhatsappCloudService {
  private readonly logger = new Logger(WhatsappCloudService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Ambos pares admiten dos nombres por historia del `.env` de producción, que
   * los tiene duplicados. Se resuelve aquí y en ningún otro sitio.
   */
  private get token(): string | undefined {
    return (
      this.config.get<string>('WHATSAPP_TOKEN') || this.config.get<string>('WHATSAPP_ACCESS_TOKEN')
    );
  }

  private get phoneId(): string | undefined {
    return (
      this.config.get<string>('WHATSAPP_PHONE_ID') ||
      this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID')
    );
  }

  /** Sin credenciales el CRM sigue funcionando: guarda el mensaje y no lo manda. */
  get habilitado(): boolean {
    return Boolean(this.token && this.phoneId);
  }

  /**
   * Envía un mensaje y dice **qué pasó**, no solo si tenemos su id.
   *
   * Nunca lanza: un problema hablando con Meta no puede tumbar la operación de
   * negocio que ya está guardada. Pero tampoco miente — distingue "no salió" de
   * "no se sabe", que es la diferencia entre reintentar tranquilo y duplicarle
   * el mensaje a la paciente. El reparto:
   *
   * - **NO_SALIO**: sin credenciales, o Meta contestó 4xx. Meta rechazó el
   *   cuerpo; no hay nada del otro lado.
   * - **INCIERTO**: excepción de red, corte por tiempo, o un 5xx de Meta. El
   *   POST pudo llegar. También el 200 sin id: Meta lo ACEPTÓ —lo dice el
   *   propio 200— pero no queda con qué correlacionar su `statuses`.
   * - **ENVIADO**: 200 con id.
   *
   * `referencia` viaja como `biz_opaque_callback_data` y Meta la devuelve en el
   * webhook de `statuses`. Se manda el id de nuestra fila: es el único hilo que
   * sobrevive a no recibir la respuesta HTTP, y lo que permite que un INCIERTO
   * se resuelva solo. Ojo con la versión de la API — la documentación advierte
   * que el campo se omite entero en v24; aquí se va en v25.
   */
  async enviar(
    telefono: string,
    contenido: ContenidoMensaje,
    referencia?: string,
  ): Promise<ResultadoEnvio> {
    if (!this.habilitado) {
      return { estado: 'NO_SALIO', motivo: 'WhatsApp deshabilitado: faltan token o phoneId' };
    }

    /* Meta espera solo dígitos. El código anterior quitaba únicamente el `+`,
       así que un teléfono guardado como "+591 7 000 0001" —formato que puede
       venir del volcado de FileMaker— viajaba con espacios y Meta lo rechazaba.
       Se limpia todo lo que no sea dígito: paréntesis y guiones incluidos. */
    const destino = telefono.replace(/\D/g, '');

    try {
      const respuesta = await fetch(`${BASE}/${this.phoneId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(ESPERA_MS),
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: destino,
          ...contenido,
          /* Solo si hay referencia: Meta no tiene por qué recibir el campo vacío. */
          ...(referencia ? { biz_opaque_callback_data: referencia } : {}),
        }),
      });

      if (!respuesta.ok) {
        const detalle = `Meta devolvió ${respuesta.status} a un ${contenido.type}: ${await respuesta.text()}`;
        this.logger.error(detalle);
        /* Un 4xx es un rechazo del cuerpo: no hay nada del otro lado. Un 5xx es
           un problema de Meta que puede haberse comido el mensaje DESPUÉS de
           aceptarlo, así que no se puede afirmar que no salió. */
        return respuesta.status >= 500
          ? { estado: 'INCIERTO', motivo: detalle }
          : { estado: 'NO_SALIO', motivo: detalle };
      }

      const datos = (await respuesta.json()) as { messages?: Array<{ id?: string }> };
      const metaMsgId = datos.messages?.[0]?.id;
      if (!metaMsgId) {
        /* 200 sin id: Meta lo aceptó pero no dejó con qué correlacionar el
           `statuses`. Lo rescata `biz_opaque_callback_data`, no este return. */
        this.logger.warn(`Meta aceptó un ${contenido.type} sin devolver id de mensaje`);
        return { estado: 'INCIERTO', motivo: 'Meta respondió 200 sin id de mensaje' };
      }
      return { estado: 'ENVIADO', metaMsgId };
    } catch (error) {
      /* Aquí caen la red y el corte por tiempo. En ninguno de los dos se sabe
         si el POST llegó a viajar entero: es incierto, nunca FALLIDO. */
      this.logger.error(`Excepción enviando un ${contenido.type} a Meta`, error);
      return { estado: 'INCIERTO', motivo: motivoDe(error) };
    }
  }

  /**
   * Tildes azules, y el "escribiendo…" si se pide.
   *
   * No devuelve nada útil: es cosmético para el paciente y su fallo no cambia
   * nada del CRM.
   */
  async marcarLeido(whatsappMsgId: string, typing = false): Promise<void> {
    if (!this.habilitado) return;

    try {
      const respuesta = await fetch(`${BASE}/${this.phoneId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(ESPERA_MS),
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: whatsappMsgId,
          ...(typing ? { typing_indicator: { type: 'text' } } : {}),
        }),
      });
      if (!respuesta.ok) {
        this.logger.warn(`No se pudo marcar leído (${respuesta.status}): ${await respuesta.text()}`);
      }
    } catch (error) {
      this.logger.error('Excepción al marcar leído en Meta', error);
    }
  }

  /** Plantillas aprobadas de la WABA. Devuelve null si no se pudieron pedir. */
  async listarPlantillas(): Promise<unknown[] | null> {
    const wabaId = this.config.get<string>('WHATSAPP_WABA_ID');
    if (!this.token || !wabaId) return null;

    try {
      const url = `${BASE}/${wabaId}/message_templates?fields=name,status,category,language,components&limit=100`;
      const respuesta = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(ESPERA_MS),
      });
      if (!respuesta.ok) {
        this.logger.error(`Error listando plantillas (${respuesta.status}): ${await respuesta.text()}`);
        return null;
      }
      const datos = (await respuesta.json()) as { data?: unknown[] };
      return datos.data ?? [];
    } catch (error) {
      this.logger.error('Excepción al listar plantillas de Meta', error);
      return null;
    }
  }

  /** `media_id` → URL temporal (5 min) desde donde bajar el archivo. */
  async urlDeMedia(mediaId: string): Promise<string | null> {
    if (!this.token) return null;
    try {
      const respuesta = await fetch(`${BASE}/${mediaId}`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(ESPERA_MS),
      });
      if (!respuesta.ok) {
        this.logger.error(`No se pudo obtener URL de media ${mediaId} (${respuesta.status})`);
        return null;
      }
      const { url } = (await respuesta.json()) as { url?: string };
      return url ?? null;
    } catch (error) {
      this.logger.error(`Excepción pidiendo la URL de media ${mediaId}`, error);
      return null;
    }
  }

  /** El CDN de Meta también exige el token. */
  async descargarMedia(url: string): Promise<Response | null> {
    if (!this.token) return null;
    try {
      const respuesta = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}` },
        /* Más holgado que el resto: esto baja el archivo, no un JSON. */
        signal: AbortSignal.timeout(ESPERA_MEDIA_MS),
      });
      return respuesta.ok ? respuesta : null;
    } catch (error) {
      this.logger.error('Excepción descargando media de Meta', error);
      return null;
    }
  }
}

/**
 * Un motivo legible para el journal, sin volcar el error entero.
 *
 * `AbortSignal.timeout` rechaza con un `TimeoutError`, que sin este trato sale
 * al log como "The operation was aborted" — indistinguible de una cancelación
 * cualquiera justo cuando importa saber que Meta no contestó a tiempo.
 */
function motivoDe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError'
      ? `Meta no respondió en ${ESPERA_MS} ms`
      : `${error.name}: ${error.message}`;
  }
  return String(error);
}
