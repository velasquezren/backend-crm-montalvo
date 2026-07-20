import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';

/**
 * Validación perimetral del webhook de WhatsApp Cloud API.
 * Estructura: { entry: [{ changes: [{ value: { messages: [{ from, id, text: { body } }] } }] }] }
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

export class WhatsappValueDto {
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
