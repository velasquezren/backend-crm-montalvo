import {
  agruparNormalizado,
  departamentoDesdeCi,
  edadEnAnios,
  EXTRANJERO,
  normalizarTexto,
  sexoLegible,
  SIN_DATO,
  tramoDeEdad,
} from './normalizacion';

/*
 * Los casos salen de los valores REALES del volcado de FileMaker en producción:
 * 97 variantes distintas de `ciLugar` para una decena de lugares, y un `sexo`
 * con mayúsculas mezcladas. Si la normalización se rompe, el dashboard no da
 * error: reparte mal a 15.000 pacientes y nadie lo nota.
 */

describe('departamento desde el lugar de emisión del CI', () => {
  it('reconoce las abreviaturas que usa la clínica', () => {
    expect(departamentoDesdeCi('S.C.')).toBe('Santa Cruz'); // 8.971 fichas
    expect(departamentoDesdeCi('Cbba.')).toBe('Cochabamba');
    expect(departamentoDesdeCi('L.P.')).toBe('La Paz');
    expect(departamentoDesdeCi('Chuq.')).toBe('Chuquisaca');
    expect(departamentoDesdeCi('Tja.')).toBe('Tarija');
  });

  it('no distingue mayúsculas ni acentos', () => {
    expect(departamentoDesdeCi('sc')).toBe('Santa Cruz');
    expect(departamentoDesdeCi('SCZ')).toBe('Santa Cruz');
    expect(departamentoDesdeCi('oruro')).toBe('Oruro');
    expect(departamentoDesdeCi('Potosí')).toBe('Potosí');
    expect(departamentoDesdeCi('POTOSI')).toBe('Potosí');
  });

  // El volcado a veces guarda la ciudad en vez del departamento.
  it('resuelve la ciudad a su departamento', () => {
    expect(departamentoDesdeCi('Montero')).toBe('Santa Cruz');
    expect(departamentoDesdeCi('vallegrande')).toBe('Santa Cruz');
    expect(departamentoDesdeCi('Sucre')).toBe('Chuquisaca');
    expect(departamentoDesdeCi('trinidad')).toBe('Beni');
    expect(departamentoDesdeCi('Yacuiba')).toBe('Tarija');
  });

  // Son 197 brasileños, 68 colombianos y decenas más: agruparlos es honesto,
  // descartarlos falsearía el total.
  it('agrupa lo que no es departamento boliviano como extranjero', () => {
    expect(departamentoDesdeCi('Brasil')).toBe(EXTRANJERO);
    expect(departamentoDesdeCi('colombia')).toBe(EXTRANJERO);
    expect(departamentoDesdeCi('bogota')).toBe(EXTRANJERO);
    expect(departamentoDesdeCi('Pasaporte')).toBe(EXTRANJERO);
  });

  it('vacío es "sin dato", que no es lo mismo que extranjero', () => {
    expect(departamentoDesdeCi(null)).toBe(SIN_DATO);
    expect(departamentoDesdeCi('')).toBe(SIN_DATO);
    expect(departamentoDesdeCi('   ')).toBe(SIN_DATO);
  });
});

describe('sexo', () => {
  it('acepta la letra en cualquier caja', () => {
    expect(sexoLegible('F')).toBe('Femenino');
    expect(sexoLegible('f')).toBe('Femenino');
    expect(sexoLegible('M')).toBe('Masculino');
  });

  // En producción hay una `a` suelta y 538 vacíos.
  it('lo que no es F ni M queda sin dato, no se inventa', () => {
    expect(sexoLegible('a')).toBe(SIN_DATO);
    expect(sexoLegible(null)).toBe(SIN_DATO);
    expect(sexoLegible('')).toBe(SIN_DATO);
  });
});

describe('edad', () => {
  const hoy = new Date('2026-08-03');

  it('cuenta años cumplidos', () => {
    expect(edadEnAnios(new Date('1990-08-03'), hoy)).toBe(36);
  });

  it('no cuenta el año si aún no cumplió', () => {
    expect(edadEnAnios(new Date('1990-08-04'), hoy)).toBe(35);
  });

  // El volcado trae fechas corruptas; inventarles un tramo ensuciaría el gráfico.
  it('descarta fechas imposibles', () => {
    expect(edadEnAnios(new Date('2030-01-01'), hoy)).toBeNull();
    expect(edadEnAnios(new Date('1800-01-01'), hoy)).toBeNull();
    expect(edadEnAnios(null, hoy)).toBeNull();
  });

  it('ubica la edad en su tramo', () => {
    expect(tramoDeEdad(0)).toBe('0-12');
    expect(tramoDeEdad(12)).toBe('0-12');
    expect(tramoDeEdad(13)).toBe('13-17');
    expect(tramoDeEdad(30)).toBe('26-35');
    expect(tramoDeEdad(95)).toBe('60+');
    expect(tramoDeEdad(null)).toBe(SIN_DATO);
  });
});

describe('agrupar los conteos que devuelve SQL', () => {
  it('junta las variantes en un solo grupo y ordena por tamaño', () => {
    const filas = [
      { valor: 'S.C.', total: 8971 },
      { valor: 'sc', total: 4 },
      { valor: 'SCZ', total: 1 },
      { valor: 'Cbba.', total: 870 },
      { valor: 'Brasil', total: 197 },
      { valor: null, total: 50 },
    ];

    expect(agruparNormalizado(filas, departamentoDesdeCi)).toEqual([
      { etiqueta: 'Santa Cruz', total: 8976 },
      { etiqueta: 'Cochabamba', total: 870 },
      { etiqueta: EXTRANJERO, total: 197 },
      { etiqueta: SIN_DATO, total: 50 },
    ]);
  });

  // Postgres devuelve los COUNT como BigInt a través de Prisma.
  it('acepta los conteos como BigInt', () => {
    const filas = [{ valor: 'S.C.', total: 10n as unknown as bigint }];
    expect(agruparNormalizado(filas, departamentoDesdeCi)).toEqual([
      { etiqueta: 'Santa Cruz', total: 10 },
    ]);
  });
});

describe('normalizarTexto', () => {
  it('quita acentos, símbolos y espacios sobrantes', () => {
    expect(normalizarTexto('  Potosí ')).toBe('POTOSI');
    expect(normalizarTexto('-colombia')).toBe('COLOMBIA');
  });
});
