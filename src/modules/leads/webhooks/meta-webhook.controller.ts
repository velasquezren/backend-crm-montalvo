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
import { LeadsService } from '../leads.service';
import { LeadAdsGraphService } from './lead-ads-graph.service';
import { MetaWebhookDto } from './dto/meta-webhook.dto';

/**
 * Webhook de Meta (Facebook/Instagram Lead Ads) — RF-04.
 *
 * Recibe el `leadgen_id` (el webhook nunca trae los datos del formulario, solo
 * el identificador), lo resuelve contra Graph API con `LeadAdsGraphService`
 * (requiere `PAGE_ACCESS_TOKEN` con permiso `leads_retrieval`) y delega el
 * alta/deduplicación a `LeadsService.procesarLeadMeta()`. Sin el token, cada
 * lead queda logueado como "no se pudo resolver" — el CRM no se cae, pero
 * tampoco crea nada.
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

  constructor(
    private readonly config: ConfigService,
    private readonly graph: LeadAdsGraphService,
    private readonly leadsService: LeadsService,
  ) {}

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
    /* Meta exige un 200 rápido (< 3s); resolver contra Graph API es una llamada
       de red por lead y no debe demorar la respuesta al webhook — mismo
       criterio que WhatsappWebhookController.recibir(). */
    void this.procesarWebhook(payload);
    return { received: true };
  }

  /**
   * Procesa el payload ya verificado. Público (no privado) para poder probarlo
   * esperando su promesa: desde `recibir` se dispara con `void` a propósito.
   *
   * Cada `leadgen_id` va en su propio try/catch — un lead que falle al
   * resolverse contra Graph API (rate limit, formulario raro, red) no puede
   * llevarse el resto del lote, mismo criterio que
   * `WhatsappWebhookController.procesarWebhook`.
   */
  async procesarWebhook(payload: MetaWebhookDto): Promise<void> {
    const leadgenIds =
      payload.entry
        ?.flatMap(e => e.changes ?? [])
        .filter(c => c.field === 'leadgen')
        .map(c => c.value?.leadgen_id)
        .filter((id): id is string => Boolean(id)) ?? [];

    let procesados = 0;
    for (const leadgenId of leadgenIds) {
      try {
        const resuelto = await this.graph.resolverLead(leadgenId);
        if (!resuelto) {
          // LeadAdsGraphService ya logueó el motivo (sin token, error de Meta, campos ausentes).
          continue;
        }

        await this.leadsService.procesarLeadMeta({
          nombre: resuelto.nombre,
          telefono: resuelto.telefono,
          origen: resuelto.origen,
          metaLeadId: leadgenId,
          anuncioId: resuelto.anuncioId,
        });
        procesados++;
      } catch (error) {
        this.logger.error(
          `Error procesando el lead ${leadgenId} del webhook de Meta; se continúa con el resto del lote`,
          error,
        );
      }
    }

    if (procesados > 0) {
      this.logger.log(`Webhook Meta: ${procesados} lead(s) de Ads procesado(s)`);
    }
  }
}
