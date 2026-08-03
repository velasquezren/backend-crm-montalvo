import { normalizar } from './clasificador';

/**
 * Reglas puras del cálculo de comisiones.
 *
 * Viven aparte del servicio por la misma razón que `clasificador.ts`: son las
 * decisiones que mueven dinero —qué nivel te toca, cuántos planes comisionan,
 * qué tarifa aplica— y conviene poder probarlas sin base de datos ni Nest.
 * El servicio se queda con lo que sí necesita Prisma: leer, agrupar y guardar.
 */

/** Tramo de la escala de cirugías, con lo mínimo que hace falta para resolverlo. */
export interface TramoCirugia {
  nivel: number;
  montoDesde: unknown;
}

/** Tarifa de un procedimiento del área de Reproducción Asistida. */
export interface TarifaProcedimiento {
  procedimiento: string;
}

/**
 * Nivel de cirugías según el acumulado del mes: el más alto cuyo piso no supere
 * el acumulado.
 *
 * No es lo mismo que "el primer tramo que contenga el monto". Los tramos se
 * tocan (1.000–5.000 y 5.000–10.000), así que con exactamente 5.000 una
 * comparación `desde <= x <= hasta` casa con los dos y gana el primero de la
 * lista — el que paga menos. Aquí la frontera pertenece siempre al tramo
 * superior, que es como resuelve la búsqueda aproximada de la planilla.
 *
 * Por encima del último tramo se aplica ese último: no se extrapola un nivel
 * que nadie definió.
 */
export function resolverNivelCirugia(
  acumulado: number,
  tramos: readonly TramoCirugia[],
): number | null {
  let elegido: number | null = null;
  let mejorDesde = -Infinity;

  for (const tramo of tramos) {
    const desde = Number(tramo.montoDesde);
    if (acumulado >= desde && desde >= mejorDesde) {
      mejorDesde = desde;
      elegido = tramo.nivel;
    }
  }
  return elegido;
}

/**
 * Cuántos planes comisionan. El objetivo es una **franquicia**: solo cuenta lo
 * que lo supera. Igualarlo paga cero — en diciembre 2024 una vendedora hizo 4
 * paquetes con objetivo 4 y no cobró Tipo A.
 */
export function planesComisionables(vendidos: number, objetivo: number): number {
  return Math.max(0, vendidos - objetivo);
}

/**
 * Qué proporción de la base de un grupo llega a comisionar.
 *
 * Los planes de una misma clasificación se reparten en varios grupos (por nivel
 * y por canal), así que el excedente se prorratea entre ellos según la cantidad.
 * Reproduce exacto el caso de PLANNIN de diciembre 2024: 2 vendidos, objetivo 1,
 * base 1.747,48 → (1.747,48 / 2) × 1 × 3% = 26,21.
 */
export function fraccionComisionable(vendidos: number, objetivo: number): number {
  if (vendidos <= 0) return 0;
  return planesComisionables(vendidos, objetivo) / vendidos;
}

/**
 * Los `meses - 1` meses anteriores al que se liquida, como pares año/mes.
 * Cruza el cambio de año sin cuentas a mano: enero con ventana de 3 devuelve
 * diciembre y noviembre del año pasado.
 */
export function mesesAnteriores(
  anio: number,
  mes: number,
  meses: number,
): { anio: number; mes: number }[] {
  const filtros: { anio: number; mes: number }[] = [];
  for (let i = 1; i < meses; i++) {
    const fecha = new Date(anio, mes - 1 - i, 1);
    filtros.push({ anio: fecha.getFullYear(), mes: fecha.getMonth() + 1 });
  }
  return filtros;
}

/**
 * Elige la tarifa RA que cruza con MÁS texto del detalle, no la primera de la
 * lista.
 *
 * Varios procedimientos comparten palabras —"Histeroscopia" está contenido en
 * "Laparoscopia + Histeroscopia"— y con un `find` el resultado dependía del
 * orden en que la base devolviera las filas: la misma venta podía pagar
 * distinto entre dos cálculos. Puntuar por longitud hace que gane siempre la
 * coincidencia más específica.
 *
*/
export function elegirTarifaRA<T extends TarifaProcedimiento>(
  detalle: string,
  tarifas: readonly T[],
): T | undefined {
  const objetivo = normalizar(detalle);
  let elegida: T | undefined;
  let mejorPuntaje = 0;

  for (const tarifa of tarifas) {
    const claves = normalizar(tarifa.procedimiento)
      .split(/[^A-ZÑ0-9]+/)
      .filter(palabra => palabra.length > 3);

    const puntaje = claves
      .filter(clave => objetivo.includes(clave))
      .reduce((suma, clave) => suma + clave.length, 0);

    if (puntaje > mejorPuntaje) {
      mejorPuntaje = puntaje;
      elegida = tarifa;
    }
  }
  return elegida;
}

/** Lo que cobra alguien en bonos. Un solo lugar donde se define qué suma. */
export function sumaBonos(registro: {
  bonoJefatura: unknown;
  bonoPublicidad: unknown;
  bonoTrimestral: unknown;
}): number {
  return (
    Number(registro.bonoJefatura) + Number(registro.bonoPublicidad) + Number(registro.bonoTrimestral)
  );
}

/**
 * ¿Este mes cierra un trimestre calendario? (marzo, junio, septiembre, diciembre)
 *
 * El bono trimestral premia el promedio de tres meses, así que solo tiene
 * sentido liquidarlo cuando el trimestre está completo. Pagarlo todos los meses
 * lo cobraría tres veces, y en el primer mes del trimestre el "promedio" sería
 * un solo mes — que es justo lo que pasaba: en enero de 2026 el motor pagaba
 * 213,63 a quien facturó 42.725, con un único mes de historia.
 *
 * Diciembre, el mes de la planilla de referencia, es cierre de trimestre; por
 * eso allí ambos criterios daban el mismo número y la diferencia no se veía.
 */
export function cierraTrimestre(mes: number): boolean {
  return mes % 3 === 0;
}

/** Un plan candidato a comisionar, con lo mínimo que la selección necesita. */
export interface PlanCandidato {
  id: string;
  /** Base de cálculo del plan, ya sin impuestos. */
  base: number;
  /**
   * Decisión de administración. `null` = todavía no la tomó y decide el
   * sistema; `true` = este plan comisiona sí o sí; `false` = este no.
   */
  comisionaPlan: boolean | null;
}

export interface SeleccionPlanes {
  /** Ids que comisionan. */
  readonly elegidos: ReadonlySet<string>;
  /** Cuántos podían comisionar: vendidos − objetivo. */
  readonly cupo: number;
  /** Marcados a mano que no entraron porque el cupo ya estaba lleno. */
  readonly descartadosPorCupo: readonly string[];
}

/**
 * Qué planes concretos comisionan cuando alguien supera su objetivo.
 *
 * En la planilla de la clínica esto **no era una fórmula**: la columna
 * `PLANPAG COMISIONABLE` de la hoja `Ejecutivas` se escribe a mano — en
 * diciembre solo la fila 143 decía "COMISIONA" — y la de al lado paga
 * `% × base` del plan marcado, su base completa y con la tarifa de su propio
 * nivel. No se reparte nada entre los demás.
 *
 * Por eso aquí no se inventa una regla: se respeta lo que administración marcó
 * y solo se rellena el resto. El criterio automático es **la base más baja
 * primero**, que es lo que hicieron en diciembre (con 5 paquetes y objetivo 4
 * comisionó un Bronce de 2.102,79, no uno de los Gold de 3.001,50).
 *
 * El cupo es un tope duro: si marcaron más planes de los que el objetivo
 * permite, los sobrantes se devuelven en `descartadosPorCupo` para que la
 * pantalla lo muestre, en vez de pagar de más en silencio.
 */
export function seleccionarPlanesComisionables(
  planes: readonly PlanCandidato[],
  objetivo: number,
): SeleccionPlanes {
  const cupo = planesComisionables(planes.length, objetivo);
  if (cupo <= 0) {
    return { elegidos: new Set(), cupo: 0, descartadosPorCupo: [] };
  }

  // Base ascendente, y a igualdad de base un orden estable por id: dos cálculos
  // del mismo periodo tienen que dar exactamente lo mismo.
  const porBaseAscendente = [...planes].sort((a, b) => a.base - b.base || a.id.localeCompare(b.id));

  const elegidos = new Set<string>();
  const descartadosPorCupo: string[] = [];

  // 1. Lo que administración marcó manda, hasta llenar el cupo.
  for (const plan of porBaseAscendente) {
    if (plan.comisionaPlan !== true) continue;
    if (elegidos.size < cupo) elegidos.add(plan.id);
    else descartadosPorCupo.push(plan.id);
  }

  // 2. El resto del cupo se completa solo, sin tocar los descartados a mano.
  for (const plan of porBaseAscendente) {
    if (elegidos.size >= cupo) break;
    if (plan.comisionaPlan === null && !elegidos.has(plan.id)) elegidos.add(plan.id);
  }

  return { elegidos, cupo, descartadosPorCupo };
}
