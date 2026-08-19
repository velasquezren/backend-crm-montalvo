import { readFileSync } from 'node:fs';

import { CAPTACION_POR_DEFECTO } from './configuracion-por-defecto';
import { ClasifComision, NivelPlan, UnidadNegocio } from '@prisma/client';

import {
  calcularIngresoNeto,
  clasificarFila,
  determinarCanal,
  determinarNivel,
  determinarTipo,
  FilaExcel,
  normalizar,
  ReglaDiccionario,
  clasifDeFileMaker,
} from './clasificador';
import { leerExcel } from './excel-parser';

/**
 * El clasificador decide de qué categoría es cada venta, y de ahí sale lo que
 * cobra cada vendedora. Una regresión aquí no da error: paga mal y nadie se
 * entera hasta que alguien reclama su sueldo. Por eso se fija con pruebas.
 *
 * Los casos salen del catálogo real de servicios del documento de negocio y de
 * un export real de enero (423 filas).
 */

function fila(campos: Partial<FilaExcel> = {}): FilaExcel {
  return {
    fecha: new Date('2026-01-15'),
    modulo: null,
    codOrigen: null,
    estadoPlan: null,
    codItem: null,
    detalle: '',
    pac: 'PAC1',
    paciente: 'Paciente',
    medicoPk: null,
    medico: null,
    area: null,
    vendedoraPk: 'Pe2455',
    vendedoraNombre: 'Canedo Villamor Claudia Marcela',
    captacion: null,
    seguro: 'Particular',
    promocion: null,
    precio: 100,
    anticipoPlan: null,
    tc: 6.97,
    obs: null,
    clasificacionPlan: null,
    clasificacionServicio: null,
    ...campos,
  };
}

describe('normalizar', () => {
  it('quita acentos y unifica mayúsculas y espacios', () => {
    expect(normalizar('  Ecografía   Mamaria ')).toBe('ECOGRAFIA MAMARIA');
  });

  it('trata el nulo como cadena vacía', () => {
    expect(normalizar(null)).toBe('');
  });
});

describe('canal de venta (paso 1)', () => {
  // El mapa se pasa siempre: es lo que administración edita, y clasificar
  // contra otra cosa sería probar un comportamiento que producción no usa.
  const mapeos = new Map(CAPTACION_POR_DEFECTO.map(m => [m.valor, m.canal]));

  /*
   * La regla no se dedujo, está escrita: "CALCULO COMISION DICIEMBRE 2024.xlsx",
   * hoja `Hoja1 (2)`, fila 24 — «Se considera RE cualquier contacto generado con
   * recursos de la empresa, por ejemplo: pacientes de clínica, RRSS, ferias,
   * brunch de mamás, talleres formativos», y fila 25 — «Se considera RP
   * cualquier contacto generado fuera de la clínica con los recursos de la
   * propia vendedora».
   *
   * Es decir: solo lo que la vendedora consigue por su cuenta es PROPIO. Las
   * redes sociales y las ferias son de la clínica. En diciembre 183 de 185
   * ventas se cobraron como EMPRESA.
   */
  it.each([
    ['Clinica', 'EMPRESA'],
    ['Redes', 'EMPRESA'],
    ['Facebook', 'EMPRESA'],
    ['Instagram', 'EMPRESA'],
    ['Ramada', 'EMPRESA'],
    ['Expobebe', 'EMPRESA'],
    ['Propio', 'PROPIO'],
    ['Propia', 'PROPIO'],
  ])('captación "%s" → %s', (captacion, esperado) => {
    expect(determinarCanal(captacion, mapeos)).toBe(esperado);
  });

  it('sin captación asume EMPRESA, no PROPIO: el canal propio paga más', () => {
    expect(determinarCanal(null, mapeos)).toBe('EMPRESA');
    expect(determinarCanal('', mapeos)).toBe('EMPRESA');
  });

  it('un canal que nadie configuró cae en EMPRESA, la tarifa más baja', () => {
    expect(determinarCanal('TikTok', mapeos)).toBe('EMPRESA');
    expect(determinarCanal('Propio', new Map())).toBe('EMPRESA');
  });
});

describe('base de cálculo (paso 2)', () => {
  // Valores tomados de "CALCULO COMISION DICIEMBRE 2024.xlsx". Son la prueba de
  // que la clínica liquida con `precio × 0,87` y no con `precio ÷ 1,13`: si
  // alguien vuelve a la división, estos dos casos fallan.
  it('descuenta el 13% multiplicando por 0,87 — celda D15 de CALCULO BONOS COORD', () => {
    expect(calcularIngresoNeto(27061.48)).toBe(23543.49);
  });

  it('mismo criterio en la hoja de ejecutivas — celda D6 de CALCULO BONOS', () => {
    expect(calcularIngresoNeto(36285.54)).toBe(31568.42);
  });

  it('NO usa la división 1/1,13 (dejaría 88,50 en vez de 87,00 sobre 100)', () => {
    expect(calcularIngresoNeto(100)).toBe(87);
  });

  /*
   * El anticipo NO es la base, y estas tres filas son de la hoja `BDEjecutivas`
   * de "CALCULO COMISION DICIEMBRE 2025.xlsx" — la que usa administración.
   *
   * Hubo una regla que decía lo contrario: con anticipo, ese monto pasaba a ser
   * la base sin descontarle nada. Sobre las 356 filas de diciembre el Excel da
   * `precio × 0,87` en 356 y `anticipo` en 0, incluidas las 20 que traen
   * anticipo. La regla vieja dejaba la base de enero corta en 24.974 USD.
   */
  /* Los precios van con TODOS sus decimales, como los guarda el Excel. Con el
     valor redondeado a dos, `3236.52 × 0,87` cae en 2815,77 y el Excel dice
     2815,78: el céntimo sale de los decimales que el redondeo se comió. */
  it.each([
    ['Plan Nacer Cesarea 3er. Trimestre', 2652.6429040961234, 265.28, 2307.8],
    ['Plan Nacer Cesárea 1er trimestre', 3236.5231587202175, 323.65, 2815.78],
    ['Paquete Bariatrica Premium', 2510.76828225314, 2510.76, 2184.37],
    ['Plan Nacer Parto Normal 2do. Trim.', 2238.5230172782663, 286.94, 1947.52],
  ])('%s: la base sale del precio, no del anticipo', (_detalle, precio, _anticipo, neto) => {
    expect(calcularIngresoNeto(precio)).toBe(neto);
  });

  /* El caso que más despistaba: pagado al 100 %, el anticipo casi iguala al
     precio, y aun así hay que descontarle el 13 %. */
  it('un anticipo igual al precio tampoco se libra del descuento', () => {
    expect(calcularIngresoNeto(2510.76828225314)).toBe(2184.37);
    expect(calcularIngresoNeto(2510.76828225314)).not.toBe(2510.76);
  });
});

describe('clasificación por catálogo real', () => {
  const casos: Array<[string, string, ClasifComision]> = [
    ['Consulta (Externa)', 'CONSULTA', ClasifComision.CONSULTA],
    ['Reconsulta Dr. Montalvo', 'CONSULTA', ClasifComision.CONSULTA],
    ['Valoración Cardiológica', 'CONSULTA', ClasifComision.CONSULTA],
    ['Ecografia Mamaria', 'CONSULTA', ClasifComision.ECOGRAFIA],
    ['Ecografia Doppler Repetitiva', 'CONSULTA', ClasifComision.ECOGRAFIA],
    ['Papanicolaou', 'CONSULTA', ClasifComision.OTROSS],
    ['Electrocardiograma', 'CONSULTA', ClasifComision.OTROSS],
    ['RX Torax P-A Adultos', 'CONSULTA', ClasifComision.OTROSS],
    ['Retiro de T o DIU en consultorio', 'CONSULTA', ClasifComision.OTROSS],
    ['Histeroscopia Diagnostica', 'CONSULTA', ClasifComision.CIRUGIA],
    ['Laparoscopia + Histeroscopia', 'CONSULTA', ClasifComision.CIRUGIA],
    ['Hemograma Completo', 'LABORATORIO', ClasifComision.LAB],
    ['Toxoplasmosis IgG', 'LABORATORIO', ClasifComision.LAB],
    /* Una internación es cirugía, no "otro servicio". Verificado contra
       CALCULO COMISION DICIEMBRE 2025: el Tipo B de cada vendedora es
       exactamente el neto de sus INTERNACION (Zuany 4.631,35 · Yelca
       2.643,86 · Claudia 948,40). */
    ['Internación', 'INTERNACION', ClasifComision.CIRUGIA],
  ];

  it.each(casos)('"%s" [%s] → %s', (detalle, modulo, esperado) => {
    expect(clasificarFila(fila({ detalle, modulo }), []).clasif).toBe(esperado);
  });
});

describe('planes (pasos 3, 4 y 6)', () => {
  const plan = (detalle: string, clasificacionPlan: string | null = null) =>
    clasificarFila(
      fila({ detalle, modulo: 'PLANES', clasificacionPlan, estadoPlan: 'APROBADO' }),
      [],
    );

  it('un plan de maternidad es PLANPAQ y lleva nivel', () => {
    const r = plan('Plan Nacer Cesárea 1er trimestre (Gold)', 'Plan Maternidad');
    expect(r.clasif).toBe(ClasifComision.PLANPAQ);
    expect(r.nivel).toBe(NivelPlan.GOLD);
    expect(r.unidadNegocio).toBe('MATERNIDAD');
  });

  it('sin clasificación, deduce maternidad por el nombre del servicio', () => {
    const r = plan('Paquete Cesarea Silver');
    expect(r.clasif).toBe(ClasifComision.PLANPAQ);
    expect(r.nivel).toBe(NivelPlan.SILVER);
  });

  /**
   * Caso real de la planilla de diciembre 2025: el "Paquete Bariatrica" de
   * Viviana (neto 2.184,37) NO cuenta como plan. Sale de su objetivo de planes
   * —la planilla le cuenta 3 y no 4— y entra en su base de cirugía, que sube de
   * 11.548,94 a 13.733,31. Manda la clasificación, no el módulo.
   */
  it('un paquete bariátrico comisiona como CIRUGIA, no como plan', () => {
    const r = plan('Paquete Bariatrica Premium', 'Paquete Bariatrica');
    expect(r.clasif).toBe(ClasifComision.CIRUGIA);
    expect(r.nivel).toBeNull();
  });

  it('sin nivel reconocible cae en SILVER, el intermedio', () => {
    expect(determinarNivel('Paquete Cesarea sin nivel')).toBe(NivelPlan.SILVER);
  });
});

describe('exclusiones: lo que NO debe comisionar', () => {
  it('precio cero', () => {
    const r = clasificarFila(fila({ detalle: 'Reconsulta', modulo: 'CONSULTA', precio: 0 }), []);
    expect(r.comisionable).toBe(false);
    expect(r.motivoExclusion).toMatch(/Precio 0/);
  });

  /*
   * El estado del plan dejó de excluir, por decisión de negocio: la venta existe
   * y la vendedora la hizo. En qué punto está el plan —y si la paciente debe— es
   * cosa de administración, que lo ve en la tabla junto al anticipo.
   *
   * Se prueban los tres casos que ANTES tumbaban la fila, para que quede fijado
   * que hoy ninguno lo hace.
   */
  it.each([[null], ['ANULADO'], ['CUALQUIER COSA']])(
    'un plan con estado %p comisiona igual',
    estadoPlan => {
      const r = clasificarFila(
        fila({ detalle: 'Paquete Cesarea Silver', modulo: 'PLANES', estadoPlan }),
        [],
      );
      expect(r.comisionable).toBe(true);
      expect(r.motivoExclusion).toBeNull();
    },
  );

  it('venta sin vendedora: no hay a quién pagarle', () => {
    const r = clasificarFila(
      fila({ detalle: 'Consulta (Externa)', modulo: 'CONSULTA', vendedoraPk: null, vendedoraNombre: null }),
      [],
    );
    expect(r.comisionable).toBe(false);
  });

  it('una promoción pasa a CAMPAÑA (tarifa 0%) pisando su clasificación', () => {
    const r = clasificarFila(
      fila({ detalle: 'Consulta (Externa)', modulo: 'CONSULTA', promocion: 'Si' }),
      [],
    );
    expect(r.clasif).toBe(ClasifComision.CAMPANA);
  });
});

describe('tipo de comisión (paso 7)', () => {
  it.each([
    [ClasifComision.PLANPAQ, 'A'],
    [ClasifComision.PLANNIN, 'A'],
    [ClasifComision.CIRUGIA, 'B'],
    [ClasifComision.CONSULTA, 'C'],
    [ClasifComision.LAB, 'C'],
    [ClasifComision.ECOGRAFIA, 'C'],
    [ClasifComision.OTROSS, 'C'],
    [ClasifComision.CAMPANA, 'C'],
  ])('%s → Tipo %s', (clasif, esperado) => {
    expect(determinarTipo(clasif)).toBe(esperado);
  });
});

describe('diccionario configurable', () => {
  const regla = (extra: Partial<ReglaDiccionario> = {}): ReglaDiccionario => ({
    patron: 'Frecuencia cardiaca fetal',
    exacto: false,
    modulo: null,
    clasif: ClasifComision.OTROSS,
    nivel: null,
    unidadNegocio: null,
    prioridad: 10,
    ...extra,
  });

  it('una regla gana sobre el heurístico', () => {
    // Sin regla, "doppler" lo llevaría a ECOGRAFIA; el catálogo dice OTROSS.
    const detalle = 'Frecuencia cardiaca fetal doppler (10 MIN)';
    expect(clasificarFila(fila({ detalle, modulo: 'CONSULTA' }), []).clasif).toBe(
      ClasifComision.ECOGRAFIA,
    );
    expect(clasificarFila(fila({ detalle, modulo: 'CONSULTA' }), [regla()]).clasif).toBe(
      ClasifComision.OTROSS,
    );
  });

  it('es la única vía para marcar una venta como del área RA', () => {
    const r = clasificarFila(
      fila({ detalle: 'Aspiración de Óvulos', modulo: 'CONSULTA' }),
      [regla({ patron: 'Aspiracion de Ovulos', clasif: ClasifComision.CIRUGIA, unidadNegocio: 'RA' })],
    );
    expect(r.unidadNegocio).toBe('RA');
  });

  it('gana la de menor prioridad cuando dos reglas cruzan', () => {
    const r = clasificarFila(
      fila({ detalle: 'Frecuencia cardiaca fetal doppler', modulo: 'CONSULTA' }),
      [
        regla({ prioridad: 50, clasif: ClasifComision.CONSULTA }),
        regla({ prioridad: 10, clasif: ClasifComision.OTROSS }),
      ],
    );
    expect(r.clasif).toBe(ClasifComision.OTROSS);
  });

  it('el modo exacto no cruza por coincidencia parcial', () => {
    const r = clasificarFila(
      fila({ detalle: 'Consulta (Externa) especial', modulo: 'CONSULTA' }),
      [regla({ patron: 'Consulta (Externa)', exacto: true, clasif: ClasifComision.OTROSS })],
    );
    expect(r.clasif).toBe(ClasifComision.CONSULTA);
  });
});

describe('servicios desconocidos', () => {
  it('se marcan para revisión en vez de inventar una categoría', () => {
    const r = clasificarFila(
      fila({ detalle: 'Procedimiento Nuevo Sin Catalogar', modulo: 'CONSULTA' }),
      [],
    );
    expect(r.requiereRevision).toBe(true);
    // Comisiona provisionalmente como OTROSS para no romper el cálculo.
    expect(r.clasif).toBe(ClasifComision.OTROSS);
  });

  it('un servicio reconocido no pide revisión', () => {
    expect(
      clasificarFila(fila({ detalle: 'Consulta (Externa)', modulo: 'CONSULTA' }), []).requiereRevision,
    ).toBe(false);
  });
});

/**
 * El área clínica es lo ÚNICO que distingue una venta de Reproducción Asistida.
 *
 * Comprobado sobre la planilla real de diciembre 2025: las 159 filas con
 * `AREA = RA` son exactamente las 159 con `UNIDAD DE NEGOCIO = RA`. Y no se
 * puede deducir de nada más — el mismo servicio, del mismo médico y de la misma
 * paciente, aparece unas veces como RA y otras como Ginecología.
 */
describe('área clínica → unidad de negocio', () => {
  it('AREA = RA manda, aunque el servicio parezca una consulta cualquiera', () => {
    const r = clasificarFila(
      fila({ detalle: 'Consulta medica Dr. Montalvo', modulo: 'CONSULTA', area: 'RA' }),
      [],
    );
    expect(r.unidadNegocio).toBe(UnidadNegocio.RA);
  });

  it('el mismo servicio SIN área es VARIOS', () => {
    const r = clasificarFila(
      fila({ detalle: 'Consulta medica Dr. Montalvo', modulo: 'CONSULTA', area: null }),
      [],
    );
    expect(r.unidadNegocio).toBe(UnidadNegocio.VARIOS);
  });

  it('tolera minúsculas y espacios, que es como llega de FileMaker', () => {
    expect(clasificarFila(fila({ detalle: 'Creatinina', modulo: 'LABORATORIO', area: ' ra ' }), []).unidadNegocio).toBe(
      UnidadNegocio.RA,
    );
  });

  it('otras áreas no se confunden con RA', () => {
    for (const area of ['Ginecologia', 'Maternidad', 'Cardiologia', 'Bariatrica']) {
      expect(clasificarFila(fila({ detalle: 'Creatinina', modulo: 'LABORATORIO', area }), []).unidadNegocio).not.toBe(
        UnidadNegocio.RA,
      );
    }
  });
});

/* La columna que FileMaker ya trae resuelta. El sistema la ignoraba —la cabecera
   del export dice `clasifiacion`, sin la segunda c— y volvía a deducir con
   heurísticos algo que tenía delante. Acertaba, pero un servicio nuevo con un
   nombre desconocido habría caído en OTROSS. */
describe('clasifDeFileMaker', () => {
  it('traduce las siete etiquetas que usa el export de enero', () => {
    expect(clasifDeFileMaker('Laboratorio')).toBe('LAB');
    expect(clasifDeFileMaker('Consulta')).toBe('CONSULTA');
    expect(clasifDeFileMaker('Ecografia')).toBe('ECOGRAFIA');
    expect(clasifDeFileMaker('Cirugia')).toBe('CIRUGIA');
    expect(clasifDeFileMaker('Otros servicios')).toBe('OTROSS');
  });

  /*
   * `Plan` y `Paquete` NO deciden aquí, y esta prueba existe para que nadie
   * vuelva a "arreglarlo" añadiéndolas: en el vocabulario de la clínica
   * significan lo contrario de lo que parecen.
   *
   * "Plan Nacer Cesárea (Gold)" viene etiquetado como `Plan` y es un PAQUETE de
   * maternidad; "Paquete Niño Sano" viene como `Paquete` y es un PLAN niño. Y
   * `Paquete` etiqueta además las cesáreas, que son maternidad. Lo que separa de
   * verdad es el área, y de eso se encarga el heurístico.
   */
  it('NO decide entre Paquete y Plan: las dos palabras están cruzadas', () => {
    expect(clasifDeFileMaker('Paquete')).toBeNull();
    expect(clasifDeFileMaker('Plan')).toBeNull();
  });

  it('ignora acentos y mayúsculas, que el export mezcla', () => {
    expect(clasifDeFileMaker('ECOGRAFÍA')).toBe('ECOGRAFIA');
    expect(clasifDeFileMaker('  laboratorio  ')).toBe('LAB');
  });

  /* Las 8 filas de enero que vienen sin clasificar: aquí devuelve null y sigue
     mandando el heurístico, que es lo que las venía resolviendo. */
  it('devuelve null si la columna viene vacía o dice algo desconocido', () => {
    expect(clasifDeFileMaker(null)).toBeNull();
    expect(clasifDeFileMaker('')).toBeNull();
    expect(clasifDeFileMaker('   ')).toBeNull();
    expect(clasifDeFileMaker('Vacunación')).toBeNull();
  });
});

/**
 * Los cuatro tipos de fila de plan del export de enero 2026, con sus valores
 * REALES en las tres columnas que intervienen.
 *
 * Esto es lo que faltaba: el resto de las pruebas de plan usan filas sin
 * `clasificacionServicio`, porque los seis export anteriores —octubre a marzo,
 * incluido el diciembre con el que se concilia todo— traen 20 columnas y no
 * incluyen esa. El formato nuevo la añadió, y con ella un camino de código que
 * ninguna prueba recorría: el paquete de maternidad de mayor volumen del mes se
 * clasificaba como plan varios, con objetivo 1 en vez de 4 o 6.
 */
describe('planes del export nuevo de enero 2026 (con columna `clasifiacion`)', () => {
  const plan = (campos: Partial<FilaExcel>): FilaExcel =>
    fila({ modulo: 'PLANES', ...campos });

  it('"Plan" + Plan Maternidad es un PAQUETE de maternidad, con su nivel', () => {
    const r = clasificarFila(
      plan({
        detalle: 'Plan Nacer Cesárea 1er trimestre (Gold)',
        area: 'Maternidad',
        clasificacionServicio: 'Plan',
        clasificacionPlan: 'Plan Maternidad',
      }),
    );
    expect(r.clasif).toBe(ClasifComision.PLANPAQ);
    expect(r.unidadNegocio).toBe(UnidadNegocio.MATERNIDAD);
    expect(r.nivel).toBe(NivelPlan.GOLD);
  });

  it('"Paquete" + Niño Sano es un PLAN varios, sin nivel', () => {
    const r = clasificarFila(
      plan({
        detalle: 'Paquete Niño Sano (2025)',
        area: 'Pediatria',
        clasificacionServicio: 'Paquete',
        clasificacionPlan: 'Paquete Niño Sano',
      }),
    );
    expect(r.clasif).toBe(ClasifComision.PLANNIN);
    expect(r.unidadNegocio).toBe(UnidadNegocio.VARIOS);
    expect(r.nivel).toBeNull();
  });

  it('"Paquete" sin clasificación de plan, si es cesárea, es maternidad', () => {
    const r = clasificarFila(
      plan({
        detalle: 'Paquete de Cesarea sin equipo medico Silver',
        area: 'Maternidad',
        clasificacionServicio: 'Paquete',
        clasificacionPlan: null,
      }),
    );
    expect(r.clasif).toBe(ClasifComision.PLANPAQ);
    expect(r.nivel).toBe(NivelPlan.SILVER);
  });

  it('"Cirugia" + Bariatrica sale de planes y entra en cirugía', () => {
    const r = clasificarFila(
      plan({
        detalle: 'Paquete Bariatrica Premium',
        area: 'Cirugia',
        clasificacionServicio: 'Cirugia',
        clasificacionPlan: 'Paquete Bariatrica',
      }),
    );
    expect(r.clasif).toBe(ClasifComision.CIRUGIA);
  });

  /*
   * El reparto del mes entero. Si alguien vuelve a hacer que la palabra decida,
   * los 19 se van a PLANNIN y este número lo canta.
   */
  it('el mes reparte 24 paquetes, 1 plan varios y 5 cirugías', () => {
    const mes: FilaExcel[] = [
      ...Array.from({ length: 19 }, () =>
        plan({
          detalle: 'Plan Nacer Cesárea 1er trimestre (Gold)',
          area: 'Maternidad',
          clasificacionServicio: 'Plan',
          clasificacionPlan: 'Plan Maternidad',
        }),
      ),
      ...Array.from({ length: 5 }, () =>
        plan({
          detalle: 'Paquete Cesarea Silver',
          area: 'Maternidad',
          clasificacionServicio: 'Paquete',
          clasificacionPlan: null,
        }),
      ),
      plan({
        detalle: 'Paquete Niño Sano (2025)',
        area: 'Pediatria',
        clasificacionServicio: 'Paquete',
        clasificacionPlan: 'Paquete Niño Sano',
      }),
      ...Array.from({ length: 5 }, () =>
        plan({
          detalle: 'Paquete Bariatrica Premium',
          area: 'Cirugia',
          clasificacionServicio: 'Cirugia',
          clasificacionPlan: 'Paquete Bariatrica',
        }),
      ),
    ];

    const conteo = mes
      .map(f => clasificarFila(f).clasif)
      .reduce<Record<string, number>>((acc, c) => ({ ...acc, [c]: (acc[c] ?? 0) + 1 }), {});

    expect(conteo).toEqual({ PLANPAQ: 24, PLANNIN: 1, CIRUGIA: 5 });
  });
});

/**
 * El export NUEVO de enero 2026, leído de verdad con el parser.
 *
 * Las pruebas de arriba fijan la regla con los valores reales escritos a mano;
 * esta comprueba lo otro que puede romperse en silencio: que la columna
 * `clasifiacion` —así, sin la segunda c— llegue desde el fichero hasta el
 * clasificador. Si el mapeo de cabeceras deja de reconocerla, el reparto vuelve
 * a moverse sin que nada más se queje.
 *
 * Es el ÚNICO fichero de la clínica con esa columna: los seis anteriores
 * (octubre → marzo, incluido el diciembre de referencia) traen 20 columnas.
 * Si no está en el disco, se omite en vez de fallar.
 */
describe('el export nuevo de enero 2026, leído con el parser real', () => {
  const RUTA = '/Users/macmini2024/Documents/CARPETA RENE/2026 EXCELS/enero.xlsx';

  let filas: readonly FilaExcel[] | null = null;
  beforeAll(() => {
    try {
      filas = leerExcel(readFileSync(RUTA)).filas;
    } catch {
      filas = null;
    }
  });

  it('la columna `clasifiacion` llega al clasificador', () => {
    if (!filas) return;
    const planes = filas.filter(f => normalizar(f.modulo) === 'PLANES');
    expect(planes).toHaveLength(30);
    expect(planes.every(f => f.clasificacionServicio)).toBe(true);
  });

  it('reparte los 30 planes en 24 paquetes, 1 plan varios y 5 cirugías', () => {
    if (!filas) return;
    const conteo = filas
      .filter(f => normalizar(f.modulo) === 'PLANES')
      .map(f => clasificarFila(f).clasif)
      .reduce<Record<string, number>>((acc, c) => ({ ...acc, [c]: (acc[c] ?? 0) + 1 }), {});

    expect(conteo).toEqual({ PLANPAQ: 24, PLANNIN: 1, CIRUGIA: 5 });
  });

  /* Con el objetivo de PLANNIN en 1, mandar los paquetes ahí hacía comisionar
     casi todos. Este es el número que importa en plata. */
  it('solo UNA venta del mes es plan varios', () => {
    if (!filas) return;
    const varios = filas.filter(f => clasificarFila(f).clasif === ClasifComision.PLANNIN);
    expect(varios).toHaveLength(1);
    expect(varios[0]?.detalle).toContain('Niño Sano');
  });
});
