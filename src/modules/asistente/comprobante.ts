/**
 * La lectura de un comprobante de pago, comparada con lo que se esperaba.
 *
 * El modelo LEE (monto, fecha, referencia, a nombre de quién); este código
 * COMPARA, y se prueba sin red. Nada de aquí confirma un pago: quien verifica
 * ve «Bs 280 · coincide» o «dice Bs 250, se esperaba Bs 280» y decide ella. Lo
 * que ahorra es leer la foto con lupa, y lo que agrega es lo que a ojo no se ve:
 * que esa misma referencia ya llegó en otro pago (un comprobante reutilizado).
 */
import type { DatosComprobante } from './modelo.port';

export type EstadoVerificacion = 'OK' | 'ADVERTENCIA' | 'ALERTA';

export interface Verificacion {
  readonly campo: 'COMPROBANTE' | 'MONTO' | 'DESTINATARIO' | 'FECHA' | 'REFERENCIA';
  readonly estado: EstadoVerificacion;
  readonly texto: string;
}

/** Lo que se guarda en `PagoPromocion.lecturaComprobante`. */
export interface LecturaComprobante {
  readonly version: 1;
  /** El mensaje leído: si el comprobante cambia, esta lectura ya no vale. */
  readonly mensajeId: string;
  readonly leidoEn: string;
  readonly modelo: string;
  readonly datos: DatosComprobante;
  readonly verificaciones: readonly Verificacion[];
  readonly resultado: 'COINCIDE' | 'REVISAR' | 'NO_ES_COMPROBANTE';
  /** La referencia como se compara entre pagos (`referenciaComparable`): así se busca un comprobante repetido. */
  readonly referenciaNormalizada: string | null;
}

export interface Esperado {
  /** En Bs. */
  readonly monto: number;
  /** El titular del QR de la línea. */
  readonly titular: string | null;
  /** Desde cuándo pudo pagar: cuando se le mandó el QR. */
  readonly pedidoEn: Date;
  readonly ahora: Date;
  /** Esa referencia ya está en la lectura de OTRO pago. */
  readonly referenciaRepetida: boolean;
}

/** Bolivia no tiene horario de verano: −04:00 todo el año. */
const DESFASE_LA_PAZ = '-04:00';
/** Los relojes de los bancos y el nuestro no coinciden al minuto. */
const TOLERANCIA_MS = 60 * 60 * 1000;

const bs = (n: number) => `Bs ${n.toLocaleString('es-BO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function evaluarComprobante(d: DatosComprobante, e: Esperado): Pick<LecturaComprobante, 'verificaciones' | 'resultado'> {
  if (!d.esComprobante) {
    return {
      verificaciones: [{ campo: 'COMPROBANTE', estado: 'ALERTA', texto: 'No parece un comprobante de pago.' }],
      resultado: 'NO_ES_COMPROBANTE',
    };
  }
  const v: Verificacion[] = [monto(d, e), destinatario(d, e), fecha(d, e), referencia(d, e)];
  return { verificaciones: v, resultado: v.every(x => x.estado === 'OK') ? 'COINCIDE' : 'REVISAR' };
}

function monto(d: DatosComprobante, e: Esperado): Verificacion {
  if (d.monto === null) return { campo: 'MONTO', estado: 'ALERTA', texto: `No se leyó el monto. Se esperaba ${bs(e.monto)}.` };
  const moneda = (d.moneda ?? '').toUpperCase().replace(/[^A-Z$]/g, '');
  if (moneda && !['BS', 'BOB'].includes(moneda)) return { campo: 'MONTO', estado: 'ALERTA', texto: `Dice ${d.monto} ${d.moneda}: no está en bolivianos.` };
  if (Math.round(d.monto * 100) === Math.round(e.monto * 100)) return { campo: 'MONTO', estado: 'OK', texto: `${bs(d.monto)}, coincide.` };
  return { campo: 'MONTO', estado: 'ALERTA', texto: `Dice ${bs(d.monto)}; se esperaba ${bs(e.monto)}.` };
}

/** Sin tildes, sin signos, en minúscula: «Clínica Montalvo S.R.L.» → «clinica montalvo s r l». */
function normalizar(texto: string): string[] {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9*]+/g, ' ')
    .split(' ')
    .filter(p => p.length >= 3 && !p.includes('*'));
}

function destinatario(d: DatosComprobante, e: Esperado): Verificacion {
  if (!e.titular) return { campo: 'DESTINATARIO', estado: 'ADVERTENCIA', texto: 'El QR de la línea no tiene titular cargado para comparar.' };
  if (!d.destinatario) return { campo: 'DESTINATARIO', estado: 'ADVERTENCIA', texto: `No se leyó a nombre de quién; el QR es de ${e.titular}.` };
  const leido = normalizar(d.destinatario);
  const titular = normalizar(e.titular);
  const comunes = titular.filter(p => leido.includes(p)).length;
  /* Contra el TITULAR, no contra lo leído: «CLINICA M***» comparte una palabra
     de dos, y eso no prueba nada. Los bancos enmascaran o abrevian: una
     coincidencia parcial es «mirar», no «falso». */
  if (titular.length > 0 && comunes / titular.length >= 0.6) return { campo: 'DESTINATARIO', estado: 'OK', texto: `A nombre de ${d.destinatario}.` };
  if (comunes > 0) return { campo: 'DESTINATARIO', estado: 'ADVERTENCIA', texto: `A nombre de ${d.destinatario}; el QR es de ${e.titular}.` };
  return { campo: 'DESTINATARIO', estado: 'ALERTA', texto: `A nombre de ${d.destinatario}, no de ${e.titular}.` };
}

/** «2026-10-10T14:32» o «2026-10-10» en La Paz → instante; `null` si no se entiende. */
export function instanteDeLaPaz(texto: string | null): { instante: Date; soloDia: boolean } | null {
  if (!texto) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2})?)?$/.exec(texto.trim());
  if (!m) return null;
  const instante = new Date(`${m[1]}T${m[2] ?? '00:00'}:00${DESFASE_LA_PAZ}`);
  return Number.isNaN(instante.getTime()) ? null : { instante, soloDia: !m[2] };
}

function fecha(d: DatosComprobante, e: Esperado): Verificacion {
  const f = instanteDeLaPaz(d.fechaHora);
  if (!f) return { campo: 'FECHA', estado: 'ADVERTENCIA', texto: 'No se leyó la fecha del pago.' };
  const legible = f.instante.toLocaleString('es-BO', { timeZone: 'America/La_Paz', day: '2-digit', month: '2-digit', year: 'numeric', ...(f.soloDia ? {} : { hour: '2-digit', minute: '2-digit', hour12: false }) });
  /* Con solo el día, se compara contra el inicio del día en que se pidió el QR. */
  const desde = f.soloDia ? new Date(`${e.pedidoEn.toLocaleDateString('en-CA', { timeZone: 'America/La_Paz' })}T00:00:00${DESFASE_LA_PAZ}`) : new Date(e.pedidoEn.getTime() - TOLERANCIA_MS);
  if (f.instante < desde) return { campo: 'FECHA', estado: 'ALERTA', texto: `Es del ${legible}: anterior a cuando se le mandó el QR.` };
  if (f.instante.getTime() > e.ahora.getTime() + TOLERANCIA_MS) return { campo: 'FECHA', estado: 'ALERTA', texto: `Dice ${legible}: es una fecha futura.` };
  return { campo: 'FECHA', estado: 'OK', texto: legible };
}

function referencia(d: DatosComprobante, e: Esperado): Verificacion {
  if (!d.referencia) return { campo: 'REFERENCIA', estado: 'ADVERTENCIA', texto: 'No se leyó un número de operación.' };
  if (e.referenciaRepetida) return { campo: 'REFERENCIA', estado: 'ALERTA', texto: `La operación ${d.referencia} ya llegó en otro pago: puede ser un comprobante reutilizado.` };
  return { campo: 'REFERENCIA', estado: 'OK', texto: `Operación ${d.referencia}${d.banco ? ` · ${d.banco}` : ''}.` };
}

/** La referencia como se compara entre pagos: sin espacios ni guiones, en mayúscula. */
export function referenciaComparable(referencia: string | null): string | null {
  const r = referencia?.replace(/[\s-]/g, '').toUpperCase() ?? '';
  return r.length >= 4 ? r : null;
}

/** El esquema que se le pide al modelo: exactamente `DatosComprobante`. */
export const ESQUEMA_COMPROBANTE = {
  type: 'object',
  properties: {
    esComprobante: { type: 'boolean', description: 'true si la imagen es el comprobante de una transferencia o pago por QR.' },
    monto: { type: ['number', 'null'], description: 'El importe pagado, como número (280.5).' },
    moneda: { type: ['string', 'null'], description: 'Bs, BOB, USD…, como aparece.' },
    fechaHora: { type: ['string', 'null'], description: 'Fecha y hora de la operación, AAAA-MM-DDTHH:MM; solo AAAA-MM-DD si no hay hora.' },
    referencia: { type: ['string', 'null'], description: 'Número de operación, transacción o comprobante.' },
    banco: { type: ['string', 'null'], description: 'El banco o la billetera que emitió el comprobante.' },
    destinatario: { type: ['string', 'null'], description: 'A nombre de quién se pagó (beneficiario, destino).' },
    ordenante: { type: ['string', 'null'], description: 'Quién pagó (origen, titular de la cuenta que paga).' },
  },
  required: ['esComprobante', 'monto', 'moneda', 'fechaHora', 'referencia', 'banco', 'destinatario', 'ordenante'],
} as const;

export const INSTRUCCION_COMPROBANTE =
  'Lee este comprobante de pago boliviano (transferencia o pago por QR). Copia los datos tal como aparecen; ' +
  'si un dato no aparece o no se lee, usa null. No deduzcas ni completes nada. ' +
  'Si no es un comprobante de pago, esComprobante es false y lo demás null.';

/** Valida lo que devolvió el modelo; lanza si no tiene la forma pedida. */
export function datosComprobanteDe(valor: unknown): DatosComprobante {
  if (!valor || typeof valor !== 'object') throw new Error('La lectura no es un objeto.');
  const o = valor as Record<string, unknown>;
  const textoONulo = (k: string): string | null => {
    const v = o[k];
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') throw new Error(`«${k}» no es texto.`);
    return v.trim().slice(0, 120) || null;
  };
  if (typeof o['esComprobante'] !== 'boolean') throw new Error('Falta esComprobante.');
  const monto = o['monto'];
  if (monto !== null && monto !== undefined && (typeof monto !== 'number' || !Number.isFinite(monto) || monto < 0)) throw new Error('«monto» no es un número.');
  return {
    esComprobante: o['esComprobante'],
    monto: typeof monto === 'number' ? monto : null,
    moneda: textoONulo('moneda'),
    fechaHora: textoONulo('fechaHora'),
    referencia: textoONulo('referencia'),
    banco: textoONulo('banco'),
    destinatario: textoONulo('destinatario'),
    ordenante: textoONulo('ordenante'),
  };
}
