import { IsIn, IsOptional } from 'class-validator';

/**
 * El periodo se elige por NOMBRE y lo resuelve el servidor, no por fechas
 * libres: «este mes» es un corte de calendario en la zona de la clínica, y
 * calcularlo en el navegador de cada agente daba tantos «este mes» como
 * relojes. Además, un `desde` inválido llegaba crudo a `new Date()` y a
 * Prisma, y salía un 500 donde tocaba un 400.
 */
export const PERIODOS_KPI = ['MES', 'MES_ANTERIOR', 'TRES_MESES'] as const;
export type PeriodoKpi = (typeof PERIODOS_KPI)[number];

export class QueryKpisDto {
  @IsOptional()
  @IsIn(PERIODOS_KPI)
  periodo?: PeriodoKpi;
}
