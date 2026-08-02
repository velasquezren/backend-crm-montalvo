import {
  CanalVenta,
  ClasifComision,
  NivelPlan,
  TipoComision,
  UnidadNegocio,
} from '@prisma/client';

/**
 * Motor de clasificación de la planilla de comisiones (pasos 1-7 de las reglas
 * de negocio). Es deliberadamente **puro**: no toca Prisma ni la red, recibe la
 * fila y el diccionario de reglas y devuelve la clasificación. Así se puede
 * razonar sobre él y probarlo sin base de datos.
 *
 * El orden de evaluación importa y replica el del documento de negocio; los
 * listados de palabras clave se exportan para que sean auditables desde fuera.
 */

/** Una fila del Excel de FileMaker, ya normalizada a tipos de JS. */
export interface FilaExcel {
  fecha: Date | null;
  modulo: string | null;
  codOrigen: string | null;
  estadoPlan: string | null;
  codItem: string | null;
  detalle: string;
  pac: string | null;
  paciente: string | null;
  medicoPk: string | null;
  medico: string | null;
  vendedoraPk: string | null;
  vendedoraNombre: string | null;
  captacion: string | null;
  seguro: string | null;
  promocion: string | null;
  precio: number;
  anticipoPlan: number | null;
  tc: number | null;
  obs: string | null;
  clasificacionPlan: string | null;
}

/** Regla del diccionario configurable (subconjunto de `ReglaClasificacion`). */
export interface ReglaDiccionario {
  patron: string;
  exacto: boolean;
  modulo: string | null;
  clasif: ClasifComision;
  nivel: NivelPlan | null;
  unidadNegocio: UnidadNegocio | null;
  prioridad: number;
}

export interface ResultadoClasificacion {
  canal: CanalVenta;
  ingresoNeto: number;
  unidadNegocio: UnidadNegocio;
  clasif: ClasifComision;
  tipo: TipoComision;
  nivel: NivelPlan | null;
  comisionable: boolean;
  motivoExclusion: string | null;
  /** true = ninguna regla ni heurístico reconoció el servicio; hay que revisarlo. */
  requiereRevision: boolean;
}

/** Impuesto que se descuenta del precio antes de comisionar (13% en Bolivia). */
export const IVA_POR_DEFECTO = 0.13;

/* ── Palabras clave de los heurísticos (auditables y ordenadas) ─────────── */

export const CLAVES_ECOGRAFIA = ['ECOGRAFIA', 'ECOGRAFICA', 'DOPPLER'];

export const CLAVES_CONSULTA = ['CONSULTA', 'RECONSULTA', 'VALORACION CARDIOLOGICA'];

export const CLAVES_OTROS_SERVICIOS = [
  'PAPANICOLAOU',
  'PAPANICOLAU',
  'ELECTROCARDIOGRAMA',
  'MONITORIZACION',
  'RX ',
  'CONTROL POST QX',
  'RETIRO DE',
  'INSERCION DE',
  'HISTEROSALPINGOGRAFIA',
  'PLASMA',
  'INTERNACION',
  'FRECUENCIA CARDIACA FETAL',
];

/** Procedimientos de alto valor que comisionan como cirugía (Tipo B). */
export const CLAVES_CIRUGIA = [
  'HISTEROSCOPIA',
  'LAPAROSCOPIA',
  'MIOMECTOMIA',
  'CIRUGIA',
  'BETTOCCHI',
  'ASPIRACION DE OVULOS',
  'ICSI',
  'BIOPSIA EMBRIONARIA',
  'CONGELAMIENTO DE EMBRIONES',
  'INSEMINACION',
  'TRANSFERENCIA',
  'CURETAJE',
  'CESAREA SIN PLAN',
];

/** Textos que marcan un plan de maternidad cuando falta la clasificación. */
export const CLAVES_MATERNIDAD = ['PLAN NACER', 'CESAREA', 'PARTO'];

/** Estados de plan que sí generan comisión (regla 7 de casos borde). */
export const ESTADOS_PLAN_VALIDOS = ['APROBADO', 'TERMINADO'];

/**
 * Normaliza texto para comparar: sin acentos, sin espacios sobrantes y en
 * mayúsculas. `Papanicolaou Dr. Montalvo` y `PAPANICOLAOU DR MONTALVO` deben
 * cruzar contra el mismo patrón del diccionario.
 */
export function normalizar(texto: string | null | undefined): string {
  return (texto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/** Redondea a 2 decimales evitando el arrastre binario de los flotantes. */
export function redondear(valor: number): number {
  return Math.round((valor + Number.EPSILON) * 100) / 100;
}

/**
 * PASO 1 — Canal de venta.
 * `Clinica` (y el vacío, por defecto) son contactos generados con recursos de
 * la empresa; `Redes` y `Propio` los genera la propia vendedora.
 */
export function determinarCanal(captacion: string | null): CanalVenta {
  const valor = normalizar(captacion);
  if (valor === 'REDES' || valor === 'PROPIO') {
    return CanalVenta.PROPIO;
  }
  return CanalVenta.EMPRESA;
}

/**
 * PASO 2 — Base de cálculo.
 * Si el plan tiene anticipo, ese monto manda y **ya viene sin impuestos**
 * (caso borde 6); si no, se descuenta el IVA del precio de lista.
 *
 * El descuento es `precio × (1 − iva)`, **no** `precio ÷ (1 + iva)`. No es lo
 * mismo: sobre 100 el primero deja 87,00 y el segundo 88,50. La planilla de la
 * clínica usa el primero — verificado celda por celda contra
 * "CALCULO COMISION DICIEMBRE 2024.xlsx":
 *
 *   27.061,48 × 0,87 = 23.543,4876   (CALCULO BONOS COORD, D15)
 *   36.285,54 × 0,87 = 31.568,4198   (CALCULO BONOS, D6)
 *
 * Contablemente `÷ 1,13` sería lo correcto para extraer el neto de un precio
 * que YA incluye impuesto, pero aquí manda cómo liquida administración: si un
 * día cambian de criterio, se cambia acá y en el parámetro IVA, no fila por fila.
 */
export function calcularIngresoNeto(
  precio: number,
  anticipoPlan: number | null,
  iva: number = IVA_POR_DEFECTO,
): number {
  if (anticipoPlan !== null && anticipoPlan > 0) {
    return redondear(anticipoPlan);
  }
  return redondear(precio * (1 - iva));
}

/** Busca en el diccionario la primera regla (por prioridad) que cruce con la fila. */
export function buscarRegla(
  fila: FilaExcel,
  reglas: readonly ReglaDiccionario[],
): ReglaDiccionario | null {
  const detalle = normalizar(fila.detalle);
  const modulo = normalizar(fila.modulo);

  const ordenadas = [...reglas].sort((a, b) => a.prioridad - b.prioridad);
  for (const regla of ordenadas) {
    if (regla.modulo && normalizar(regla.modulo) !== modulo) continue;
    const patron = normalizar(regla.patron);
    if (!patron) continue;
    const cruza = regla.exacto ? detalle === patron : detalle.includes(patron);
    if (cruza) return regla;
  }
  return null;
}

/** PASO 3 — Unidad de negocio. El diccionario puede forzarla (única vía para marcar RA). */
export function determinarUnidadNegocio(
  fila: FilaExcel,
  regla: ReglaDiccionario | null,
): UnidadNegocio {
  if (regla?.unidadNegocio) {
    return regla.unidadNegocio;
  }

  if (normalizar(fila.modulo) === 'PLANES') {
    const clasificacion = normalizar(fila.clasificacionPlan);
    if (clasificacion === 'PLAN MATERNIDAD') {
      return UnidadNegocio.MATERNIDAD;
    }
    // Plan sin clasificación: se deduce del detalle (caso borde 3).
    if (!clasificacion) {
      const detalle = normalizar(fila.detalle);
      if (CLAVES_MATERNIDAD.some(clave => detalle.includes(clave))) {
        return UnidadNegocio.MATERNIDAD;
      }
    }
    return UnidadNegocio.VARIOS;
  }

  return UnidadNegocio.VARIOS;
}

/**
 * PASO 4 — Clasificación por heurísticos, cuando el diccionario no la fijó.
 * Devuelve null si nada reconoce el servicio (queda para revisión manual).
 */
export function determinarClasifHeuristica(
  fila: FilaExcel,
  unidadNegocio: UnidadNegocio,
): ClasifComision | null {
  const modulo = normalizar(fila.modulo);
  const detalle = normalizar(fila.detalle);

  if (modulo === 'LABORATORIO') {
    return ClasifComision.LAB;
  }

  if (modulo === 'INTERNACION') {
    return ClasifComision.OTROSS;
  }

  if (modulo === 'PLANES') {
    return unidadNegocio === UnidadNegocio.MATERNIDAD
      ? ClasifComision.PLANPAQ
      : ClasifComision.PLANNIN;
  }

  if (modulo === 'CONSULTA') {
    // El orden replica el del documento de negocio: ecografías, consultas,
    // otros servicios y —al final— las cirugías de alto valor.
    if (CLAVES_ECOGRAFIA.some(clave => detalle.includes(clave))) {
      return ClasifComision.ECOGRAFIA;
    }
    if (CLAVES_CONSULTA.some(clave => detalle.includes(clave))) {
      return ClasifComision.CONSULTA;
    }
    if (CLAVES_OTROS_SERVICIOS.some(clave => detalle.includes(clave))) {
      return ClasifComision.OTROSS;
    }
    if (CLAVES_CIRUGIA.some(clave => detalle.includes(clave))) {
      return ClasifComision.CIRUGIA;
    }
  }

  return null;
}

/** PASO 6 — Nivel del plan, extraído del texto del detalle. */
export function determinarNivel(detalle: string): NivelPlan {
  const texto = normalizar(detalle);
  if (texto.includes('GOLD')) return NivelPlan.GOLD;
  if (texto.includes('BRONCE')) return NivelPlan.BRONCE;
  if (texto.includes('SILVER')) return NivelPlan.SILVER;
  return NivelPlan.SILVER; // por defecto, según la regla de negocio
}

/** PASO 7 — Tipo de comisión que corresponde a cada clasificación. */
export function determinarTipo(clasif: ClasifComision): TipoComision {
  switch (clasif) {
    case ClasifComision.PLANPAQ:
    case ClasifComision.PLANNIN:
      return TipoComision.A;
    case ClasifComision.CIRUGIA:
      return TipoComision.B;
    default:
      return TipoComision.C;
  }
}

/**
 * Clasifica una fila completa aplicando los 7 pasos en orden.
 *
 * El diccionario (`reglas`) tiene prioridad sobre los heurísticos: es la vía
 * por la que administración corrige o da de alta servicios nuevos sin tocar
 * código, y la única forma de marcar una venta como del área RA.
 */
export function clasificarFila(
  fila: FilaExcel,
  reglas: readonly ReglaDiccionario[] = [],
  iva: number = IVA_POR_DEFECTO,
): ResultadoClasificacion {
  const canal = determinarCanal(fila.captacion);
  const ingresoNeto = calcularIngresoNeto(fila.precio, fila.anticipoPlan, iva);

  const regla = buscarRegla(fila, reglas);
  const unidadNegocio = determinarUnidadNegocio(fila, regla);

  const clasifHeuristica = determinarClasifHeuristica(fila, unidadNegocio);
  // Sin regla ni heurístico no se inventa una clasificación: se marca OTROSS
  // para que no rompa el cálculo, pero se levanta la bandera de revisión.
  const requiereRevision = !regla && clasifHeuristica === null;
  let clasif = regla?.clasif ?? clasifHeuristica ?? ClasifComision.OTROSS;

  // PASO 5 — Las promociones no comisionan, y pisan cualquier clasificación previa.
  const promocion = normalizar(fila.promocion);
  if (promocion === 'SI') {
    clasif = ClasifComision.CAMPANA;
  }

  const tipo = determinarTipo(clasif);

  const esPlanMaternidad = clasif === ClasifComision.PLANPAQ;
  const nivel = esPlanMaternidad ? (regla?.nivel ?? determinarNivel(fila.detalle)) : null;

  const { comisionable, motivoExclusion } = evaluarComisionabilidad(fila, clasif);

  return {
    canal,
    ingresoNeto,
    unidadNegocio,
    clasif,
    tipo,
    nivel,
    comisionable,
    motivoExclusion,
    requiereRevision,
  };
}

/**
 * Decide si la fila entra al cálculo. Las exclusiones no borran la fila: se
 * guarda con el motivo para que administración lo vea en las alertas.
 */
function evaluarComisionabilidad(
  fila: FilaExcel,
  clasif: ClasifComision,
): { comisionable: boolean; motivoExclusion: string | null } {
  if (!Number.isFinite(fila.precio) || fila.precio <= 0) {
    return { comisionable: false, motivoExclusion: 'Precio 0 o inválido' };
  }

  // Regla 7: en PLANES solo comisionan los aprobados o terminados.
  if (normalizar(fila.modulo) === 'PLANES') {
    const estado = normalizar(fila.estadoPlan);
    if (!ESTADOS_PLAN_VALIDOS.includes(estado)) {
      return {
        comisionable: false,
        motivoExclusion: estado
          ? `Plan en estado "${fila.estadoPlan}" (requiere APROBADO o TERMINADO)`
          : 'Plan sin estado — revisar manualmente',
      };
    }
  }

  if (!fila.vendedoraPk && !fila.vendedoraNombre) {
    return { comisionable: false, motivoExclusion: 'Venta sin vendedora asignada' };
  }

  // Campañas y promociones sí entran al reporte, pero su tarifa es 0%.
  if (clasif === ClasifComision.CAMPANA || clasif === ClasifComision.PROMOCION) {
    return { comisionable: true, motivoExclusion: null };
  }

  return { comisionable: true, motivoExclusion: null };
}
