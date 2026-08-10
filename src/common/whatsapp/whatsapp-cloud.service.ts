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
   * Envía un mensaje y devuelve el id que asignó Meta.
   *
   * `null` significa "no salió" —sin credenciales, error de Meta o de red— y el
   * llamador decide si eso es un FALLIDO o si reintenta de otra forma. Nunca
   * lanza: un problema hablando con Meta no puede tumbar la operación de negocio
   * que ya está guardada.
   */
  async enviar(telefono: string, contenido: ContenidoMensaje): Promise<string | null> {
    if (!this.habilitado) return null;

    /* Meta espera solo dígitos. El código anterior quitaba únicamente el `+`,
       así que un teléfono guardado como "+591 7 000 0001" —formato que puede
       venir del volcado de FileMaker— viajaba con espacios y Meta lo rechazaba.
       Se limpia todo lo que no sea dígito: paréntesis y guiones incluidos. */
    const destino = telefono.replace(/\D/g, '');

    try {
      const respuesta = await fetch(`${BASE}/${this.phoneId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: destino,
          ...contenido,
        }),
      });

      if (!respuesta.ok) {
        this.logger.error(
          `Meta rechazó un ${contenido.type} (${respuesta.status}): ${await respuesta.text()}`,
        );
        return null;
      }

      const datos = (await respuesta.json()) as { messages?: Array<{ id?: string }> };
      return datos.messages?.[0]?.id ?? null;
    } catch (error) {
      this.logger.error(`Excepción enviando un ${contenido.type} a Meta`, error);
      return null;
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
      const respuesta = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
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
      const respuesta = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
      return respuesta.ok ? respuesta : null;
    } catch (error) {
      this.logger.error('Excepción descargando media de Meta', error);
      return null;
    }
  }
}
