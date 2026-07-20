import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';

/**
 * Validación perimetral del webhook de Meta (CRM_MANIFESTO.md §1.1):
 * solo se aceptan los campos que usamos; el resto se descarta con whitelist.
 * Estructura según Graph API leadgen:
 * { object, entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id, ... } }] }] }
 */
export class MetaLeadgenValueDto {
  @IsOptional()
  @IsString()
  leadgen_id?: string;

  @IsOptional()
  @IsString()
  page_id?: string;

  @IsOptional()
  @IsString()
  form_id?: string;
}

export class MetaChangeDto {
  @IsOptional()
  @IsString()
  field?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MetaLeadgenValueDto)
  value?: MetaLeadgenValueDto;
}

export class MetaEntryDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MetaChangeDto)
  changes?: MetaChangeDto[];
}

export class MetaWebhookDto {
  @IsOptional()
  @IsString()
  object?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MetaEntryDto)
  entry?: MetaEntryDto[];
}
