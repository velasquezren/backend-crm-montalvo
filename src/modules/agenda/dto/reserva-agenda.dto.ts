import { IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { FECHA_AGENDA, HORA_AGENDA } from '../agenda.contrato';

/** Mismos límites que las columnas de `para_agendar`. */
export class CrearReservaAgendaDto {
  @IsString() @Matches(/^\d{1,10}$/)
  medicoId!: string;

  @IsString() @Matches(FECHA_AGENDA)
  fecha!: string;

  @IsString() @Matches(HORA_AGENDA)
  hora!: string;

  @IsString() @Length(3, 200)
  nombre!: string;

  /** Celular de Bolivia; se guarda como 8 dígitos. */
  @IsString() @Matches(/^(?:\+?591)?\s*[67]\d{7}$/)
  telefono!: string;

  @IsString() @Matches(/^[\p{L}\p{N}][\p{L}\p{N} .-]{2,24}$/u)
  ci!: string;

  @IsOptional() @IsString() @MaxLength(500)
  observaciones?: string;

  /** Campo trampa: las personas no lo ven; un bot que lo rellena no reserva. */
  @IsOptional() @IsString() @MaxLength(0)
  sitio?: string;
}

/** Campos de texto que acompañan al comprobante (multipart). */
export class PagoReservaAgendaDto {
  @IsString() @MaxLength(200)
  referencia!: string;

  @IsOptional() @IsString() @Matches(/^[0-9-]{0,20}$/)
  nit?: string;

  @IsOptional() @IsString() @MaxLength(100)
  razonSocial?: string;
}
