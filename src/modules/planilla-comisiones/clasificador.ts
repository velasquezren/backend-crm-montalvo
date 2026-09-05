import {
  CanalVenta,
  ClasifComision,
  NivelPlan,
  TipoComision,
  UnidadNegocio,
} from '../../prisma/prisma-client';

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
  /**
   * Área clínica de la venta (RA, Maternidad, Ginecologia…).
   *
   * **Es lo único que distingue una venta de Reproducción Asistida**, y no se
   * puede deducir de nada más: en la planilla real el mismo servicio, del mismo
   * médico y hasta de la misma paciente aparece unas veces como RA y otras como
   * Ginecología. Lo decide el tratamiento en el que está la paciente.
   *
   * Hoy el export de FileMaker NO trae esta columna —administración la añade a
   * mano en su hoja `BDEjecutivas`—, así que llega null y las ventas de RA se
   * liquidan como Tipo C. Si algún día el export la incluye, esto funciona solo.
   */
  area: string | null;
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
  /** Clasificación del SERVICIO tal como la trae FileMaker (columna `clasifiacion`). */
  clasificacionServicio: string | null;
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

/**
 * Estados que trae un plan de FileMaker. **Ya no filtran nada** — se conservan
 * como referencia de qué valores existen, para quien tenga que leer la columna.
 *
 * Describen el ciclo del plan, no su cobranza: en enero hay TERMINADOS con el
 * 25 % pagado y APROBADOS con el 100 %.
 */
export const ESTADOS_PLAN_CONOCIDOS = ['APROBADO', 'TERMINADO'];

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
 * Lo desconocido cae en EMPRESA, que es la tarifa más baja: si aparece un canal
 * nuevo, el sistema paga de menos y administración lo corrige, en vez de pagar
 * de más y tener que recuperarlo.
 */
export function determinarCanal(
  captacion: string | null,
  mapeos: ReadonlyMap<string, CanalVenta>,
): CanalVenta {
  const valor = normalizar(captacion);
  if (!valor) return CanalVenta.EMPRESA;
  return mapeos.get(valor) ?? CanalVenta.EMPRESA;
}

/**
 * PASO 2 — Base de cálculo: SIEMPRE el precio menos el IVA. Sin excepciones.
 *
 * Hubo una: si la fila traía anticipo, ese monto pasaba a ser la base y no se le
 * descontaba nada, con el argumento de que "ya viene neto". **Es falso**, y la
 * planilla de diciembre lo desmiente en las 356 filas:
 *
 *   INGRESO NETO = precio × 0,87   →  356 de 356
 *   INGRESO NETO = anticipo        →    0 de 356
 *   MONTO VENDIDO = precio         →  356 de 356
 *
 * Incluidas las 20 que traen anticipo. Por ejemplo, "Plan Nacer Cesárea 1er
 * trimestre" con precio 3.236,52 y anticipo 323,65 liquida sobre 2.815,78, que
 * es 3.236,52 × 0,87 — no sobre los 323,65.
 *
 * El anticipo dice cuánto lleva pagado la paciente y no cambia la comisión: la
 * vendedora cobra por VENDER el plan, no al ritmo al que se cobra. Por eso el
 * mismo plan aparece con precio idéntico en cada fila —es el precio de catálogo—
 * y lo único que varía entre filas es qué paciente lo compró.
 *
 * La regla vieja dejaba la base de enero corta en 24.974 USD sobre 30 filas, y
 * en las que el anticipo superaba al precio la dejaba alta. Se verificó circular:
 * se comprobó que el `ingresoNeto` guardado coincidía con el anticipo, y
 * coincidía porque este mismo código lo había escrito así.
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
export function calcularIngresoNeto(precio: number, iva: number = IVA_POR_DEFECTO): number {
  return redondear(precio * (1 - iva));
}

/** Regla con su patrón y módulo ya normalizados, lista para comparar. */
interface ReglaPreparada extends ReglaDiccionario {
  patronNorm: string;
  moduloNorm: string;
}

/**
 * Diccionario ordenado por prioridad y con los textos ya normalizados.
 *
 * Se memoriza por identidad del array porque el importador llama al clasificador
 * una vez POR FILA con el mismo diccionario: sin esto, un Excel de 3.000 filas
 * con 20 reglas normalizaba los mismos 40 textos 120.000 veces, y copiaba y
 * ordenaba el array otras 3.000. Es memoización pura —mismo array, mismo
 * resultado—, no estado oculto.
 */
const reglasPreparadas = new WeakMap<readonly ReglaDiccionario[], ReglaPreparada[]>();

function prepararReglas(reglas: readonly ReglaDiccionario[]): ReglaPreparada[] {
  const yaHecho = reglasPreparadas.get(reglas);
  if (yaHecho) return yaHecho;

  const preparadas = [...reglas]
    .sort((a, b) => a.prioridad - b.prioridad)
    .map(regla => ({
      ...regla,
      patronNorm: normalizar(regla.patron),
      moduloNorm: normalizar(regla.modulo),
    }));

  reglasPreparadas.set(reglas, preparadas);
  return preparadas;
}

/** Busca en el diccionario la primera regla (por prioridad) que cruce con la fila. */
export function buscarRegla(
  fila: FilaExcel,
  reglas: readonly ReglaDiccionario[],
  detalleNorm = normalizar(fila.detalle),
  moduloNorm = normalizar(fila.modulo),
): ReglaDiccionario | null {
  for (const regla of prepararReglas(reglas)) {
    if (regla.moduloNorm && regla.moduloNorm !== moduloNorm) continue;
    if (!regla.patronNorm) continue;
    const cruza = regla.exacto
      ? detalleNorm === regla.patronNorm
      : detalleNorm.includes(regla.patronNorm);
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

  /**
   * El área clínica manda sobre todo lo demás cuando viene informada.
   *
   * Es la única forma de saber que una venta es de Reproducción Asistida, y en
   * la planilla de administración la correspondencia es perfecta: las 159 filas
   * con `AREA = RA` son exactamente las 159 con `UNIDAD DE NEGOCIO = RA`.
   *
   * Se comprobó que NO se puede deducir de nada más. El mismo servicio
   * ("Creatinina", "Cultivo Vaginal", "Internación"), del mismo médico
   * (Dr. Montalvo) y hasta de la misma paciente aparece unas veces como RA y
   * otras como Ginecología: 11 de 23 médicos y 18 de 114 pacientes tienen más
   * de un área. Lo decide el tratamiento en el que está la paciente, y eso solo
   * lo sabe FileMaker.
   */
  const area = normalizar(fila.area);
  if (area === 'RA') {
    return UnidadNegocio.RA;
  }

  if (normalizar(fila.modulo) === 'PLANES') {
    const clasificacion = normalizar(fila.clasificacionPlan);

    /*
     * `Plan Maternidad` y `Paquete Maternidad` son la MISMA cosa —el paquete de
     * maternidad—, y FileMaker usa las dos. La comparación exacta contra
     * "PLAN MATERNIDAD" dejaba fuera la segunda: 4 filas en octubre y 1 en
     * noviembre se iban a planes varios, cuyo objetivo es 1 en vez de 4 o 6.
     *
     * Se compara por "MATERNIDAD" contenido, que es la palabra que decide, y no
     * por la que la acompaña. Ninguna de las otras clasificaciones que existen
     * —Paquete Bariatrica, Paquete Niño Sano— la lleva.
     */
    if (clasificacion.includes('MATERNIDAD')) {
      return UnidadNegocio.MATERNIDAD;
    }

    /*
     * Bariátrica y Niño Sano dicen explícitamente que NO son maternidad, así que
     * se respetan. Para todo lo demás —incluida la columna vacía, que son 2 a 5
     * filas cada mes— manda el detalle: "Paquete Cesarea Silver" es maternidad
     * aunque nadie lo haya clasificado.
     */
    const declaraOtraCosa =
      clasificacion.includes('BARIATRIC') ||
      clasificacion.includes('CIRUG') ||
      clasificacion.includes('NINO');

    if (!declaraOtraCosa) {
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
 * Lo que FileMaker ya dice que es este servicio.
 *
 * El export trae una columna con la clasificación resuelta —231 laboratorios, 85
 * consultas, 35 ecografías…— y hasta ahora el sistema la ignoraba y volvía a
 * deducirla con heurísticos sobre el texto del detalle. Adivinaba bien (coincidía
 * en las 415 filas de enero que traen valor), pero adivinar teniendo el dato es
 * frágil: basta un servicio nuevo con un nombre que ningún patrón reconozca para
 * que caiga en OTROSS.
 *
 * **`Plan` y `Paquete` NO se resuelven aquí, a propósito.** Es tentador —son dos
 * palabras y hay dos clasificaciones— pero en el vocabulario de la clínica
 * significan lo contrario de lo que parecen, y esta función leyéndolas al pie de
 * la letra las cruzaba. En el export de enero 2026:
 *
 *   clasifiacion   detalle                              lo que es
 *   ------------   ----------------------------------   -------------------
 *   Plan     ×19   "Plan Nacer Cesárea 1er trim (Gold)"  PAQUETE maternidad
 *   Paquete  ×5    "Paquete Cesarea Silver"              PAQUETE maternidad
 *   Paquete  ×1    "Paquete Niño Sano (2025)"            PLAN niño
 *
 * O sea: `Paquete` cae en los dos lados y `Plan` no cae en ninguno de los que su
 * nombre sugiere. La palabra no alcanza; lo que sí distingue es el **área**
 * (Maternidad vs Pediatria), y de eso ya se ocupa `determinarUnidadNegocio`. Por
 * eso aquí se devuelve null y decide el heurístico, que acierta los 30 casos.
 *
 * El coste de haberlo cruzado no era cosmético: los 19 paquetes de maternidad de
 * enero se contaban contra el objetivo de PLANNIN —que es **1**, no 4 ni 6— y
 * casi todos comisionaban, además de cobrar la tarifa plana en vez de la de su
 * nivel. No lo detectó ninguna prueba porque el export de diciembre, el mes de
 * referencia, **no trae esta columna**: son 20 columnas y `clasifiacion` no está
 * entre ellas, así que en diciembre esta función nunca llegaba a ejecutarse.
 *
 * Devuelve null si la columna viene vacía o dice algo que no conocemos; ahí sigue
 * mandando el heurístico, que es lo que cubre las filas sin clasificar de enero.
 */
export function clasifDeFileMaker(valor: string | null): ClasifComision | null {
  const texto = normalizar(valor);
  if (!texto) return null;

  if (texto.includes('LABORATORIO')) return ClasifComision.LAB;
  if (texto.includes('ECOGRAFIA')) return ClasifComision.ECOGRAFIA;
  if (texto.includes('CONSULTA')) return ClasifComision.CONSULTA;
  if (texto.includes('CIRUGIA')) return ClasifComision.CIRUGIA;
  if (texto.includes('OTROS')) return ClasifComision.OTROSS;
  return null;
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

  /**
   * Una internación es una CIRUGÍA, no un "otro servicio".
   *
   * Verificado contra `CALCULO COMISION DICIEMBRE 2025.xlsx`: la comisión de
   * Tipo B (cirugías) de cada vendedora coincide **al céntimo** con el neto de
   * sus filas de INTERNACION — Zuany 4.631,35, Yelca 2.643,86, Claudia 948,40.
   * Pagaba como OTROSS (Tipo C, 4,5 %) cuando debe pagar por la tabla de
   * niveles de cirugía, que es otra escala entera.
   */
  if (modulo === 'INTERNACION') {
    return ClasifComision.CIRUGIA;
  }

  if (modulo === 'PLANES') {
    /**
     * Un plan que NO es de maternidad tampoco es un plan a efectos de comisión.
     *
     * El caso real que lo demuestra: el "Paquete Bariatrica" de Viviana (neto
     * 2.184,37) sale de sus planes y entra en su cirugía. Por eso la planilla
     * le cuenta **3 planes y no 4** para el objetivo, y su base de cirugía sube
     * de 11.548,94 a 13.733,31. Manda la clasificación, no el módulo.
     */
    if (unidadNegocio !== UnidadNegocio.MATERNIDAD) {
      const clasificacion = normalizar(fila.clasificacionPlan);
      if (clasificacion.includes('BARIATRIC') || clasificacion.includes('CIRUG')) {
        return ClasifComision.CIRUGIA;
      }
    }

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

/**
 * PASO 7 — Tipo de comisión que corresponde a cada clasificación.
 *
 * Es informativo (lo que se guarda y se muestra), no lo que decide el pago:
 * `calculo-comisiones.service.ts` recalcula su propio `tipo` a partir de
 * `clasif` + `unidadNegocio` fila por fila, sin leer esta columna.
 *
 * El área RA es la excepción a la regla simple por-clasif: en la planilla de
 * administración (`PARAMETROS`, columna `TIPO COMISION`) sus filas de
 * consulta/laboratorio/ecografía/otros están marcadas 'A', no 'C' — pagan por
 * el excedente combinado con planes, no por la tarifa plana de Tipo C. Solo
 * campaña y promoción del área RA se quedan en 'C' (pagan 0 en las dos).
 */
export function determinarTipo(
  clasif: ClasifComision,
  unidadNegocio: UnidadNegocio,
): TipoComision {
  switch (clasif) {
    case ClasifComision.PLANPAQ:
    case ClasifComision.PLANNIN:
      return TipoComision.A;
    case ClasifComision.CIRUGIA:
      return TipoComision.B;
    case ClasifComision.CAMPANA:
    case ClasifComision.PROMOCION:
      return TipoComision.C;
    default:
      return unidadNegocio === UnidadNegocio.RA ? TipoComision.A : TipoComision.C;
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
  mapeosCaptacion: ReadonlyMap<string, CanalVenta> = new Map(),
): ResultadoClasificacion {
  const canal = determinarCanal(fila.captacion, mapeosCaptacion);
  const ingresoNeto = calcularIngresoNeto(fila.precio, iva);

  // Se normalizan una sola vez: los pasos 3 a 6 los volvían a calcular cada uno.
  const detalleNorm = normalizar(fila.detalle);
  const moduloNorm = normalizar(fila.modulo);

  const regla = buscarRegla(fila, reglas, detalleNorm, moduloNorm);
  const unidadNegocio = determinarUnidadNegocio(fila, regla);

  /* Prioridad: lo que administración ajustó a mano (diccionario) manda sobre lo
     que dice FileMaker, y lo de FileMaker manda sobre lo que deduzcamos nosotros.
     El diccionario sigue primero porque es la vía por la que se corrige un caso
     concreto sin tocar el export. */
  const clasifFileMaker = clasifDeFileMaker(fila.clasificacionServicio);
  const clasifHeuristica = determinarClasifHeuristica(fila, unidadNegocio);
  // Sin regla, sin columna y sin heurístico no se inventa una clasificación: se
  // marca OTROSS para que no rompa el cálculo, pero se levanta la bandera.
  const requiereRevision = !regla && clasifFileMaker === null && clasifHeuristica === null;
  let clasif = regla?.clasif ?? clasifFileMaker ?? clasifHeuristica ?? ClasifComision.OTROSS;

  // PASO 5 — Las promociones no comisionan, y pisan cualquier clasificación previa.
  const promocion = normalizar(fila.promocion);
  if (promocion === 'SI') {
    clasif = ClasifComision.CAMPANA;
  }

  const tipo = determinarTipo(clasif, unidadNegocio);

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

  /*
   * El estado del plan NO excluye. Se guarda y se muestra, nada más.
   *
   * Había una regla que dejaba fuera todo plan que no estuviera APROBADO o
   * TERMINADO. Se retira por decisión de negocio: la venta existe y la vendedora
   * la hizo, así que comisiona; en qué punto de su ciclo esté el plan, y si la
   * paciente debe o no, es cosa de administración y no del cálculo.
   *
   * No cambia ninguna cifra actual: los 30 planes de enero y los 20 de diciembre
   * están todos en uno de esos dos estados. Lo que evita es que un estado nuevo
   * de FileMaker tumbe una venta legítima sin que nadie lo note.
   *
   * `estadoPlan` sigue viajando hasta la tabla, junto al anticipo, para que se
   * vea qué planes están en curso y cuánto llevan pagado. Ojo: el estado NO dice
   * si pagó — en enero hay TERMINADOS con el 25 % pagado y APROBADOS con el
   * 100 %.
   */

  if (!fila.vendedoraPk && !fila.vendedoraNombre) {
    return { comisionable: false, motivoExclusion: 'Venta sin vendedora asignada' };
  }

  // Campañas y promociones sí entran al reporte, pero su tarifa es 0%.
  if (clasif === ClasifComision.CAMPANA || clasif === ClasifComision.PROMOCION) {
    return { comisionable: true, motivoExclusion: null };
  }

  return { comisionable: true, motivoExclusion: null };
}
