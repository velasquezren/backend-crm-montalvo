import { Type } from 'class-transformer';
import { IsArray, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';

/**
 * Validación perimetral del webhook de WhatsApp Cloud API.
 * Estructura: { entry: [{ changes: [{ value: { messages: [{ from, id, text: { body } }] } }] }] }
 *
 * Se modelan solo los campos que el CRM usa. Meta envía muchos más
 * (metadata, statuses, pricing…) y añade nuevos con el tiempo, por eso estos
 * webhooks NO usan `forbidNonWhitelisted`: rechazar el payload por un campo
 * desconocido haría que Meta desactive la suscripción tras varios fallos.
 * Ver el pipe declarado en whatsapp-webhook.controller.ts.
 */
export class WhatsappTextDto {
  @IsOptional()
  @IsString()
  body?: string;
}

/** Objeto de media entrante (image/document/audio/video/sticker). */
export class WhatsappMediaDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  mime_type?: string;

  /** Solo documentos. */
  @IsOptional()
  @IsString()
  filename?: string;

  /** Pie de foto (image/video/document). */
  @IsOptional()
  @IsString()
  caption?: string;
}

/**
 * Respuesta a un botón de RESPUESTA RÁPIDA de una plantilla (`type: 'button'`).
 * Meta manda el texto del botón que tocó el cliente en `text` (y lo duplica en
 * `payload`). Es la respuesta que antes se perdía: el cliente toca "Confirmar"
 * en la plantilla y esa respuesta no llegaba al CRM.
 */
export class WhatsappButtonDto {
  @IsOptional()
  @IsString()
  text?: string;

  @IsOptional()
  @IsString()
  payload?: string;
}

/** Cuerpo de un botón/opción interactiva pulsada (button_reply / list_reply). */
export class WhatsappInteractiveReplyDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;
}

/**
 * Respuesta a un mensaje INTERACTIVO (`type: 'interactive'`): botones de
 * respuesta (`button_reply`) o selección de lista (`list_reply`). El texto que
 * eligió el cliente viene en `.title`.
 */
export class WhatsappInteractiveDto {
  /** 'button_reply' | 'list_reply' */
  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => WhatsappInteractiveReplyDto)
  button_reply?: WhatsappInteractiveReplyDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => WhatsappInteractiveReplyDto)
  list_reply?: WhatsappInteractiveReplyDto;
}

/**
 * Contexto de campaña publicitaria / anuncio de Meta (Click-to-WhatsApp Ads).
 * Llega cuando el paciente hace clic en un anuncio de Facebook/Instagram y abre el chat.
 */
export class WhatsappReferralDto {
  @IsOptional()
  @IsString()
  source_url?: string;

  /** 'ad' | 'post' */
  @IsOptional()
  @IsString()
  source_type?: string;

  /** ID del anuncio de Meta Ads */
  @IsOptional()
  @IsString()
  source_id?: string;

  /** Titular del anuncio publicitario */
  @IsOptional()
  @IsString()
  headline?: string;

  /** Cuerpo o descripción del anuncio */
  @IsOptional()
  @IsString()
  body?: string;

  /** 'image' | 'video' */
  @IsOptional()
  @IsString()
  media_type?: string;

  @IsOptional()
  @IsString()
  image_url?: string;

  @IsOptional()
  @IsString()
  video_url?: string;

  @IsOptional()
  @IsString()
  thumbnail_url?: string;

  @IsOptional()
  @IsString()
  ctwa_clid?: string;
}

export class WhatsappMessageDto {
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  id?: string;

  /** 'text' | 'image' | 'document' | 'audio' | 'video' | 'sticker' | 'button' | 'interactive' | … */
  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => WhatsappTextDto)
  text?: WhatsappTextDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => WhatsappMediaDto)
  image?: WhatsappMediaDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => WhatsappMediaDto)
  document?: WhatsappMediaDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => WhatsappMediaDto)
  audio?: WhatsappMediaDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => WhatsappMediaDto)
  video?: WhatsappMediaDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => WhatsappMediaDto)
  sticker?: WhatsappMediaDto;

  /** Respuesta a un botón de respuesta rápida de plantilla (`type: 'button'`). */
  @IsOptional()
  @ValidateNested()
  @Type(() => WhatsappButtonDto)
  button?: WhatsappButtonDto;

  /** Respuesta a botones interactivos / listas (`type: 'interactive'`). */
  @IsOptional()
  @ValidateNested()
  @Type(() => WhatsappInteractiveDto)
  interactive?: WhatsappInteractiveDto;

  /** Procedencia del anuncio si el paciente entró desde una campaña de Meta Ads. */
  @IsOptional()
  @ValidateNested()
  @Type(() => WhatsappReferralDto)
  referral?: WhatsappReferralDto;
}

/** Perfil del remitente: trae el nombre real con el que se da de alta al cliente. */
export class WhatsappProfileDto {
  @IsOptional()
  @IsString()
  name?: string;
}

export class WhatsappContactDto {
  @IsOptional()
  @IsString()
  wa_id?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => WhatsappProfileDto)
  profile?: WhatsappProfileDto;
}

/** Confirmación de entrega/lectura de un mensaje SALIENTE nuestro (ticks de WhatsApp). */
/** Detalle del fallo que Meta adjunta cuando `status === 'failed'`. */
export class WhatsappStatusErrorDto {
  @IsOptional()
  @IsNumber()
  code?: number;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  message?: string;
}

export class WhatsappStatusDto {
  /** El mismo id que Meta devolvió al enviar — así se correlaciona con `Mensaje.whatsappMsgId`. */
  @IsOptional()
  @IsString()
  id?: string;

  /** 'sent' | 'delivered' | 'read' | 'failed' */
  @IsOptional()
  @IsString()
  status?: string;

  /** Presente solo cuando el envío falló; alimenta el log de diagnóstico. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WhatsappStatusErrorDto)
  errors?: WhatsappStatusErrorDto[];
}

/** Restricción concreta que Meta impuso a la cuenta (`ACCOUNT_RESTRICTION`). */
export class WhatsappRestriccionDto {
  /** p. ej. `RESTRICTED_BIZ_INITIATED_MESSAGING` — no se pueden iniciar conversaciones. */
  @IsOptional()
  @IsString()
  restriction_type?: string;

  /** Unix timestamp en el que caduca la restricción. */
  @IsOptional()
  @IsNumber()
  expiration?: number;
}

/** Motivo de la violación de políticas (`ACCOUNT_VIOLATION`). */
export class WhatsappViolacionDto {
  @IsOptional()
  @IsString()
  violation_type?: string;
}

/** Estado del baneo de la cuenta (`DISABLED_UPDATE`). */
export class WhatsappBanDto {
  @IsOptional()
  @IsString()
  waba_ban_state?: string;

  @IsOptional()
  @IsString()
  waba_ban_date?: string;
}

export class WhatsappValueDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WhatsappContactDto)
  contacts?: WhatsappContactDto[];

  /* ── Campos de los avisos de plataforma ────────────────────────────────────
     Los comparten `account_update`, `phone_number_quality_update` y
     `message_template_status_update`; cuál viene relleno lo dice `change.field`.

     Van declarados porque el ValidationPipe global corre con `whitelist: true`:
     un campo sin decorador NO llega a medias, se descarta entero (ver la regla
     en el skill crm-backend-module). */

  /** ACCOUNT_RESTRICTION | ACCOUNT_VIOLATION | DISABLED_UPDATE | APPROVED | REJECTED | … */
  @IsOptional()
  @IsString()
  event?: string;

  @IsOptional()
  @IsString()
  display_phone_number?: string;

  /** Nivel de throughput/límite tras el cambio (TIER_250, TIER_2K…). */
  @IsOptional()
  @IsString()
  current_limit?: string;

  @IsOptional()
  @IsString()
  max_daily_conversations_per_business?: string;

  /** Nombre de la plantilla en `message_template_status_update`. */
  @IsOptional()
  @IsString()
  message_template_name?: string;

  /** Motivo del rechazo de una plantilla. */
  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WhatsappRestriccionDto)
  restriction_info?: WhatsappRestriccionDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => WhatsappViolacionDto)
  violation_info?: WhatsappViolacionDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => WhatsappBanDto)
  ban_info?: WhatsappBanDto;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WhatsappMessageDto)
  messages?: WhatsappMessageDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WhatsappStatusDto)
  statuses?: WhatsappStatusDto[];
}

export class WhatsappChangeDto {
  @IsOptional()
  @IsString()
  field?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => WhatsappValueDto)
  value?: WhatsappValueDto;
}

export class WhatsappEntryDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WhatsappChangeDto)
  changes?: WhatsappChangeDto[];
}

export class WhatsappWebhookDto {
  @IsOptional()
  @IsString()
  object?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WhatsappEntryDto)
  entry?: WhatsappEntryDto[];
}
