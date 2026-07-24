import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Logger,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';

import { TipoMensaje } from '@prisma/client';

import { Public } from '../../../common/decorators/public.decorator';
import { ConversacionesService } from '../conversaciones.service';
import { WhatsappMessageDto, WhatsappWebhookDto } from './dto/whatsapp-webhook.dto';

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
 * por `whatsappMsgId`, así que reintentos duplicados no hacen daño.
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
    if (mode === 'subscribe' && token === esperado) {
      return challenge;
    }
    throw new ForbiddenException('Token de verificación inválido');
  }

  @Public()
  @Post()
  async recibir(@Body() payload: WhatsappWebhookDto): Promise<{ received: true }> {
    const cambios = payload.entry?.flatMap(e => e.changes ?? []) ?? [];

    for (const cambio of cambios) {
      let procesados = 0;
      for (const mensaje of cambio.value?.messages ?? []) {
        if (!mensaje.from) continue;

        /* WhatsApp manda el nombre del perfil en `contacts`, emparejado por wa_id.
           Se usa para dar de alta al cliente con su nombre real en vez de un
           marcador tipo "WhatsApp +591…". */
        const contacto = cambio.value?.contacts?.find(c => c.wa_id === mensaje.from);
        const nombrePerfil = contacto?.profile?.name?.trim() || undefined;
        const telefono = `+${mensaje.from}`;

        if (mensaje.type === 'text' && mensaje.text?.body) {
          await this.conversacionesService.procesarEntrante(telefono, mensaje.text.body, mensaje.id, nombrePerfil);
          procesados++;
        } else {
          const media = extraerMedia(mensaje);
          if (media) {
            await this.conversacionesService.procesarEntrante(
              telefono,
              media.caption ?? '',
              mensaje.id,
              nombrePerfil,
              { tipo: media.tipo, mediaId: media.mediaId, mime: media.mime, nombre: media.nombre },
            );
            procesados++;
          }
          /* Otros tipos (ubicación, contactos, reacciones…) se ignoran por ahora. */
        }
      }

      if (procesados > 0) {
        this.logger.log(`WhatsApp: ${procesados} mensaje(s) entrante(s) procesado(s)`);
      }

      /* Confirmaciones de entrega/lectura de mensajes SALIENTES nuestros
         (los ticks del chat) — Meta las manda en el mismo payload, en
         `statuses`, no en `messages`. */
      const estados = cambio.value?.statuses ?? [];
      for (const estado of estados) {
        if (estado.id && estado.status) {
          await this.conversacionesService.procesarEstadoMensaje(estado.id, estado.status);
        }
      }
    }

    /* Meta exige un 200 rápido; si no, reintenta y acaba desactivando el webhook. */
    return { received: true };
  }
}
