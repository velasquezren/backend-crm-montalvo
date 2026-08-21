import { IsUUID, ValidateIf } from 'class-validator';

/**
 * Asignar o desasignar el agente de un lead. `agenteId: null` desasigna.
 *
 * El campo es **obligatorio**: con `@IsOptional()` un body `{}` pasaba la
 * validación, llegaba como `undefined` y Prisma lo interpreta como «no
 * cambiar», así que la petición respondía 200 sin haber hecho nada. Una API
 * que dice que sí y no hace nada es peor que una que devuelve 400.
 *
 * `@ValidateIf` en vez de `@IsOptional()` porque hay que distinguir los dos:
 * `null` es una orden (desasignar) y se deja pasar; `undefined` es un campo
 * que falta y cae en `@IsUUID`, que lo rechaza.
 */
export class AsignarAgenteLeadDto {
  @ValidateIf((_objeto, valor) => valor !== null)
  @IsUUID()
  agenteId!: string | null;
}
