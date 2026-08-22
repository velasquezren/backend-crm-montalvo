import {
  AreaVendedora,
  CanalVenta,
  ClasifComision,
  NivelPlan,
  TipoVendedora,
  UnidadNegocio,
} from '@prisma/client';

/**
 * Valores iniciales de la planilla de comisiones, tomados del documento de
 * negocio. Se siembran una sola vez (ver `asegurarConfiguracion`) y a partir de
 * ahí **manda la base de datos**: administración los edita desde el panel y
 * este archivo no vuelve a pisarlos.
 */

/**
 * Tipo de cambio de referencia de la clínica (Bs por dólar).
 *
 * Solo se usa cuando todavía no hay ningún periodo importado del que leerlo. El
 * TC real de cada mes vive en `PeriodoComision.tipoCambio`, que es con el que se
 * liquidó, y es el que sirve `tipoCambioVigente()`.
 */
export const TIPO_CAMBIO_POR_DEFECTO = 6.97;

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
  { clave: PARAM.PCT_TIPO_C_RA, valor: 0, descripcion: 'Comisión Tipo C de campañas y promociones del área RA (0%: el resto del área RA — consulta/lab/ecografía/otros — comisiona por NIVELES_TIPO_A_RA, no por este parámetro)' },
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
 *
 * Son SEIS niveles y el último llega hasta 40.000, tal como la planilla. Hubo
 * un nivel 7 (40.000 en adelante, 4,5%/5%) que no existe en ella: era una
 * extrapolación nuestra que pagaba de más a quien superara el último tramo.
 * Por encima de 40.000 se aplica el nivel 6, que es lo que la planilla hace.
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
];

/**
 * TIPO A (RA) — escala por el EXCEDENTE sobre `MONTOBJETIVO` (el objetivo
 * mensual en $ de `ObjetivoComision`, no el de cantidad de planes) de la suma
 * de ingreso neto de planes de maternidad + ventas RA no-cirugía. El % sale
 * de aquí y se aplica solo a la porción RA de esa suma.
 *
 * Tabla APARTE de `NIVELES_CIRUGIA_POR_DEFECTO`: en la planilla de
 * administración (`CALCULO COMISION DICIEMBRE 2025.xlsx`, hoja PARAMETROS,
 * filas 58-64 "TOTAL RA Y CIRUGIAS" y 70-83 "CIRUGIA") son dos tablas
 * copiadas por separado, y en diciembre 2025 coinciden en cada valor — pero
 * nada obliga a que sigan coincidiendo si administración cambia una.
 *
 * ⚠️ La propia planilla trae un comentario de administración en la celda
 * `PARAMETROS!A58`: "NO SE DEFINIÓ CÓMO DETERMINAR EL NIVEL EN PAGO TIPO A,
 * EJEMPLO CLAUDIA CANEDO". Esta tabla replica la fórmula real de
 * `BDEjecutivas` (columnas AT-BD), pero ni la clínica la da por cerrada.
 */
export const NIVELES_TIPO_A_RA_POR_DEFECTO: ReadonlyArray<{
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
  /* 1 % en los dos canales: la planilla no aplica aquí la regla del ÷0,7
     (`Parametro RA`, filas 53-54: LAboratoriosCLINICA 0,01 y LAboratoriosPROPIA 0,01). */
  { procedimiento: 'Laboratorios RA (Etapa I)', montoEmpresa: 1.0, montoPropio: 1.0, esPorcentaje: true },
  { procedimiento: 'Laparoscopia + Histeroscopia', montoEmpresa: 10, montoPropio: 15, esPorcentaje: false },
  { procedimiento: 'Miomectomía y otras', montoEmpresa: 10, montoPropio: 15, esPorcentaje: false },
  { procedimiento: 'Transferencias Especiales', montoEmpresa: 20, montoPropio: 29, esPorcentaje: false },
  { procedimiento: 'NA (Rejuvenecimiento, Curetaje, etc.)', montoEmpresa: 0, montoPropio: 0, esPorcentaje: false },
];

/**
 * Objetivos mínimos. Ojo con la semántica: **hay que superarlos, no igualarlos**.
 * Solo los planes por encima del objetivo comisionan (ver `liquidarVendedora`).
 * En diciembre 2024 una vendedora hizo exactamente 4 PLANPAQ con objetivo 4 y
 * cobró cero por Tipo A.
 *
 * Son objetivos separados por tipo de plan (`PLANPAQTVENDEDORA`, `PLANNINVENDEDORA`
 * en la hoja "Hoja1 (2)" de la planilla). El objetivo de monto es el que gatilla
 * el bono de jefatura, y es independiente de los de cantidad.
 */
export const OBJETIVOS_POR_DEFECTO: ReadonlyArray<{
  tipo: TipoVendedora;
  planpaqMinimos: number;
  planninMinimos: number;
  montoMensualUsd: number;
  montoTrimestralUsd: number;
}> = [
  { tipo: TipoVendedora.VENDEDORA, planpaqMinimos: 4, planninMinimos: 1, montoMensualUsd: 12000, montoTrimestralUsd: 15000 },
  { tipo: TipoVendedora.JEFA, planpaqMinimos: 6, planninMinimos: 1, montoMensualUsd: 15000, montoTrimestralUsd: 15000 },
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
  { patron: 'Internación', exacto: false, modulo: null, clasif: ClasifComision.CIRUGIA, nivel: null, unidadNegocio: null, prioridad: 100, notas: 'Cirugía: verificado contra la planilla de diciembre 2025 — el Tipo B de cada vendedora es exactamente el neto de sus internaciones' },
  { patron: 'Valoración Cardiológica', exacto: false, modulo: null, clasif: ClasifComision.CONSULTA, nivel: null, unidadNegocio: null, prioridad: 100, notas: null },
  /* Los paquetes bariátricos son cirugía y van por Tipo B: en la planilla de
     administración «Manga Gastrica» y «By Pass Gastrico» están clasificados
     CIRUGIA aunque la columna de origen los llame «Paquete». */
  { patron: 'Paquete Bariatrica', exacto: false, modulo: null, clasif: ClasifComision.CIRUGIA, nivel: null, unidadNegocio: UnidadNegocio.VARIOS, prioridad: 30, notas: 'Cirugia bariatrica (Tipo B), pese a venir como paquete' },
  { patron: 'Manga Gastrica', exacto: false, modulo: null, clasif: ClasifComision.CIRUGIA, nivel: null, unidadNegocio: UnidadNegocio.VARIOS, prioridad: 30, notas: 'Cirugia bariatrica' },
  { patron: 'By Pass Gastrico', exacto: false, modulo: null, clasif: ClasifComision.CIRUGIA, nivel: null, unidadNegocio: UnidadNegocio.VARIOS, prioridad: 30, notas: 'Cirugia bariatrica' },
  { patron: 'Paquete Niño Sano', exacto: false, modulo: null, clasif: ClasifComision.PLANNIN, nivel: null, unidadNegocio: UnidadNegocio.VARIOS, prioridad: 100, notas: 'Paquete especial, no maternidad' },
];

/**
 * Mapeo inicial de `captacion` → canal. Se siembra en `MapeoCaptacion` la primera
 * vez y a partir de ahí manda la base: administración lo edita.
 *
 * `FACEBOOK` va a EMPRESA a propósito, no por descuido: en la planilla de la
 * clínica una venta llegada por Facebook cobra la tarifa de empresa (un plan
 * Gold por Facebook pagó 3%, que es la tasa empresa, no el 5% de propio).
 */
export const CAPTACION_POR_DEFECTO: ReadonlyArray<{ valor: string; canal: CanalVenta }> = [
  /* Lo único que es venta PROPIA: contacto conseguido por la vendedora fuera
     de la clínica y con sus propios recursos. */
  { valor: 'PROPIO', canal: CanalVenta.PROPIO },
  { valor: 'PROPIA', canal: CanalVenta.PROPIO },

  /* Todo lo demás es recurso de la empresa. No es una suposición: está escrito
     en la planilla ("CALCULO COMISION DICIEMBRE 2024.xlsx", hoja `Hoja1 (2)`,
     fila 24): «Se considera RE cualquier contacto generado con recursos de la
     empresa, por ejemplo: pacientes de clínica, RRSS, ferias, brunch de mamás,
     talleres formativos». REDES son las RRSS de la clínica, y RAMADA y EXPOBEBE
     son ferias. */
  { valor: 'CLINICA', canal: CanalVenta.EMPRESA },
  { valor: 'REDES', canal: CanalVenta.EMPRESA },
  { valor: 'FACEBOOK', canal: CanalVenta.EMPRESA },
  { valor: 'INSTAGRAM', canal: CanalVenta.EMPRESA },
  { valor: 'RAMADA', canal: CanalVenta.EMPRESA },
  { valor: 'EXPOBEBE', canal: CanalVenta.EMPRESA },
  { valor: 'EXPO BEBE', canal: CanalVenta.EMPRESA },
];


/**
 * El equipo comercial oficial, tal como lo declara la hoja `PARAMETROS` de la
 * planilla de administración (columnas VENDEDORA / TIPO DE VENDEDOR / AREA DE
 * VENTA, filas 2-11 del archivo de diciembre 2025).
 *
 * Existe porque las vendedoras se dan de alta SOLAS al importar el Excel, con
 * los valores por defecto del modelo: VENDEDORA / EJECUTIVA. Eso dejaba a
 * Viviana con objetivo de 4 planes y 12.000 cuando es JEFA y le tocan 6 y
 * 15.000, y hacía que el bono de jefatura no encontrara a quién pagarle.
 *
 * Los códigos son los `vendedora_pk` reales que aparecen en los export de
 * octubre, noviembre y diciembre de 2025.
 *
 * **Quien no está aquí no comisiona hasta que administración lo revise.** No es
 * un descarte silencioso: se da de alta igual, queda con `configurada: false` y
 * el cálculo avisa por log. El caso real es Gizelle Praciano — vendió 5.825 USD
 * de internaciones en noviembre y diciembre y no aparece en ninguna planilla de
 * pago.
 */
export const EQUIPO_OFICIAL: ReadonlyArray<{
  codigo: string;
  nombre: string;
  tipo: TipoVendedora;
  area: AreaVendedora;
}> = [
  {
    codigo: 'Pe1342',
    nombre: 'Guzman Flores Viviana',
    tipo: TipoVendedora.JEFA,
    area: AreaVendedora.EJECUTIVA,
  },
  {
    codigo: 'Pe1535',
    nombre: 'López Rodriguez Zuany Cecilia',
    tipo: TipoVendedora.VENDEDORA,
    area: AreaVendedora.EJECUTIVA,
  },
  {
    codigo: 'Pe2455',
    nombre: 'Canedo Villamor Claudia Marcela',
    tipo: TipoVendedora.VENDEDORA,
    area: AreaVendedora.EJECUTIVA,
  },
  {
    codigo: 'Pe2456',
    nombre: 'Ojeda Cocha Yelca',
    tipo: TipoVendedora.VENDEDORA,
    area: AreaVendedora.EJECUTIVA,
  },
  /* Coordinadoras de RA. Liquidan por tarifa fija de procedimiento, no como
     ejecutivas, y tienen su propio bono trimestral en la planilla. Maricela es
     la única que aparece vendiendo en los meses analizados. */
  {
    codigo: 'Dr1970',
    nombre: 'Cabezas Roman Maricela',
    tipo: TipoVendedora.VENDEDORA,
    area: AreaVendedora.RA,
  },
];
