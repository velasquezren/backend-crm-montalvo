import { ClasifComision, NivelPlan } from '@prisma/client';

import {
  calcularIngresoNeto,
  clasificarFila,
  determinarCanal,
  determinarNivel,
  determinarTipo,
  FilaExcel,
  normalizar,
  ReglaDiccionario,
} from './clasificador';

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
  it.each([
    ['Clinica', 'EMPRESA'],
    ['Redes', 'PROPIO'],
    ['Propio', 'PROPIO'],
  ])('captación "%s" → %s', (captacion, esperado) => {
    expect(determinarCanal(captacion)).toBe(esperado);
  });

  it('sin captación asume EMPRESA, no PROPIO: el canal propio paga más', () => {
    expect(determinarCanal(null)).toBe('EMPRESA');
    expect(determinarCanal('')).toBe('EMPRESA');
  });
});

describe('base de cálculo (paso 2)', () => {
  it('descuenta el 13% del precio de lista', () => {
    expect(calcularIngresoNeto(3532.87, null)).toBe(3126.43);
  });

  it('cuando el plan tiene anticipo, ese monto manda y NO se le vuelve a quitar el IVA', () => {
    expect(calcularIngresoNeto(3532.87, 353.29)).toBe(353.29);
  });

  it('un anticipo en cero no cuenta como anticipo', () => {
    expect(calcularIngresoNeto(113, 0)).toBe(100);
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
    ['Internación', 'INTERNACION', ClasifComision.OTROSS],
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

  it('un paquete que no es de maternidad es PLANNIN y no lleva nivel', () => {
    const r = plan('Paquete Bariatrica Premium', 'Paquete Bariatrica');
    expect(r.clasif).toBe(ClasifComision.PLANNIN);
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

  it('plan sin estado aprobado', () => {
    const r = clasificarFila(
      fila({ detalle: 'Paquete Cesarea Silver', modulo: 'PLANES', estadoPlan: null }),
      [],
    );
    expect(r.comisionable).toBe(false);
  });

  it('plan en un estado que no es APROBADO ni TERMINADO', () => {
    const r = clasificarFila(
      fila({ detalle: 'Paquete Cesarea Silver', modulo: 'PLANES', estadoPlan: 'ANULADO' }),
      [],
    );
    expect(r.comisionable).toBe(false);
  });

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
