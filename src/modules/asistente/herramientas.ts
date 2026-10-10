/**
 * El catálogo de herramientas del asistente: lo único que puede hacer.
 *
 * ## Por qué un catálogo y no prompts
 *
 * El modelo hace DOS cosas: elegir una herramienta y rellenar sus parámetros.
 * Ningún dato de la respuesta sale de él —precios, horarios, promociones, el
 * estado de un pago—: sale de una herramienta, que lo lee de un servicio que ya
 * existe y ya está probado. Por eso esto se prueba sin modelo, y el modelo es
 * reemplazable sin tocar ninguna garantía.
 *
 * Las declaraciones que se le mandan al modelo y el despacho salen de ESTA
 * lista. No hay dos sitios que puedan divergir.
 *
 * ## Cuatro efectos, y quién decide cada uno
 *
 * - `lectura`: se ejecuta y el resultado vuelve al modelo.
 * - `mensaje`: NO se ejecuta aquí. Se valida (que la promoción exista, que el
 *   médico exista) y queda como ACCIÓN del turno: en modo SUGERIR se le propone
 *   a la agente; en RESPONDER la manda el CRM al terminar, por el camino de los
 *   automáticos, que respeta la pausa y la atención humana.
 * - `derivar`: pasar a una persona. Siempre permitido: equivocarse hacia una
 *   persona no le hace daño a nadie.
 * - `escritura`: cambia el mundo. El despachador la rechaza salvo que QUIEN
 *   LLAMA pase `permitirEscritura`. **El modelo nunca decide una escritura.**
 *   Hoy nadie la permite: las reservas las hace el Flow, que es determinista.
 *
 * Y con el SDK de Vertex, **`automaticFunctionCalling` va DESACTIVADO**: con el
 * automático, el SDK ejecuta la función que el modelo pide sin pasar por aquí.
 *
 * ## Lo que NO está aquí, a propósito
 *
 * - Mandar el QR o datos bancarios. El QR sale SOLO cuando la paciente toca
 *   «Pagar ahora» en la tarjeta de la promoción: el monto se congela ahí y el
 *   pago queda registrado (`PromocionesChatService.iniciar`).
 * - Confirmar un pago. Lo hace una persona; `PAGADO` no es «verificado».
 * - Decidir que algo es una emergencia. La declarada la reconoce la ingesta; la
 *   posible la marca el filtro de entrada (`triaje.ts`), no el modelo que habla.
 */
import { Injectable } from '@nestjs/common';

import { AgendaReservasService } from '../agenda/agenda-reservas.service';
import { AgendaService } from '../agenda/agenda.service';
import type { DeclaracionHerramienta } from './modelo.port';

/** Una propiedad del esquema de parámetros (JSON Schema). */
interface PropiedadEsquema {
  readonly type: 'string';
  readonly description: string;
  readonly pattern?: string;
  readonly enum?: readonly string[];
}

export interface EsquemaHerramienta {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, PropiedadEsquema>>;
  readonly required: readonly string[];
}

export type EfectoHerramienta = 'lectura' | 'mensaje' | 'derivar' | 'escritura';

export interface Herramienta {
  readonly nombre: string;
  /** Lo lee el modelo para decidir: dice qué devuelve y qué NO hace. */
  readonly descripcion: string;
  readonly parametros: EsquemaHerramienta;
  readonly efecto: EfectoHerramienta;
  /** Solo en una línea comercial (promociones, pagos). */
  readonly soloVentas?: true;
}

/* ── Lo que el CRM le presta al asistente en una conversación ───────── */

export interface PromocionParaAsistente {
  readonly id: string;
  readonly titulo: string;
  readonly resumen: string;
  readonly condiciones: string;
  readonly etiquetaOferta: string | null;
  /** En Bs. `precio` es lo que se cobra (el promocional si hay). */
  readonly precio: number | null;
  readonly precioRegular: number | null;
  readonly precioPromocional: number | null;
  /** AAAA-MM-DD, último día. */
  readonly vigenteHasta: string | null;
}

export type EstadoPagoParaAsistente =
  | 'ESPERANDO_COMPROBANTE'
  | 'COMPROBANTE_EN_REVISION'
  | 'CONFIRMADO'
  | 'ANULADO';

export interface PagoParaAsistente {
  readonly estado: EstadoPagoParaAsistente;
  readonly promocion: string;
  readonly monto: number;
  /** Por qué se le pidió otro comprobante, si se le pidió. */
  readonly motivoRechazo: string | null;
}

/**
 * Lo comercial de UNA conversación, atado a ella por quien llama
 * (`AsistenteChatService`). El asistente no recibe ids de conversación ni de
 * línea como parámetros: no puede mirar el pago de otra paciente.
 */
export interface PuertoVentas {
  promociones(): Promise<readonly PromocionParaAsistente[]>;
  promocion(id: string): Promise<(PromocionParaAsistente & {
    readonly sePuedePagarPorChat: boolean;
    /** La línea manda mensajes con botones (`WHATSAPP_INTERACCIONES_LINEAS`): sin eso no hay tarjeta. */
    readonly sePuedeEnviarTarjeta: boolean;
  }) | null>;
  estadoDePago(): Promise<{ readonly qrDisponible: boolean; readonly pago: PagoParaAsistente | null }>;
}

/**
 * Lo que sabe el CRM de la conversación, y que el modelo NO rellena.
 *
 * El teléfono es el de la conversación de WhatsApp: autoritativo. Pedírselo al
 * modelo sería darle la posibilidad de reservar a nombre de otro número.
 */
export interface ContextoAsistente {
  readonly telefono: string;
  /** `null` en una línea que no es comercial: no hay promociones ni pagos. */
  readonly ventas: PuertoVentas | null;
}

/* ── Lo que el turno deja hecho ─────────────────────────────────────── */

export const MOTIVOS_DERIVACION = ['MEDICO', 'URGENCIA', 'QUEJA', 'PAGO', 'PERSONA', 'OTRO'] as const;
export type MotivoDerivacion = (typeof MOTIVOS_DERIVACION)[number];

/** Una acción que el turno propone (SUGERIR) o hace al terminar (RESPONDER). */
export type AccionAsistente =
  | { readonly tipo: 'PROMOCION'; readonly promocionId: string; readonly titulo: string }
  | { readonly tipo: 'HORARIO'; readonly medicoId: number; readonly nombre: string; readonly horario: string | null }
  | { readonly tipo: 'DERIVAR'; readonly motivo: MotivoDerivacion; readonly resumen: string };

export type ResultadoHerramienta =
  | { readonly ok: true; readonly datos: unknown; readonly accion?: AccionAsistente }
  /** `motivo` se le devuelve al modelo tal cual: tiene que poder corregirse con eso. */
  | { readonly ok: false; readonly motivo: string };

const FECHA = '^\\d{4}-\\d{2}-\\d{2}$';
const HORA = '^([01]\\d|2[0-3]):[0-5]\\d$';
const SIN_PARAMETROS: EsquemaHerramienta = { type: 'object', properties: {}, required: [] };
const MEDICO: EsquemaHerramienta = {
  type: 'object',
  properties: { medicoId: { type: 'string', description: 'Número del médico, como lo devolvió listar_medicos.' } },
  required: ['medicoId'],
};
const PROMOCION: EsquemaHerramienta = {
  type: 'object',
  properties: { promocionId: { type: 'string', description: 'El id que devolvió listar_promociones.' } },
  required: ['promocionId'],
};

export const HERRAMIENTAS: readonly Herramienta[] = [
  /* ── Ventas ── */
  {
    nombre: 'listar_promociones',
    descripcion:
      'Las promociones vigentes hoy, con su precio. Es la ÚNICA fuente de promociones y precios de promoción: ' +
      'no menciones ninguna que no venga aquí, ni inventes descuentos.',
    parametros: SIN_PARAMETROS,
    efecto: 'lectura',
    soloVentas: true,
  },
  {
    nombre: 'ver_promocion',
    descripcion:
      'Una promoción con sus condiciones completas, su vigencia y si hoy se puede pagar por este chat. ' +
      'Úsala antes de responder sobre condiciones o letra chica.',
    parametros: PROMOCION,
    efecto: 'lectura',
    soloVentas: true,
  },
  {
    nombre: 'enviar_promocion',
    descripcion:
      'Le envía a la paciente la tarjeta de la promoción: imagen, precio, vigencia y los botones «Pagar ahora» y ' +
      '«Hablar con alguien». Es la forma de cobrar: al tocar «Pagar ahora» recibe el QR y el CRM registra el pago. ' +
      'Úsala cuando quiera la promoción o pregunte cómo pagarla. Tú nunca das datos bancarios ni mandas el QR.',
    parametros: PROMOCION,
    efecto: 'mensaje',
    soloVentas: true,
  },
  {
    nombre: 'estado_de_pago',
    descripcion:
      'El pago de esta conversación, si hay uno: si esperamos su comprobante, si el comprobante está en revisión ' +
      'por una persona, si ya se confirmó; y si esta línea tiene un QR para cobrar. Úsala cuando pregunte por su pago ' +
      'o diga que ya pagó. Un pago solo está confirmado si dice CONFIRMADO: nunca lo afirmes antes.',
    parametros: SIN_PARAMETROS,
    efecto: 'lectura',
    soloVentas: true,
  },
  /* ── Agenda ── */
  {
    nombre: 'listar_especialidades',
    descripcion:
      'Las especialidades que atiende la clínica. Úsala cuando pregunten qué hay o con qué especialista. ' +
      'Devuelve solo las que existen: no nombres otras.',
    parametros: SIN_PARAMETROS,
    efecto: 'lectura',
  },
  {
    nombre: 'listar_medicos',
    descripcion:
      'Los médicos de una especialidad, con su precio de consulta y si se reservan en línea o «a solicitud». ' +
      'No nombres a un médico que no venga en el resultado.',
    parametros: {
      type: 'object',
      properties: { especialidadId: { type: 'string', description: 'El id que devolvió listar_especialidades.' } },
      required: ['especialidadId'],
    },
    efecto: 'lectura',
  },
  {
    nombre: 'ver_medico',
    descripcion:
      'Un médico por su número, con su especialidad, su precio de consulta y los días en que atiende. ' +
      'Para mostrarle el horario completo, usa enviar_horario: le llega como imagen.',
    parametros: MEDICO,
    efecto: 'lectura',
  },
  {
    nombre: 'enviar_horario',
    descripcion:
      'Le envía a la paciente la imagen del horario semanal del médico. Úsala cuando pregunte cuándo atiende. ' +
      'No reemplaza a horas_libres: el horario dice cuándo atiende, no si hay lugar.',
    parametros: MEDICO,
    efecto: 'mensaje',
  },
  {
    nombre: 'dias_con_cupo',
    descripcion:
      'Los próximos días que tienen al menos una hora libre con ese médico. ' +
      'Vacío significa que no hay cupos o que se atiende a solicitud: dilo, no ofrezcas una fecha.',
    parametros: MEDICO,
    efecto: 'lectura',
  },
  {
    nombre: 'horas_libres',
    descripcion:
      'Las horas libres de un médico un día concreto. Es la ÚNICA fuente de disponibilidad: ' +
      'nunca afirmes que una hora está libre sin haberla visto aquí.',
    parametros: {
      type: 'object',
      properties: {
        medicoId: { type: 'string', description: 'Número del médico.' },
        fecha: { type: 'string', description: 'AAAA-MM-DD, fecha de Bolivia.', pattern: FECHA },
      },
      required: ['medicoId', 'fecha'],
    },
    efecto: 'lectura',
  },
  {
    nombre: 'reservar',
    descripcion:
      'Registra la reserva. Pide antes el nombre y el CI a la paciente: no los deduzcas ni los inventes. ' +
      'Puede responder que la hora ya no está disponible porque alguien la tomó mientras conversaban; ' +
      'en ese caso ofrece otra, no digas que quedó hecha. Una reserva queda PENDIENTE de pago y de ' +
      'recepción: nunca la llames «cita confirmada».',
    parametros: {
      type: 'object',
      properties: {
        medicoId: { type: 'string', description: 'Número del médico.' },
        fecha: { type: 'string', description: 'AAAA-MM-DD.', pattern: FECHA },
        hora: { type: 'string', description: 'HH:MM, una de las que devolvió horas_libres.', pattern: HORA },
        nombre: { type: 'string', description: 'Nombre completo, tal como lo dio la paciente.' },
        ci: { type: 'string', description: 'Cédula de identidad, tal como la dio la paciente.' },
      },
      required: ['medicoId', 'fecha', 'hora', 'nombre', 'ci'],
    },
    efecto: 'escritura',
  },
  /* ── Siempre ── */
  {
    nombre: 'pasar_a_persona',
    descripcion:
      'Pasa la conversación a una persona del equipo. Úsala SIEMPRE que pregunte algo médico (síntomas, ' +
      'diagnósticos, tratamientos, medicamentos, resultados, cuidados después de un procedimiento), si se queja, ' +
      'si pide hablar con alguien, si algo de un pago no cuadra, o si no estás segura de la respuesta. ' +
      'Ante la duda, pásala: es lo correcto.',
    parametros: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Por qué.', enum: MOTIVOS_DERIVACION },
        resumen: { type: 'string', description: 'Una frase para la persona que la atenderá: qué necesita la paciente.' },
      },
      required: ['motivo', 'resumen'],
    },
    efecto: 'derivar',
  },
];

/** Las herramientas que tiene a mano en esta conversación. */
export function herramientasDisponibles(contexto: ContextoAsistente, { permitirEscritura }: { permitirEscritura: boolean }): readonly Herramienta[] {
  return HERRAMIENTAS.filter(h => (h.efecto !== 'escritura' || permitirEscritura) && (!h.soloVentas || contexto.ventas !== null));
}

/** Las declaraciones tal como las espera `tools: [{ functionDeclarations }]`. */
export function declaraciones(herramientas: readonly Herramienta[] = HERRAMIENTAS): DeclaracionHerramienta[] {
  return herramientas.map(h => ({ name: h.nombre, description: h.descripcion, parametersJsonSchema: h.parametros }));
}

const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Valida los argumentos que mandó el modelo contra el esquema.
 *
 * No se confía en que los respete: un modelo puede omitir un requerido, mandar
 * un número donde va texto o una fecha con otro formato. El mensaje de vuelta
 * es para que SE CORRIJA, así que dice qué falta y cómo tiene que venir.
 */
export function validarArgumentos(h: Herramienta, args: Record<string, unknown>): { ok: true; valores: Record<string, string> } | { ok: false; motivo: string } {
  const valores: Record<string, string> = {};
  for (const clave of h.parametros.required) {
    const v = texto(args[clave]);
    if (v === null) return { ok: false, motivo: `Falta «${clave}».` };
    const propiedad = h.parametros.properties[clave];
    if (propiedad?.pattern && !new RegExp(propiedad.pattern).test(v)) {
      return { ok: false, motivo: `«${clave}» tiene que venir como ${clave === 'fecha' ? 'AAAA-MM-DD' : 'HH:MM'}; llegó «${v}».` };
    }
    if (propiedad?.enum && !propiedad.enum.includes(v)) {
      return { ok: false, motivo: `«${clave}» tiene que ser uno de: ${propiedad.enum.join(', ')}.` };
    }
    valores[clave] = v;
  }
  return { ok: true, valores };
}

/** Bs con dos decimales, como lo lee una paciente. */
function bolivianos(centavos: number): string {
  return `Bs ${(centavos / 100).toFixed(2)}`;
}

@Injectable()
export class HerramientasAsistenteService {
  constructor(
    private readonly agenda: AgendaService,
    private readonly reservas: AgendaReservasService,
  ) {}

  /**
   * Ejecuta una herramienta por su nombre.
   *
   * `permitirEscritura` lo decide QUIEN LLAMA, nunca el modelo. El permiso se
   * comprueba ANTES de validar: no tiene sentido decirle qué arreglar de una
   * herramienta que no puede usar.
   */
  async ejecutar(
    nombre: string,
    args: Record<string, unknown>,
    contexto: ContextoAsistente,
    opciones: { permitirEscritura: boolean },
  ): Promise<ResultadoHerramienta> {
    const h = HERRAMIENTAS.find(x => x.nombre === nombre);
    if (!h) return { ok: false, motivo: `No existe la herramienta «${nombre}».` };
    if (h.efecto === 'escritura' && !opciones.permitirEscritura) {
      return { ok: false, motivo: `«${nombre}» cambia datos y está desactivada: pásale la conversación a una persona.` };
    }
    const ventas = contexto.ventas;
    if (h.soloVentas && !ventas) return { ok: false, motivo: `«${nombre}» no está disponible en esta línea.` };
    const v = validarArgumentos(h, args);
    if (!v.ok) return v;
    const a = v.valores;

    switch (h.nombre) {
      case 'listar_promociones': {
        const lista = await ventas!.promociones();
        return { ok: true, datos: lista.length ? lista.map(p => ({ id: p.id, titulo: p.titulo, resumen: p.resumen, precioBs: p.precio, vigenteHasta: p.vigenteHasta })) : 'Hoy no hay promociones publicadas.' };
      }
      case 'ver_promocion': {
        const p = await ventas!.promocion(a.promocionId);
        return p ? { ok: true, datos: p } : { ok: false, motivo: 'Esa promoción no existe o ya no está vigente. Vuelve a mirar listar_promociones.' };
      }
      case 'enviar_promocion': {
        const p = await ventas!.promocion(a.promocionId);
        if (!p) return { ok: false, motivo: 'Esa promoción no existe o ya no está vigente: no se puede enviar.' };
        if (!p.sePuedeEnviarTarjeta) return { ok: false, motivo: 'En esta línea no se pueden enviar tarjetas. Cuéntale la promoción con sus datos y, para pagarla, pásala a una persona.' };
        return {
          ok: true,
          datos: `Se le enviará la tarjeta de «${p.titulo}»${p.sePuedePagarPorChat ? ' con el botón «Pagar ahora»' : '. Hoy no se puede pagar por el chat: una persona le indicará cómo'}.`,
          accion: { tipo: 'PROMOCION', promocionId: p.id, titulo: p.titulo },
        };
      }
      case 'estado_de_pago':
        return { ok: true, datos: await ventas!.estadoDePago() };
      case 'listar_especialidades': {
        const r = await this.agenda.especialidades({ pagina: 1, limite: 50 });
        return { ok: true, datos: r.datos.map(e => ({ id: e.id, nombre: e.nombre })) };
      }
      case 'listar_medicos': {
        const r = await this.agenda.medicos({ especialidadId: a.especialidadId, pagina: 1, limite: 50 });
        return {
          ok: true,
          datos: r.datos.map(m => ({
            id: m.id, nombre: m.nombre, modalidad: m.modalidad,
            precioConsulta: m.precio ? bolivianos(m.precio.importeCentavos) : null, atiende: m.horarioInformativo,
          })),
        };
      }
      case 'ver_medico': {
        const { medico, especialidad } = await this.agenda.medico(Number(a.medicoId));
        return {
          ok: true,
          datos: {
            id: medico.id, nombre: medico.nombre, especialidad: especialidad.nombre, modalidad: medico.modalidad,
            precioConsulta: medico.precio ? bolivianos(medico.precio.importeCentavos) : null, atiende: medico.horarioInformativo,
          },
        };
      }
      case 'enviar_horario': {
        const { medico } = await this.agenda.medico(Number(a.medicoId));
        if (!medico.horarioInformativo) return { ok: false, motivo: 'Ese médico no tiene horario fijo cargado: atiende a solicitud. Dilo así.' };
        return {
          ok: true,
          datos: `Se le enviará la imagen del horario de ${medico.nombre}.`,
          accion: { tipo: 'HORARIO', medicoId: Number(medico.id), nombre: medico.nombre, horario: medico.horarioInformativo },
        };
      }
      case 'dias_con_cupo':
        return { ok: true, datos: await this.agenda.dias({ medicoId: a.medicoId }) };
      case 'horas_libres':
        return { ok: true, datos: await this.agenda.disponibilidad({ medicoId: a.medicoId, fecha: a.fecha }) };
      case 'reservar':
        /* `telefono` sale del CONTEXTO, no de `a`: es el de la conversación.
           `observaciones` deja constancia de por dónde entró. */
        return {
          ok: true,
          datos: await this.reservas.reservar({
            medicoId: a.medicoId, fecha: a.fecha, hora: a.hora,
            nombre: a.nombre, ci: a.ci, telefono: contexto.telefono,
            observaciones: 'Reservada por el asistente desde WhatsApp',
          }),
        };
      case 'pasar_a_persona':
        return {
          ok: true,
          datos: 'Listo: una persona del equipo seguirá esta conversación. Despídete en una frase, sin prometer tiempos.',
          accion: { tipo: 'DERIVAR', motivo: a.motivo as MotivoDerivacion, resumen: a.resumen.slice(0, 280) },
        };
      default:
        return { ok: false, motivo: `«${nombre}» está en el catálogo y no tiene implementación.` };
    }
  }
}
