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

import { Public } from '../../../common/decorators/public.decorator';
import { ConversacionesService } from '../conversaciones.service';
import { WhatsappWebhookDto } from './dto/whatsapp-webhook.dto';

/**
 * Webhook de WhatsApp Cloud API — RF-09. Los mensajes de texto entrantes se
 * persisten y crean cliente + conversación si no existían.
 *
 * El DTO modela solo lo que el CRM usa; el `whitelist` global descarta el
 * resto del payload de Meta sin rechazarlo (ver main.ts: `forbidNonWhitelisted`
 * está desactivado justo por estos webhooks).
 */
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
      const mensajes = (cambio.value?.messages ?? []).filter(
        m => m.type === 'text' && m.from && m.text?.body,
      );

      for (const mensaje of mensajes) {
        /* WhatsApp manda el nombre del perfil en `contacts`, emparejado por wa_id.
           Se usa para dar de alta al cliente con su nombre real en vez de un
           marcador tipo "WhatsApp +591…". */
        const contacto = cambio.value?.contacts?.find(c => c.wa_id === mensaje.from);

        await this.conversacionesService.procesarEntrante(
          `+${mensaje.from}`,
          mensaje.text!.body!,
          mensaje.id,
          contacto?.profile?.name?.trim() || undefined,
        );
      }

      if (mensajes.length > 0) {
        this.logger.log(`WhatsApp: ${mensajes.length} mensaje(s) entrante(s) procesado(s)`);
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
