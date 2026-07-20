import { Body, Controller, ForbiddenException, Get, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Public } from '../../../common/decorators/public.decorator';
import { ConversacionesService } from '../conversaciones.service';
import { WhatsappWebhookDto } from './dto/whatsapp-webhook.dto';

/** Webhook de WhatsApp Cloud API — RF-09. Mensajes de texto entrantes se persisten. */
@Controller('webhooks/whatsapp')
export class WhatsappWebhookController {
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
    const mensajes =
      payload.entry
        ?.flatMap(e => e.changes ?? [])
        .flatMap(c => c.value?.messages ?? [])
        .filter(m => m.type === 'text' && m.from && m.text?.body) ?? [];

    for (const mensaje of mensajes) {
      await this.conversacionesService.procesarEntrante(
        `+${mensaje.from}`,
        mensaje.text!.body!,
        mensaje.id,
      );
    }

    return { received: true };
  }
}
