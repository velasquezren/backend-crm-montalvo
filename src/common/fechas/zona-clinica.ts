/**
 * El día de calendario de la clínica.
 *
 * **Por qué existe.** «Hoy», «vencida» y «próxima semana» son cortes de
 * CALENDARIO, y un calendario necesita una zona. El código los calculaba con
 * `new Date(anio, mes, dia)`, que usa la zona del proceso — y el VPS está en
 * Estados Unidos, no en Bolivia (ver `horario-atencion.ts`, que declara su zona
 * explícita justo por eso). Resultado: entre las 20:00 y la medianoche de La Paz
 * el servidor ya creía que era mañana, y una actividad de esta tarde se contaba
 * como VENCIDA en el KPI que la agente estaba mirando.
 *
 * **Lo que NO hace.** No cambia ningún instante almacenado. `fechaProgramada`
 * sigue siendo un instante en PostgreSQL; la zona solo decide dónde se parte el
 * día para contarlo.
 *
 * Va en `common/` y no dentro de Conversaciones porque la zona de la clínica no
 * es un detalle de WhatsApp: `horario-atencion.ts` importa de aquí su
 * `ZONA_POR_DEFECTO` para que en el backend exista **una sola** definición.
 *
 * Sin dependencias: `Intl` basta y ya es como resuelve su parte
 * `horario-atencion.ts`. Añadir `temporal-polyfill` al backend por esto sería
 * pagar una dependencia por cinco líneas.
 */

/** La clínica opera en Bolivia. El servidor, no. */
export const ZONA_CLINICA = 'America/La_Paz';

const FORMATO = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA_CLINICA,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

interface PartesEnClinica {
  anio: number;
  mes: number;
  dia: number;
  hora: number;
  minuto: number;
  segundo: number;
}

function partes(instante: Date): PartesEnClinica {
  const p = FORMATO.formatToParts(instante);
  const valor = (tipo: string) => Number(p.find(x => x.type === tipo)?.value ?? '0');
  return {
    anio: valor('year'),
    mes: valor('month'),
    dia: valor('day'),
    /* `hour12: false` puede dar «24» a medianoche en algunos entornos — el
       mismo cuidado que ya tiene `momentoEnZona`. */
    hora: valor('hour') % 24,
    minuto: valor('minute'),
    segundo: valor('second'),
  };
}

/**
 * Cuánto va la zona por delante de UTC en ese instante, en milisegundos.
 *
 * Los milisegundos se toman del instante y no del formateador: `Intl` no los
 * da, y sin ellos el desfase sale con la parte fraccionaria del instante
 * pegada. Se notaba justo en el borde —un milisegundo antes de medianoche la
 * medianoche calculada salía `…04:00:00.999Z`—, que es donde importa.
 */
function desfase(instante: Date): number {
  const p = partes(instante);
  const comoSiFueraUtc = Date.UTC(
    p.anio, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo, instante.getUTCMilliseconds(),
  );
  return comoSiFueraUtc - instante.getTime();
}

/**
 * Resuelve el instante en que empieza un día de calendario de la clínica.
 *
 * Dos pasadas a propósito: la primera aproxima con el desfase del instante de
 * partida y la segunda lo corrige con el que rige de verdad en esa medianoche.
 * Bolivia no cambia la hora, así que hoy la segunda pasada nunca corrige nada;
 * está para que la utilidad no mienta si alguna vez se usa con otra zona.
 */
function medianocheDe(anio: number, mes: number, dia: number, referencia: Date): Date {
  const comoSiFueraUtc = Date.UTC(anio, mes - 1, dia);
  const aproximado = comoSiFueraUtc - desfase(referencia);
  return new Date(comoSiFueraUtc - desfase(new Date(aproximado)));
}

/** El instante en que empezó el día de la clínica que contiene a `instante`. */
export function inicioDelDiaClinica(instante: Date): Date {
  const { anio, mes, dia } = partes(instante);
  return medianocheDe(anio, mes, dia, instante);
}

/**
 * `dias` días de calendario después del inicio de día dado.
 *
 * Suma sobre el calendario, no 24 h por día: `Date.UTC` resuelve solo el salto
 * de mes y de año, y la corrección de desfase deja el resultado en medianoche
 * aunque por medio hubiera un cambio de hora.
 */
export function sumarDiasClinica(inicioDeDia: Date, dias: number): Date {
  const { anio, mes, dia } = partes(inicioDeDia);
  return medianocheDe(anio, mes, dia + dias, inicioDeDia);
}
