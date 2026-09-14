import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";

export class ActualizarLineaDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  nombre?: string;
  @IsOptional()
  @Matches(/^\+[1-9]\d{7,14}$/)
  telefono?: string;
  @IsOptional()
  @Matches(/^\d{1,80}$/)
  phoneNumberId?: string;
  @IsOptional()
  @Matches(/^\d{1,80}$/)
  wabaId?: string;
  @IsOptional()
  @Matches(/^WHATSAPP_[A-Z0-9_]*TOKEN$/)
  @MaxLength(100)
  tokenEnv?: string;
  @IsOptional()
  @IsBoolean()
  activa?: boolean;
}
