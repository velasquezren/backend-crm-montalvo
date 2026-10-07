/**
 * El horario de un médico en la agenda ScriptCase, en sus dos formas:
 *
 * - `horarios`: una fila por casilla de 30 minutos, día por día (Lunes…Sabado,
 *   sin tildes y sin Domingo), que se enciende o apaga con `estado` ACTIVO /
 *   INACTIVO. Es lo que da cupos: la vista `vista_horas_libres` sale de aquí.
 * - `medicos.horario_html`: el recuadro verde de 6 × 2 cm que muestran la web de
 *   ScriptCase y la landing. Además decide la modalidad: con HTML el médico se
 *   reserva en línea; vacío, «a solicitud» (`agenda.sql.ts`).
 *
 * ScriptCase escribe el HTML a mano en su panel. El CRM lo REGENERA desde las
 * casillas cada vez que guarda un horario, con la plantilla exacta que está en
 * producción (copiada del médico 20 el 7/10/2026, estilos incluidos), para que
 * el recuadro diga siempre lo mismo que los cupos.
 */

/** Los días de la agenda, como los escribe ScriptCase en `horarios.dia`. */
export const DIAS_AGENDA = ['Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado'] as const;
export type DiaAgenda = (typeof DIAS_AGENDA)[number];

const ABREVIATURA: Record<DiaAgenda, string> = {
  Lunes: 'Lun', Martes: 'Mar', Miercoles: 'Mié', Jueves: 'Jue', Viernes: 'Vie', Sabado: 'Sáb',
};

/** Una casilla encendida: día y hora de inicio (HH:MM). */
export interface CasillaActiva {
  dia: DiaAgenda;
  hora: string;
}

/** Desde esta hora, la casilla es de la TARDE. */
export const INICIO_TARDE = '13:00';

/** «09:30» → «9:30», como escribe ScriptCase. */
const sinCeroInicial = (hora: string) => hora.replace(/^0(\d)/, '$1');

/** «9:30-11:00»: la primera y la última casilla del turno (la última es la hora de inicio de su turno de 30 min). */
function rango(horas: string[]): string {
  if (horas.length === 0) return '';
  const orden = [...horas].sort();
  const primera = sinCeroInicial(orden[0]);
  const ultima = sinCeroInicial(orden[orden.length - 1]);
  return primera === ultima ? primera : `${primera}-${ultima}`;
}

const BORDE = 'border: 0.5px solid rgba(255,255,255,0.4);';
const TH = `<th style="${BORDE} font-size: 7px; text-transform: uppercase; padding: 2px 0;">`;
const TD_TURNO = `<td style="${BORDE} font-size: 6px; font-weight: bold; text-align: left; padding-left: 3px;">`;
const TD = `<td style="${BORDE} font-size: 7px; text-align: center;">`;
const TD_VACIA = `<td style="${BORDE} font-size: 7px; text-align: center; background-color: rgba(255,255,255,0.15);">`;

function fila(turno: string, celdas: string[]): string {
  return [
    '      <tr>',
    `        ${TD_TURNO}${turno}</td>`,
    ...celdas.map(c => `        ${c ? TD : TD_VACIA}${c}</td>`),
    '      </tr>',
  ].join('\n');
}

/**
 * El `horario_html` de ScriptCase para estas casillas, o '' si no queda
 * ninguna encendida: un médico sin casillas no se puede reservar en línea, y
 * con el HTML vacío la web lo ofrece «a solicitud» en vez de un calendario sin cupos.
 */
export function horarioHtml(casillas: readonly CasillaActiva[]): string {
  if (casillas.length === 0) return '';
  const turno = (dia: DiaAgenda, tarde: boolean) =>
    rango(casillas.filter(c => c.dia === dia && (c.hora >= INICIO_TARDE) === tarde).map(c => c.hora));
  return [
    '<div style="width: 6cm; height: 2cm; border: 1px solid #2d8c85; background-color: #39ada3; display: flex; align-items: center; justify-content: center; font-family: sans-serif; box-sizing: border-box; overflow: hidden; margin: 0 auto; color: #ffffff;">',
    '  <table style="width: 100%; border-collapse: collapse; table-layout: fixed;">',
    '    <thead>',
    '      <tr style="background-color: rgba(0,0,0,0.1);">',
    `        ${TH}</th>`,
    ...DIAS_AGENDA.map(d => `        ${TH}${ABREVIATURA[d]}</th>`),
    '      </tr>',
    '    </thead>',
    '    <tbody>',
    fila('MAÑANA', DIAS_AGENDA.map(d => turno(d, false))),
    fila('TARDE', DIAS_AGENDA.map(d => turno(d, true))),
    '    </tbody>',
    '  </table>',
    '</div>',
  ].join('\n');
}

/** Una hora de casilla válida: HH:MM en punto o y media, de 05:00 a 22:30. */
export const HORA_CASILLA = /^(0[5-9]|1\d|2[0-2]):(00|30)$/;

/**
 * Las horas que muestra la grilla del CRM: de 07:00 a 20:30 cada media hora,
 * más cualquier hora que el médico ya tenga en la agenda fuera de ese rango
 * (ScriptCase admite cualquiera; la grilla no esconde ninguna).
 */
export function horasDeLaGrilla(existentes: readonly string[]): string[] {
  const base: string[] = [];
  for (let minuto = 7 * 60; minuto <= 20 * 60 + 30; minuto += 30) {
    base.push(`${String(Math.floor(minuto / 60)).padStart(2, '0')}:${String(minuto % 60).padStart(2, '0')}`);
  }
  return [...new Set([...base, ...existentes])].sort();
}
