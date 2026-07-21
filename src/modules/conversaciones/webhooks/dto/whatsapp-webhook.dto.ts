import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';

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

export class WhatsappMessageDto {
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => WhatsappTextDto)
  text?: WhatsappTextDto;
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

export class WhatsappValueDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WhatsappContactDto)
  contacts?: WhatsappContactDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WhatsappMessageDto)
  messages?: WhatsappMessageDto[];
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
