import { ClasifComision, NivelPlan, TipoVendedora, UnidadNegocio } from '@prisma/client';

/**
 * Valores iniciales de la planilla de comisiones, tomados del documento de
 * negocio. Se siembran una sola vez (ver `asegurarConfiguracion`) y a partir de
 * ahí **manda la base de datos**: administración los edita desde el panel y
 * este archivo no vuelve a pisarlos.
 */

/** Claves de `ParametroComision`, para no repetir literales por el código. */
export const PARAM = {
  IVA: 'IVA',
  FACTOR_BONO_JEFATURA: 'FACTOR_BONO_JEFATURA',
  FACTOR_BONO_TRIMESTRAL: 'FACTOR_BONO_TRIMESTRAL',
  PCT_TIPO_C_RA: 'PCT_TIPO_C_RA',
  MESES_BONO_TRIMESTRAL: 'MESES_BONO_TRIMESTRAL',
} as const;

export const PARAMETROS_POR_DEFECTO: ReadonlyArray<{
  clave: string;
  valor: number;
  descripcion: string;
}> = [
  { clave: PARAM.IVA, valor: 0.13, descripcion: 'Impuesto descontado del precio antes de comisionar (13%)' },
  { clave: PARAM.FACTOR_BONO_JEFATURA, valor: 0.002, descripcion: 'Factor del bono mensual de jefatura sobre el excedente del objetivo' },
  { clave: PARAM.FACTOR_BONO_TRIMESTRAL, valor: 0.005, descripcion: 'Factor del bono trimestral sobre el promedio de 3 meses' },
  { clave: PARAM.PCT_TIPO_C_RA, valor: 0, descripcion: 'Comisión Tipo C de ventas del área RA para ejecutivas (0%: solo cobran las coordinadoras RA)' },
  { clave: PARAM.MESES_BONO_TRIMESTRAL, valor: 3, descripcion: 'Meses que promedia el bono trimestral' },
];

/** TIPO A — planes de maternidad por nivel, y planes varios (PLANNIN). */
export const TARIFAS_PLAN_POR_DEFECTO: ReadonlyArray<{
  clave: string;
  pctEmpresa: number;
  pctPropio: number;
}> = [
  { clave: NivelPlan.BRONCE, pctEmpresa: 1.0, pctPropio: 2.0 },
  { clave: NivelPlan.SILVER, pctEmpresa: 2.0, pctPropio: 4.0 },
  { clave: NivelPlan.GOLD, pctEmpresa: 3.0, pctPropio: 5.0 },
  { clave: 'PLANNIN', pctEmpresa: 3.0, pctPropio: 5.0 },
];

/** TIPO C — consultas, laboratorios, ecografías y otros servicios. */
export const TARIFAS_SERVICIO_POR_DEFECTO: ReadonlyArray<{
  clasif: ClasifComision;
  pctEmpresa: number;
  pctPropio: number;
}> = [
  { clasif: ClasifComision.CONSULTA, pctEmpresa: 4.5, pctPropio: 5.5 },
  { clasif: ClasifComision.LAB, pctEmpresa: 4.5, pctPropio: 5.5 },
  { clasif: ClasifComision.ECOGRAFIA, pctEmpresa: 4.5, pctPropio: 5.5 },
  { clasif: ClasifComision.OTROSS, pctEmpresa: 4.5, pctPropio: 5.5 },
  { clasif: ClasifComision.CAMPANA, pctEmpresa: 0, pctPropio: 0 },
  { clasif: ClasifComision.PROMOCION, pctEmpresa: 0, pctPropio: 0 },
];

/**
 * TIPO B (ejecutivas) — escala por monto ACUMULADO de cirugías del mes.
 * El nivel se resuelve con el acumulado total y luego se aplica a todas las
 * cirugías de esa vendedora. Por debajo del nivel 1 no hay comisión.
 */
export const NIVELES_CIRUGIA_POR_DEFECTO: ReadonlyArray<{
  nivel: number;
  montoDesde: number;
  montoHasta: number;
  pctEmpresa: number;
  pctPropio: number;
}> = [
  { nivel: 1, montoDesde: 1000, montoHasta: 5000, pctEmpresa: 1.0, pctPropio: 1.5 },
  { nivel: 2, montoDesde: 5000, montoHasta: 10000, pctEmpresa: 1.5, pctPropio: 2.0 },
  { nivel: 3, montoDesde: 10000, montoHasta: 15000, pctEmpresa: 2.5, pctPropio: 3.0 },
  { nivel: 4, montoDesde: 15000, montoHasta: 22000, pctEmpresa: 3.0, pctPropio: 3.5 },
  { nivel: 5, montoDesde: 22000, montoHasta: 30000, pctEmpresa: 3.5, pctPropio: 4.0 },
  { nivel: 6, montoDesde: 30000, montoHasta: 40000, pctEmpresa: 4.0, pctPropio: 4.5 },
  { nivel: 7, montoDesde: 40000, montoHasta: 99999999, pctEmpresa: 4.5, pctPropio: 5.0 },
];

/**
 * TIPO B (coordinadoras RA) — tarifa fija en USD por procedimiento.
 * Los montos "propio" salen de `redondearArriba(empresa / 0.7)`, según la
 * regla de negocio. `esPorcentaje` marca la única fila que no es USD fijo.
 */
export const TARIFAS_RA_POR_DEFECTO: ReadonlyArray<{
  procedimiento: string;
  montoEmpresa: number;
  montoPropio: number;
  esPorcentaje: boolean;
}> = [
  { procedimiento: 'Aspiración de Óvulos / ICSI', montoEmpresa: 20, montoPropio: 29, esPorcentaje: false },
  { procedimiento: 'Biopsia Embrionaria', montoEmpresa: 10, montoPropio: 15, esPorcentaje: false },
  { procedimiento: 'Congelamiento de embriones', montoEmpresa: 5, montoPropio: 8, esPorcentaje: false },
  { procedimiento: 'Histeroscopia (Bettocchi)', montoEmpresa: 5, montoPropio: 8, esPorcentaje: false },
  { procedimiento: 'Inseminación', montoEmpresa: 5, montoPropio: 8, esPorcentaje: false },
  { procedimiento: 'Laboratorios RA (Etapa I)', montoEmpresa: 1.0, montoPropio: 1.43, esPorcentaje: true },
  { procedimiento: 'Laparoscopia + Histeroscopia', montoEmpresa: 10, montoPropio: 15, esPorcentaje: false },
  { procedimiento: 'Miomectomía y otras', montoEmpresa: 10, montoPropio: 15, esPorcentaje: false },
  { procedimiento: 'Transferencias Especiales', montoEmpresa: 20, montoPropio: 29, esPorcentaje: false },
  { procedimiento: 'NA (Rejuvenecimiento, Curetaje, etc.)', montoEmpresa: 0, montoPropio: 0, esPorcentaje: false },
];

/** Objetivos mínimos: gatillan la comisión Tipo A y los bonos. */
export const OBJETIVOS_POR_DEFECTO: ReadonlyArray<{
  tipo: TipoVendedora;
  planesMinimos: number;
  montoMensualUsd: number;
  montoTrimestralUsd: number;
}> = [
  { tipo: TipoVendedora.VENDEDORA, planesMinimos: 4, montoMensualUsd: 12000, montoTrimestralUsd: 15000 },
  { tipo: TipoVendedora.JEFA, planesMinimos: 6, montoMensualUsd: 15000, montoTrimestralUsd: 15000 },
];

/**
 * Diccionario inicial `detalle` → clasificación (sección 8.5 del documento).
 *
 * `prioridad` baja = se evalúa antes. Se usan prioridades 10-40 para los casos
 * que deben ganarle a los heurísticos y 100+ para los que solo confirman lo que
 * el motor ya deduce.
 */
export const REGLAS_POR_DEFECTO: ReadonlyArray<{
  patron: string;
  exacto: boolean;
  modulo: string | null;
  clasif: ClasifComision;
  nivel: NivelPlan | null;
  unidadNegocio: UnidadNegocio | null;
  prioridad: number;
  notas: string | null;
}> = [
  /* ── Excepciones que deben ganarle al heurístico ─────────────────────── */
  {
    patron: 'Frecuencia cardiaca fetal',
    exacto: false,
    modulo: 'CONSULTA',
    clasif: ClasifComision.OTROSS,
    nivel: null,
    unidadNegocio: null,
    prioridad: 10,
    notas: 'El catálogo lo lista como OTROSS aunque el nombre contiene "doppler" (que por sí solo daría ECOGRAFIA).',
  },
  {
    patron: 'CONTROL POST QX',
    exacto: false,
    modulo: null,
    clasif: ClasifComision.OTROSS,
    nivel: null,
    unidadNegocio: null,
    prioridad: 15,
    notas: 'No comisiona cuando el precio es 0 (se excluye por precio).',
  },

  /* ── Procedimientos del área de Reproducción Asistida ────────────────── */
  { patron: 'Aspiración de Óvulos', exacto: false, modulo: null, clasif: ClasifComision.CIRUGIA, nivel: null, unidadNegocio: UnidadNegocio.RA, prioridad: 20, notas: 'RA — solo cobran las coordinadoras.' },
  { patron: 'ICSI', exacto: false, modulo: null, clasif: ClasifComision.CIRUGIA, nivel: null, unidadNegocio: UnidadNegocio.RA, prioridad: 20, notas: 'RA' },
  { patron: 'Biopsia Embrionaria', exacto: false, modulo: null, clasif: ClasifComision.CIRUGIA, nivel: null, unidadNegocio: UnidadNegocio.RA, prioridad: 20, notas: 'RA' },
  { patron: 'Congelamiento de embriones', exacto: false, modulo: null, clasif: ClasifComision.CIRUGIA, nivel: null, unidadNegocio: UnidadNegocio.RA, prioridad: 20, notas: 'RA' },
  { patron: 'Inseminación', exacto: false, modulo: null, clasif: ClasifComision.CIRUGIA, nivel: null, unidadNegocio: UnidadNegocio.RA, prioridad: 20, notas: 'RA' },
  { patron: 'Transferencia', exacto: false, modulo: null, clasif: ClasifComision.CIRUGIA, nivel: null, unidadNegocio: UnidadNegocio.RA, prioridad: 20, notas: 'RA — transferencias especiales.' },

  /* ── Cirugías generales (Tipo B, ejecutivas) ─────────────────────────── */
  { patron: 'Histeroscopia', exacto: false, modulo: null, clasif: ClasifComision.CIRUGIA, nivel: null, unidadNegocio: null, prioridad: 40, notas: null },
  { patron: 'Laparoscopia', exacto: false, modulo: null, clasif: ClasifComision.CIRUGIA, nivel: null, unidadNegocio: null, prioridad: 40, notas: null },
  { patron: 'Miomectomia', exacto: false, modulo: null, clasif: ClasifComision.CIRUGIA, nivel: null, unidadNegocio: null, prioridad: 40, notas: null },

  /* ── Confirmaciones del catálogo (sección 8.5) ───────────────────────── */
  { patron: 'Papanicolaou', exacto: false, modulo: null, clasif: ClasifComision.OTROSS, nivel: null, unidadNegocio: null, prioridad: 100, notas: 'Otros servicios' },
  { patron: 'Papanicolau', exacto: false, modulo: null, clasif: ClasifComision.OTROSS, nivel: null, unidadNegocio: null, prioridad: 100, notas: 'Variante sin la o' },
  { patron: 'RX Histerosalpingografia', exacto: false, modulo: null, clasif: ClasifComision.OTROSS, nivel: null, unidadNegocio: null, prioridad: 100, notas: null },
  { patron: 'Electrocardiograma', exacto: false, modulo: null, clasif: ClasifComision.OTROSS, nivel: null, unidadNegocio: null, prioridad: 100, notas: null },
  { patron: 'Internación', exacto: false, modulo: null, clasif: ClasifComision.OTROSS, nivel: null, unidadNegocio: null, prioridad: 100, notas: 'Se agrupa con otros servicios' },
  { patron: 'Valoración Cardiológica', exacto: false, modulo: null, clasif: ClasifComision.CONSULTA, nivel: null, unidadNegocio: null, prioridad: 100, notas: null },
  { patron: 'Paquete Bariatrica', exacto: false, modulo: null, clasif: ClasifComision.PLANNIN, nivel: null, unidadNegocio: UnidadNegocio.VARIOS, prioridad: 100, notas: 'Paquete especial, no maternidad' },
  { patron: 'Paquete Niño Sano', exacto: false, modulo: null, clasif: ClasifComision.PLANNIN, nivel: null, unidadNegocio: UnidadNegocio.VARIOS, prioridad: 100, notas: 'Paquete especial, no maternidad' },
];
