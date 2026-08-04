import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Logger,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';

import { Public } from '../../../common/decorators/public.decorator';
import { MetaSignatureGuard } from '../../../common/guards/meta-signature.guard';
import { MetaWebhookDto } from './dto/meta-webhook.dto';

/**
 * Webhook de Meta (Facebook/Instagram Lead Ads) — RF-04.
 *
 * Estado actual: verificación (GET) funcional + recepción (POST) que registra
 * los leadgen_id entrantes. La resolución del lead completo requiere llamar a
 * Graph API con un PAGE_ACCESS_TOKEN (pendiente de configurar en .env cuando
 * la página de Meta esté conectada) — ahí se obtienen nombre/teléfono y se
 * delega a LeadsService.procesarLeadMeta().
 */
/* Igual que el de WhatsApp: sin forbidNonWhitelisted, el payload de Meta
   trae campos que no modelamos y rechazarlo desactivaría la suscripción.
   Y por el mismo motivo, `@SkipThrottle()`: las ráfagas de Meta no deben
   chocar contra el rate-limit global. Lo que sostiene el endpoint es la
   firma (`MetaSignatureGuard`), no el límite de peticiones. */
@SkipThrottle()
@Controller('webhooks/meta')
export class MetaWebhookController {
  private readonly logger = new Logger(MetaWebhookController.name);

  constructor(private readonly config: ConfigService) {}

  /** Verificación del webhook — Meta llama esto al configurar la suscripción. */
  @Public()
  @Get()
  verificar(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): string {
    const esperado = this.config.get<string>('META_VERIFY_TOKEN');
    /* Mismo fallo que tenía el webhook de WhatsApp: sin esta guarda, un
       META_VERIFY_TOKEN ausente comparaba `undefined === undefined` y daba por
       buena cualquier petición — cualquiera podía dar de alta su propia
       suscripción de Lead Ads apuntando a este CRM. */
    if (!esperado) {
      this.logger.error(
        'META_VERIFY_TOKEN no está configurado: se rechaza la verificación del webhook de Meta.',
      );
      throw new ForbiddenException('Webhook no configurado');
    }
    if (mode === 'subscribe' && token === esperado) {
      return challenge;
    }
    throw new ForbiddenException('Token de verificación inválido');
  }

  @Public()
  @UseGuards(MetaSignatureGuard)
  @Post()
  /* 200, no el 201 que Nest da por defecto en POST: es lo que Meta documenta
     esperar. Ver la nota en el webhook de WhatsApp. */
  @HttpCode(200)
  recibir(@Body() payload: MetaWebhookDto): { received: true } {
    const leadgenIds =
      payload.entry
        ?.flatMap(e => e.changes ?? [])
        .filter(c => c.field === 'leadgen')
        .map(c => c.value?.leadgen_id)
        .filter(Boolean) ?? [];

    if (leadgenIds.length > 0) {
      /* TODO (requiere PAGE_ACCESS_TOKEN): por cada leadgen_id llamar a Graph API,
         extraer nombre/teléfono y delegar a LeadsService.procesarLeadMeta(). */
      this.logger.log(`Webhook Meta: ${leadgenIds.length} lead(s) recibido(s), pendientes de resolución`);
    }

    /* Meta exige 200 rápido; cualquier procesamiento pesado debe ser asíncrono. */
    return { received: true };
  }
}
