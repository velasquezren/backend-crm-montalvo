/** Contrato de la API independiente de Resultados; no es un enum de la BD CRM. */
export const TIPOS_INFORME = ['ECOGRAFIA', 'PAPANICOLAU', 'LABORATORIO', 'OTRO'] as const;
export type TipoInforme = (typeof TIPOS_INFORME)[number];
