import { IsUUID, ValidateIf } from 'class-validator';

/**
 * Corrección del lead de origen de una venta ya registrada.
 *
 * `null` es un valor legítimo, no una ausencia: es como se quita una atribución
 * equivocada. Por eso `@ValidateIf` en vez de `@IsOptional()` — este último
 * también deja pasar el campo ausente, y entonces un `PATCH {}` por un error de
 * tipeo en el cliente borraría la atribución en silencio en lugar de dar 400.
 */
export class CorregirOrigenDto {
  @ValidateIf(o => o.leadId !== null)
  @IsUUID()
  leadId!: string | null;
}
