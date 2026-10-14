import { IsBoolean, IsOptional } from 'class-validator';

/** «Listo» en el chat: resuelve y, si se pide, devuelve las respuestas automáticas en el mismo paso. */
export class ResolverAtencionDto {
  @IsOptional()
  @IsBoolean()
  reanudar?: boolean;
}
