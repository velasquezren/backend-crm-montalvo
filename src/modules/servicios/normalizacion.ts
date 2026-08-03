/**
 * Normalización de los datos demográficos de la ficha del paciente.
 *
 * Vienen de un volcado de FileMaker donde eran **texto libre**, así que agrupar
 * por el valor crudo no sirve: `ciLugar` tiene 97 variantes distintas para
 * ~10 lugares reales (`S.C.`, `sc`, `SC`, `SCZ`, `montero`…), y `sexo` trae
 * `F`, `M`, `f`, `a` y vacíos.
 *
 * Es puro y se prueba sin base de datos, igual que `clasificador.ts`. La
 * agregación lo aplica sobre los grupos que devuelve SQL —que son pocos— en vez
 * de duplicar estas reglas en un `CASE`: así el criterio vive en un solo lugar.
 */

/** Cómo se muestra un valor que el volcado no trae. */
export const SIN_DATO = 'Sin dato';

/** Lo que no es un departamento boliviano reconocible. */
export const EXTRANJERO = 'Extranjero u otro';

export const DEPARTAMENTOS = [
  'Santa Cruz',
  'La Paz',
  'Cochabamba',
  'Chuquisaca',
  'Tarija',
  'Beni',
  'Oruro',
  'Potosí',
  'Pando',
] as const;

export type Departamento = (typeof DEPARTAMENTOS)[number] | typeof EXTRANJERO | typeof SIN_DATO;

/**
 * Variantes vistas en los datos reales, ya normalizadas (mayúsculas, sin
 * acentos). Incluye ciudades porque el volcado a veces guarda la localidad en
 * vez del departamento: `MONTERO` y `VALLEGRANDE` son Santa Cruz, `TRINIDAD` es
 * Beni, `SUCRE` es Chuquisaca y `YACUIBA` es Tarija.
 */
const POR_DEPARTAMENTO: ReadonlyArray<readonly [(typeof DEPARTAMENTOS)[number], readonly string[]]> =
  [
    ['Santa Cruz', ['S.C.', 'SC', 'SCZ', 'SANTA CRUZ', 'MONTERO', 'VALLEGRANDE']],
    ['La Paz', ['L.P.', 'LP', 'LA PAZ', 'EL ALTO']],
    ['Cochabamba', ['CBBA.', 'CBBA', 'COCHABAMBA']],
    ['Chuquisaca', ['CHUQ.', 'CHUQ', 'CHUQUISACA', 'SUCRE']],
    ['Tarija', ['TARIJA', 'TJA.', 'TJA', 'YACUIBA', 'BERMEJO']],
    ['Beni', ['BENI', 'TRINIDAD', 'RIBERALTA', 'GUAYARAMERIN']],
    ['Oruro', ['ORURO']],
    ['Potosí', ['POTOSI', 'LLALLAGUA', 'UYUNI']],
    ['Pando', ['PANDO', 'COBIJA']],
  ];

const INDICE_DEPARTAMENTO: ReadonlyMap<string, (typeof DEPARTAMENTOS)[number]> = new Map(
  POR_DEPARTAMENTO.flatMap(([departamento, variantes]) =>
    variantes.map(v => [v, departamento] as const),
  ),
);

/** Mayúsculas, sin acentos ni espacios sobrantes. */
export function normalizarTexto(texto: string | null | undefined): string {
  return (texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s.]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/**
 * Departamento a partir del lugar de emisión del CI.
 *
 * Lo que no cruza con un departamento boliviano se agrupa como
 * **extranjero u otro**, no se descarta: en el volcado hay 197 brasileños, 68
 * colombianos y decenas de otros países, y esconderlos falsearía el total.
 * Un valor vacío es `Sin dato`, que es distinto de "extranjero".
 */
export function departamentoDesdeCi(ciLugar: string | null | undefined): Departamento {
  const valor = normalizarTexto(ciLugar);
  if (!valor) return SIN_DATO;
  return INDICE_DEPARTAMENTO.get(valor) ?? EXTRANJERO;
}

/** Etiquetas de sexo. `sexo` viene como una sola letra y con mayúsculas mezcladas. */
export function sexoLegible(sexo: string | null | undefined): 'Femenino' | 'Masculino' | typeof SIN_DATO {
  const valor = normalizarTexto(sexo);
  if (valor === 'F') return 'Femenino';
  if (valor === 'M') return 'Masculino';
  // Hay una `a` suelta y 538 vacíos: cualquier cosa que no sea F o M es sin dato.
  return SIN_DATO;
}

/**
 * Tramos de edad, pensados para una clínica materno-infantil: separan la edad
 * pediátrica, la fértil (que es el grueso del negocio) y la posterior.
 */
export const TRAMOS_EDAD = [
  { etiqueta: '0-12', desde: 0, hasta: 12 },
  { etiqueta: '13-17', desde: 13, hasta: 17 },
  { etiqueta: '18-25', desde: 18, hasta: 25 },
  { etiqueta: '26-35', desde: 26, hasta: 35 },
  { etiqueta: '36-45', desde: 36, hasta: 45 },
  { etiqueta: '46-59', desde: 46, hasta: 59 },
  { etiqueta: '60+', desde: 60, hasta: 200 },
] as const;

/**
 * Edad en años cumplidos a día de hoy.
 *
 * Se calcula, nunca se guarda: el volcado de FileMaker traía la edad del día de
 * la exportación y hoy miente hasta en 18 años (ver `Cliente.fechaNacimiento`).
 */
export function edadEnAnios(fechaNacimiento: Date | null | undefined, hoy = new Date()): number | null {
  if (!fechaNacimiento) return null;
  const nacimiento = new Date(fechaNacimiento);
  if (Number.isNaN(nacimiento.getTime())) return null;

  let edad = hoy.getFullYear() - nacimiento.getFullYear();
  const cumpleEsteAnio =
    hoy.getMonth() > nacimiento.getMonth() ||
    (hoy.getMonth() === nacimiento.getMonth() && hoy.getDate() >= nacimiento.getDate());
  if (!cumpleEsteAnio) edad -= 1;

  // Fechas corruptas del volcado (año 1900, o futuras) no deben inventar tramos.
  return edad >= 0 && edad <= 120 ? edad : null;
}

/** Tramo al que pertenece una edad, o `Sin dato` si no se pudo calcular. */
export function tramoDeEdad(edad: number | null): string {
  if (edad === null) return SIN_DATO;
  return TRAMOS_EDAD.find(t => edad >= t.desde && edad <= t.hasta)?.etiqueta ?? SIN_DATO;
}

/**
 * Suma los conteos que SQL devuelve por valor crudo en los grupos ya
 * normalizados. SQL agrupa por el texto libre (97 filas como mucho) y aquí se
 * juntan: una sola consulta, y el criterio de normalización sin duplicar.
 */
export function agruparNormalizado<T extends string>(
  filas: ReadonlyArray<{ valor: string | null; total: number | bigint }>,
  normalizador: (valor: string | null) => T,
): Array<{ etiqueta: T; total: number }> {
  const acumulado = new Map<T, number>();
  for (const fila of filas) {
    const etiqueta = normalizador(fila.valor);
    acumulado.set(etiqueta, (acumulado.get(etiqueta) ?? 0) + Number(fila.total));
  }
  return [...acumulado]
    .map(([etiqueta, total]) => ({ etiqueta, total }))
    .sort((a, b) => b.total - a.total);
}
