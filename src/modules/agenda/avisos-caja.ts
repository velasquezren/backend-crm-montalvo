/*
 * El aviso a caja de un comprobante nuevo (docs/avisos-caja.md): qué dice y
 * cuándo se puede mandar. Sin base ni red, para probarlo solo.
 *
 * Sale como PLANTILLA de WhatsApp: a caja se le escribe primero, y fuera de la
 * ventana de 24 h Meta solo acepta plantillas aprobadas.
 */
import type { FilaReservaAgenda } from './agenda-consulta.sql';
import { precioDelVps } from './agenda.sql';

/*
 * Propia y no la de `agenda-flow.service.ts`: importar ese servicio desde aquí
 * cerraba el ciclo AgendaReservasService → AvisosCajaService → AgendaFlowService
 * → AgendaReservasService, y Nest no arrancaba (22/10/2026). Mismo formato.
 */
const fechaLarga = (fecha: string) =>
  new Intl.DateTimeFormat('es-BO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${fecha}T12:00:00Z`));

export const PLANTILLA_AVISO_CAJA = 'montalvo_comprobante_caja';
export const IDIOMA_AVISO_CAJA = 'es';
/** Recepción: la línea interna, no la de los pacientes de Ventas. */
export const LINEA_AVISO_CAJA = '00000000-0000-4000-8000-000000000003';

/** El texto que se registra en Meta. Las variables, en orden, las arma `parametrosAvisoCaja`. */
export const CUERPO_PLANTILLA_AVISO_CAJA =
  'Comprobante nuevo para verificar 🧾\n\n' +
  'Paciente: {{1}}\nCarnet: {{2}}\nMédico: {{3}}\nCita: {{4}}\nMonto: {{5}}\n\n' +
  'El comprobante ya está cargado en la agenda. Revíselo y regístrelo en FileMaker.';
export const PIE_PLANTILLA_AVISO_CAJA = 'Clínica Montalvo · aviso automático del CRM';

/**
 * Meta rechaza un parámetro vacío, con saltos de línea o tabulaciones, o con más
 * de cuatro espacios seguidos: el mensaje no sale y el error llega tarde. Se
 * limpia aquí y lo vacío pasa a «—».
 */
export function parametroLimpio(texto: string | null | undefined, maximo = 120): string {
  const limpio = (texto ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, maximo);
  return limpio || '—';
}

/** Las cinco variables, en el orden del cuerpo. */
export function parametrosAvisoCaja(r: Pick<FilaReservaAgenda, 'paciente' | 'ci' | 'medico' | 'fecha' | 'hora' | 'precio'>): string[] {
  const precio = precioDelVps(r.precio);
  const bs = precio ? precio.importeCentavos / 100 : null;
  const monto = bs === null ? null : `Bs ${bs.toLocaleString('es-BO', { minimumFractionDigits: Number.isInteger(bs) ? 0 : 2, maximumFractionDigits: 2 })}`;
  return [
    parametroLimpio(r.paciente),
    parametroLimpio(r.ci),
    parametroLimpio(r.medico),
    parametroLimpio(`${fechaLarga(r.fecha)}, ${r.hora.slice(0, 5)}`),
    parametroLimpio(monto),
  ];
}

/** Cómo está la plantilla en Meta, dicho para quien administra. */
export type EstadoPlantillaCaja = 'APROBADA' | 'EN_REVISION' | 'RECHAZADA' | 'NO_EXISTE' | 'SIN_CONEXION';

/** De la lista de `message_templates` de la WABA de la línea. `null` = no se pudo pedir. */
export function estadoPlantillaCaja(lista: readonly unknown[] | null, nombre = PLANTILLA_AVISO_CAJA, idioma = IDIOMA_AVISO_CAJA): EstadoPlantillaCaja {
  if (!lista) return 'SIN_CONEXION';
  const p = lista.find((x): x is { name: string; language: string; status: string } =>
    !!x && typeof x === 'object' && (x as { name?: unknown }).name === nombre && (x as { language?: unknown }).language === idioma);
  if (!p) return 'NO_EXISTE';
  const status = String(p.status).toUpperCase();
  if (status === 'APPROVED') return 'APROBADA';
  if (status === 'REJECTED' || status === 'DISABLED' || status === 'PAUSED') return 'RECHAZADA';
  return 'EN_REVISION';
}
