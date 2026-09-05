import { AreaVendedora, TipoVendedora } from '../../prisma/prisma-client';

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
  /**
   * Correlativo con el que se registró la venta (`Cod. Origen` del export,
   * "VE1462"). Es lo que ordena los planes de menor a mayor antigüedad.
   */
  codOrigen: string | null;
  /** Fecha de la venta. Solo desempata cuando falta el correlativo. */
  fecha: Date | null;
  /**
   * Decisión de administración. `null` = todavía no la tomó y decide el
   * sistema; `true` = este plan comisiona sí o sí; `false` = este no.
   */
  comisionaPlan: boolean | null;
}

/**
 * El número dentro de un `Cod. Origen`. "VE1462" → 1462.
 *
 * Se compara el número y no el texto porque el prefijo es fijo pero el ancho
 * no: como texto, "VE999" iría después de "VE1000" y el último plan del mes
 * dejaría de ser el último justo al cruzar el millar.
 */
function correlativo(codOrigen: string | null): number | null {
  if (!codOrigen) return null;
  const digitos = codOrigen.replace(/\D+/g, '');
  return digitos === '' ? null : Number(digitos);
}

/**
 * Ordena los planes del último registrado al primero.
 *
 * El criterio es el correlativo de registro, no la fecha de la venta: en
 * diciembre 2025 la venta VE1458 lleva fecha 22/12 y la VE1465 lleva 22/12
 * también, mientras VE1469 y VE1470 —posteriores— llevan 17 y 19/12. Ordenar
 * por fecha habría elegido otros planes que los que la planilla marcó.
 *
 * Sin correlativo se cae a la fecha, y a falta de las dos al id, para que dos
 * cálculos del mismo periodo den siempre lo mismo.
 *
 * Exportada porque `exportacion-comisiones.service.ts` necesita mostrar los
 * planes de una vendedora en el mismo orden en que el motor decide cuáles
 * comisionan — repetir este criterio a mano en el exportador sería la
 * tercera copia (la primera es esta, la segunda la reproduce el frontend
 * para la vista previa en pantalla, con la misma deuda ya documentada ahí).
 */
export function ultimoPrimero(a: PlanCandidato, b: PlanCandidato): number {
  const ca = correlativo(a.codOrigen);
  const cb = correlativo(b.codOrigen);
  if (ca !== null && cb !== null && ca !== cb) return cb - ca;

  const fa = a.fecha?.getTime() ?? null;
  const fb = b.fecha?.getTime() ?? null;
  if (fa !== null && fb !== null && fa !== fb) return fb - fa;

  return b.id.localeCompare(a.id);
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
 * Qué planes concretos comisionan cuando alguien supera su objetivo:
 * **los últimos vendidos**, tantos como diga el cupo.
 *
 * En la planilla de la clínica esto **no es una fórmula**: la columna
 * `PLANPAG COMISIONABLE` de la hoja `BDEjecutivas` se escribe a mano, y la de
 * al lado paga `% de esa fila × base de esa fila`. No se reparte nada entre los
 * demás planes ni se promedia: cada plan elegido cobra con SU base y SU tarifa,
 * que no tienen por qué ser iguales.
 *
 * Cuáles marcaron a mano en diciembre 2025 no es ambiguo — son los últimos por
 * correlativo de registro, en las dos vendedoras que superaron el objetivo:
 *
 *   Claudia  1447 1452 1454 1457 **1458 1462**   6 vendidos, objetivo 4
 *   Yelca    1449 1461 1463 1465 **1469 1470**   6 vendidos, objetivo 4
 *
 * Y el orden importa en plata, porque la tarifa va por fila: los dos de Claudia
 * pagaron 3 % × 2.106,62 + 2 % × 1.886,62 = 100,93. Elegir en cambio sus dos
 * planes más baratos —que es lo que hacía este código antes— daba 50,65, la
 * mitad de lo que la clínica pagó.
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

  const delUltimoAlPrimero = [...planes].sort(ultimoPrimero);

  const elegidos = new Set<string>();
  const descartadosPorCupo: string[] = [];

  // 1. Lo que administración marcó manda, hasta llenar el cupo.
  for (const plan of delUltimoAlPrimero) {
    if (plan.comisionaPlan !== true) continue;
    if (elegidos.size < cupo) elegidos.add(plan.id);
    else descartadosPorCupo.push(plan.id);
  }

  // 2. El resto del cupo se completa con los más recientes que quedan, sin
  //    tocar los que administración descartó a mano.
  for (const plan of delUltimoAlPrimero) {
    if (elegidos.size >= cupo) break;
    if (plan.comisionaPlan === null && !elegidos.has(plan.id)) elegidos.add(plan.id);
  }

  return { elegidos, cupo, descartadosPorCupo };
}

/**
 * Bono trimestral: 0,5 % del PROMEDIO de facturación del trimestre.
 *
 * El promedio no es solo el requisito para cobrarlo — es la base sobre la que
 * se paga. Se compara en bruto (antes de impuestos) y en dólares, y el umbral
 * es el mismo para todas: 15.000, incluso para quien tiene objetivo mensual de
 * 12.000.
 *
 * Verificado contra `CALCULO COMISION DICIEMBRE 2025.xlsx` (hoja CALCULO BONOS,
 * filas 71-74) reproduciendo los tres meses desde los export de FileMaker.
 */
export function bonoTrimestralUsd(
  promedioTrimestreUsd: number,
  objetivoTrimestralUsd: number,
  factor: number,
): number {
  if (promedioTrimestreUsd <= objetivoTrimestralUsd) return 0;
  return promedioTrimestreUsd * factor;
}

/**
 * Lo que cada vendedora aporta al pote de jefatura: 0,2 % de su EXCEDENTE
 * sobre el objetivo mensual, no de su facturación entera.
 *
 * Quien no llega al objetivo no aporta nada. El pote resultante se paga dos
 * veces —íntegro a la jefatura y otro tanto repartido entre publicidad—, y
 * quien lo genera no cobra nada de él.
 */
/**
 * Quién entra en la planilla del mes aunque no haya vendido nada.
 *
 * El equipo de marketing (`AreaVendedora.PUBLICIDAD`) no vende: no tiene
 * `vendedora_pk` ni aparece nunca en el export de FileMaker. Su pago es la
 * mitad del pote de jefatura, que sale del excedente de LAS OTRAS. Si el
 * cálculo las descarta por no tener filas, el pote de publicidad se reparte
 * entre cero personas y se pierde sin que nada falle.
 *
 * La jefa está por la misma razón y no por simetría: su bono también sale del
 * pote del equipo, así que un mes en el que no venda tampoco puede dejarla
 * fuera de la planilla.
 *
 * Todo lo demás sigue igual: quien no vendió sale con ceros en las columnas de
 * comisión —los ayudantes de cálculo devuelven 0 cuando no se supera el
 * objetivo— y cobra solo su bono y su sueldo. Es la fila que la planilla de
 * administración ya tiene: hoja "GRAL COM", filas 75-76 de diciembre 2025.
 */
export function cobraSinVender(vendedora: {
  tipo: TipoVendedora;
  area: AreaVendedora;
}): boolean {
  return vendedora.area === AreaVendedora.PUBLICIDAD || vendedora.tipo === TipoVendedora.JEFA;
}

/** Cuánto le toca a cada persona del pote de jefatura. */
export interface RepartoPote {
  /** Lo que cobra cada jefa. El pote ÍNTEGRO, dividido entre las jefas que haya. */
  porJefa: number;
  /** Lo que cobra cada persona de marketing. Otro pote íntegro, repartido. */
  porPublicidad: number;
}

/**
 * El pote se paga DOS VECES: entero a la jefatura y otro tanto igual repartido
 * entre el equipo de marketing. No se parte en dos mitades.
 *
 * Verificado contra `CALCULO COMISION DICIEMBRE 2025.xlsx`. El pote que generan
 * las cuatro ejecutivas con su excedente suma 66,69 USD (Viviana 23,28, Yelca
 * 17,52, Zuany 13,69, Claudia 12,20 — hoja "CALCULO BONOS", filas 18-22), y ese
 * mismo número aparece dos veces en el pago:
 *
 *   fila 23      JEFA Guzman Flores Viviana ....... 66,69 USD = 464,83 Bs
 *   filas 47-51  EQUIPO DE PUBLICIDAD ............. 33,35 + 33,35 = 66,69
 *
 * Las que lo generan cobran CERO por este concepto: en la planilla su columna
 * de bonos está vacía.
 *
 * **Un lado vacío no le regala su parte al otro.** Si no hay nadie en
 * marketing, la jefa cobra su pote igual y el de publicidad no se paga — no se
 * acumula ni se reparte entre las ejecutivas. Son dos pagos independientes que
 * salen del mismo número, no un reparto de una bolsa común.
 */
export function repartirPote(
  pote: number,
  cantidadJefas: number,
  cantidadPublicidad: number,
): RepartoPote {
  if (pote <= 0) return { porJefa: 0, porPublicidad: 0 };
  return {
    porJefa: cantidadJefas > 0 ? pote / cantidadJefas : 0,
    porPublicidad: cantidadPublicidad > 0 ? pote / cantidadPublicidad : 0,
  };
}

export function aporteAlPoteJefatura(
  montoVendidoUsd: number,
  objetivoMensualUsd: number,
  factor: number,
): number {
  if (montoVendidoUsd <= objetivoMensualUsd) return 0;
  return (montoVendidoUsd - objetivoMensualUsd) * factor;
}
