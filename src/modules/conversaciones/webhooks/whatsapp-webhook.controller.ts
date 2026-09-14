import { LineasWhatsappService } from '../../lineas-whatsapp/lineas-whatsapp.service';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Logger,
  ServiceUnavailableException,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';

import { TipoMensaje } from '../../../prisma/prisma-client';

import { Public } from '../../../common/decorators/public.decorator';
import { MetaSignatureGuard } from '../../../common/guards/meta-signature.guard';
import { AlertasWhatsappService } from '../../../common/whatsapp/alertas-whatsapp.service';
import { ConversacionesService } from '../conversaciones.service';
import { IngestaWhatsappService } from '../ingesta-whatsapp.service';
import {
  WhatsappContactDto,
  WhatsappMessageDto,
  WhatsappWebhookDto,
} from './dto/whatsapp-webhook.dto';

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
 * Extrae la información de la campaña de Meta Ads (Click-to-WhatsApp), si viene
 * adjunta al mensaje entrante.
 */
function extraerReferral(mensaje: WhatsappMessageDto) {
  if (!mensaje.referral) return undefined;
  return {
    origenTipo: mensaje.referral.source_type,
    anuncioId: mensaje.referral.source_id,
    titular: mensaje.referral.headline?.trim() || undefined,
    cuerpo: mensaje.referral.body?.trim() || undefined,
    origenUrl: mensaje.referral.source_url,
    imagenUrl: mensaje.referral.image_url,
  };
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
 * `MetaSignatureGuard` sobre el POST.
 */
@SkipThrottle()
@Controller('webhooks/whatsapp')
export class WhatsappWebhookController {
  private readonly logger = new Logger(WhatsappWebhookController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly conversacionesService: ConversacionesService,
    private readonly ingesta: IngestaWhatsappService,
    private readonly alertas: AlertasWhatsappService,
    private readonly lineas: LineasWhatsappService,
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
  @UseGuards(MetaSignatureGuard)
  @Post()
  /* Nest responde 201 a un POST por defecto; Meta documenta que espera **200**.
     Venía funcionando —los mensajes llegaban— pero depender de que Meta tolere
     un 2xx que su documentación no promete es apostar gratis: si algún día lo
     trata como fallo, reintenta y acaba desactivando la suscripción. */
  @HttpCode(200)
  async recibir(@Body() payload: WhatsappWebhookDto): Promise<{ received: true }> {
    // Confirmar solo después de persistir. Fallos parciales devuelven 503:
    // Meta reintenta el lote y whatsappMsgId deduplica lo ya guardado.
    await this.procesarWebhook(payload);
    return { received: true };
  }

  /** Procesa cada elemento por separado y devuelve 503 si alguno no pudo
   *  persistirse. Un número receptor desconocido NO es eso: se descarta con
   *  200, porque su reintento nunca podría entrar. */
  async procesarWebhook(payload: WhatsappWebhookDto): Promise<void> {
    let fallos = 0;
    const cambios = payload.entry?.flatMap(e => e.changes ?? []) ?? [];

    for (const cambio of cambios) {
      /* Avisos de plataforma (restricciones, baneos, estado de plantillas).
         Llegaban por estar suscritos y se descartaban sin leerlos. Van en su
         propio try/catch por el mismo motivo que los mensajes: un aviso que
         reviente no puede llevarse el resto del lote. */
      if (AlertasWhatsappService.atiende(cambio.field)) {
        try {
          await this.alertas.procesar(cambio.field, cambio.value ?? {});
        } catch (error) {
          fallos++;
          this.logger.error(`Error procesando el aviso "${cambio.field}" de WhatsApp`, error);
        }
        continue;
      }

      if (!cambio.value?.messages?.length && !cambio.value?.statuses?.length) continue;

      /* Resolver la línea receptora tiene DOS finales distintos y confundirlos
         sale caro (ver `LineasWhatsappService.desdeWebhook`):

         - excepción → fallo TRANSITORIO (la base no responde). Cuenta como
           fallo, el lote sale 503 y Meta lo reintenta hasta que entre.
         - `null`    → el número NO es nuestro. Es PERMANENTE: reintentarlo no
           lo va a arreglar nunca, así que se descarta con 200. Un 503 aquí
           sería un mensaje envenenado que acaba con Meta desactivando la
           suscripción de la app — y las cuatro líneas comparten app, así que
           se llevaría por delante también a la comercial.

         El precio de descartar es que ese mensaje se pierde, así que el aviso
         lleva TODO lo necesario para recuperarlo a mano desde el journal: el
         `phone_number_id` (que es lo que hay que dar de alta), el número legible
         y los ids de lo que se descartó. */
      const metadata = cambio.value?.metadata;
      let linea: Awaited<ReturnType<typeof this.lineas.desdeWebhook>>;
      try {
        linea = await this.lineas.desdeWebhook(metadata?.phone_number_id);
      } catch (error) {
        fallos++;
        this.logger.error('Error resolviendo la línea receptora del webhook', error);
        continue;
      }
      if (!linea) {
        const descartados = [
          ...(cambio.value?.messages ?? []).map(m => m.id ?? 'sin id'),
          ...(cambio.value?.statuses ?? []).map(e => e.id ?? 'sin id'),
        ];
        this.logger.error(
          `WhatsApp: línea receptora NO registrada en el CRM — se descarta el cambio y se responde 200 ` +
            `(phone_number_id: ${metadata?.phone_number_id ?? 'ausente'}, ` +
            `número: ${metadata?.display_phone_number ?? 'desconocido'}). ` +
            `Da de alta ese identificador en Líneas de WhatsApp. Descartado: ${descartados.join(', ') || 'nada'}`,
        );
        continue;
      }
      const lineaId = linea.id;
      let procesados = 0;
      for (const mensaje of cambio.value?.messages ?? []) {
        try {
          if (await this.procesarMensaje(cambio.value?.contacts, mensaje, lineaId)) {
            procesados++;
          }
        } catch (error) {
          fallos++;
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
          await this.conversacionesService.procesarEstadoMensaje(
            estado.id,
            estado.status,
            estado.biz_opaque_callback_data,
            lineaId,
          );
        } catch (error) {
          fallos++;
          this.logger.error(
            `Error procesando estado de mensaje (MsgId: ${estado.id}); se continúa con el resto del lote`,
            error,
          );
        }
      }
    }
    if (fallos) throw new ServiceUnavailableException('No se pudo persistir todo el webhook');
  }

  /** Persiste un mensaje entrante. Devuelve false si no es de un tipo que el CRM registre. */
  private async procesarMensaje(
    contactos: WhatsappContactDto[] | undefined,
    mensaje: WhatsappMessageDto,
    lineaId: string,
  ): Promise<boolean> {
    if (!mensaje.from || !mensaje.id) return false;
    const contacto = contactos?.find(c => c.wa_id === mensaje.from);
    const respuestaBoton = extraerRespuestaBoton(mensaje);
    const media = extraerMedia(mensaje);
    const texto = mensaje.type === 'text' ? mensaje.text?.body : respuestaBoton ?? media?.caption ?? (media ? '' : undefined);
    if (texto === undefined || texto === null) return false;
    await this.ingesta.procesarEntrante(
      `+${mensaje.from}`, texto, mensaje.id, contacto?.profile?.name?.trim() || undefined,
      media ? { tipo: media.tipo, mediaId: media.mediaId, mime: media.mime, nombre: media.nombre } : undefined, extraerReferral(mensaje), Boolean(respuestaBoton), lineaId,
    );
    return true;
  }
}
