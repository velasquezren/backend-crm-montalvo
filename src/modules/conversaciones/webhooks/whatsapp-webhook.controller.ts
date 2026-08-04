import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Logger,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';

import { TipoMensaje } from '@prisma/client';

import { Public } from '../../../common/decorators/public.decorator';
import { ConversacionesService } from '../conversaciones.service';
import {
  WhatsappContactDto,
  WhatsappMessageDto,
  WhatsappWebhookDto,
} from './dto/whatsapp-webhook.dto';
import { WhatsappSignatureGuard } from './whatsapp-signature.guard';

/** Extrae el objeto de media de un mensaje entrante y lo normaliza, o null si no es media soportada. */
function extraerMedia(
  mensaje: WhatsappMessageDto,
): { tipo: TipoMensaje; mediaId: string; mime: string; nombre?: string; caption?: string } | null {
  const mapa: Array<[keyof WhatsappMessageDto, TipoMensaje]> = [
    ['image', 'IMAGEN'],
    ['document', 'DOCUMENTO'],
    ['audio', 'AUDIO'],
    ['video', 'VIDEO'],
    ['sticker', 'STICKER'],
  ];
  for (const [campo, tipo] of mapa) {
    const media = mensaje[campo] as
      | { id?: string; mime_type?: string; filename?: string; caption?: string }
      | undefined;
    if (media?.id) {
      return {
        tipo,
        mediaId: media.id,
        mime: media.mime_type ?? 'application/octet-stream',
        nombre: media.filename,
        caption: media.caption,
      };
    }
  }
  return null;
}

/**
 * Extrae el texto que el cliente eligió al pulsar un botón de plantilla o un
 * botón/lista interactiva, o null si el mensaje no es una respuesta de este
 * tipo. Estas respuestas llegan con su propio `type` y antes se descartaban.
 */
function extraerRespuestaBoton(mensaje: WhatsappMessageDto): string | null {
  if (mensaje.type === 'button') {
    const texto = mensaje.button?.text ?? mensaje.button?.payload;
    return texto?.trim() || null;
  }
  if (mensaje.type === 'interactive') {
    const texto =
      mensaje.interactive?.button_reply?.title ?? mensaje.interactive?.list_reply?.title;
    return texto?.trim() || null;
  }
  return null;
}

/**
 * Webhook de WhatsApp Cloud API — RF-09. Los mensajes de texto entrantes se
 * persisten y crean cliente + conversación si no existían.
 *
 * El DTO modela solo lo que el CRM usa; el `whitelist` global descarta el
 * resto del payload de Meta sin rechazarlo (ver main.ts: `forbidNonWhitelisted`
 * está desactivado justo por estos webhooks).
 *
 * `@SkipThrottle()`: las ráfagas de Meta (varios mensajes juntos, o reintentos
 * masivos tras una caída) no deben chocar contra el rate-limit global — tras
 * varios 429 Meta desactiva la suscripción. No se puede limitar por IP de
 * forma útil (todo llega de los rangos de Meta) y el endpoint ya es idempotente
 * por `whatsappMsgId`, así que reintentos duplicados no hacen daño. Lo que
 * sostiene al endpoint no es el rate-limit sino la firma: ver
 * `WhatsappSignatureGuard` sobre el POST.
 */
@SkipThrottle()
@Controller('webhooks/whatsapp')
export class WhatsappWebhookController {
  private readonly logger = new Logger(WhatsappWebhookController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly conversacionesService: ConversacionesService,
  ) {}

  @Public()
  @Get()
  verificar(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): string {
    const esperado = this.config.get<string>('META_VERIFY_TOKEN');
    /* Sin esta guarda, un META_VERIFY_TOKEN ausente comparaba `undefined ===
       undefined` y daba por buena cualquier petición: cualquiera podía dar de
       alta su propia suscripción de webhook apuntando a este CRM. */
    if (!esperado) {
      this.logger.error(
        'META_VERIFY_TOKEN no está configurado: se rechaza la verificación del webhook de WhatsApp.',
      );
      throw new ForbiddenException('Webhook no configurado');
    }
    if (mode === 'subscribe' && token === esperado) {
      return challenge;
    }
    throw new ForbiddenException('Token de verificación inválido');
  }

  @Public()
  @UseGuards(WhatsappSignatureGuard)
  @Post()
  recibir(@Body() payload: WhatsappWebhookDto): { received: true } {
    /* Meta exige un 200 rápido (< 3s); procesamos el payload de forma asíncrona
       para responder en < 2ms y evitar desactivación por timeouts durante ráfagas. */
    void this.procesarWebhook(payload);
    return { received: true };
  }

  /**
   * Procesa el payload ya verificado. Público (no privado) para poder probarlo
   * esperando su promesa: desde `recibir` se dispara con `void` a propósito, así
   * que en una prueba no habría forma de saber cuándo terminó.
   *
   * **Cada mensaje y cada estado van en su propio try/catch.** Antes había uno
   * solo envolviendo los dos bucles: si el mensaje 2 de 5 lanzaba, los 3
   * restantes y todos los `statuses` de ese cambio se perdían — y como ya se
   * respondió 200, Meta nunca los reintenta. Eran mensajes de pacientes
   * desapareciendo en silencio.
   */
  async procesarWebhook(payload: WhatsappWebhookDto): Promise<void> {
    const cambios = payload.entry?.flatMap(e => e.changes ?? []) ?? [];

    for (const cambio of cambios) {
      let procesados = 0;
      for (const mensaje of cambio.value?.messages ?? []) {
        try {
          if (await this.procesarMensaje(cambio.value?.contacts, mensaje)) {
            procesados++;
          }
        } catch (error) {
          this.logger.error(
            `Error procesando mensaje entrante de WhatsApp (MsgId: ${mensaje.id ?? 'sin id'}); se continúa con el resto del lote`,
            error,
          );
        }
      }

      if (procesados > 0) {
        this.logger.log(`WhatsApp: ${procesados} mensaje(s) entrante(s) procesado(s)`);
      }

      for (const estado of cambio.value?.statuses ?? []) {
        if (!estado.id || !estado.status) continue;
        try {
          if (estado.status === 'failed') {
            const [primerError] = estado.errors ?? [];
            const errorDetalle = primerError
              ? `${primerError.code}: ${primerError.title}`
              : JSON.stringify(estado);
            this.logger.error(`Mensaje WhatsApp fallido en Meta (MsgId: ${estado.id}): ${errorDetalle}`);
          }
          await this.conversacionesService.procesarEstadoMensaje(estado.id, estado.status);
        } catch (error) {
          this.logger.error(
            `Error procesando estado de mensaje (MsgId: ${estado.id}); se continúa con el resto del lote`,
            error,
          );
        }
      }
    }
  }

  /** Persiste un mensaje entrante. Devuelve false si no es de un tipo que el CRM registre. */
  private async procesarMensaje(
    contactos: WhatsappContactDto[] | undefined,
    mensaje: WhatsappMessageDto,
  ): Promise<boolean> {
    if (!mensaje.from) return false;

    const contacto = contactos?.find(c => c.wa_id === mensaje.from);
    const nombrePerfil = contacto?.profile?.name?.trim() || undefined;
    const telefono = `+${mensaje.from}`;

    if (mensaje.type === 'text' && mensaje.text?.body) {
      await this.conversacionesService.procesarEntrante(telefono, mensaje.text.body, mensaje.id, nombrePerfil);
      return true;
    }

    const respuestaBoton = extraerRespuestaBoton(mensaje);
    if (respuestaBoton) {
      await this.conversacionesService.procesarEntrante(telefono, respuestaBoton, mensaje.id, nombrePerfil);
      return true;
    }

    const media = extraerMedia(mensaje);
    if (media) {
      await this.conversacionesService.procesarEntrante(
        telefono,
        media.caption ?? '',
        mensaje.id,
        nombrePerfil,
        { tipo: media.tipo, mediaId: media.mediaId, mime: media.mime, nombre: media.nombre },
      );
      return true;
    }

    return false;
  }
}
