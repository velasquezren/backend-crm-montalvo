/**
 * El catálogo de herramientas del asistente: lo único que puede hacer.
 *
 * ## Por qué un catálogo y no prompts
 *
 * El modelo hace DOS cosas: elegir una herramienta y rellenar sus parámetros.
 * Ningún dato de la respuesta sale de él. Cada herramienta es una función sobre
 * servicios que ya existen y ya están probados, así que se prueba sin modelo y
 * el modelo es reemplazable sin tocar ninguna garantía.
 *
 * Las declaraciones que se le mandan al modelo y el despacho salen de ESTA
 * lista. No hay dos sitios que puedan divergir.
 *
 * ## La regla que no se negocia
 *
 * `escribe: true` marca las herramientas que cambian el mundo. El despachador
 * las rechaza salvo que quien llama pase `permitirEscritura`. **El modelo nunca
 * decide una escritura**: puede pedirla, y es código determinista el que
 * comprueba sus condiciones —en `reservar`, que el médico esté activo y que la
 * hora siga libre contra `agenda_med` de FileMaker—.
 *
 * Y con el SDK de Vertex (`@google/genai`), **`automaticFunctionCalling` va
 * DESACTIVADO**. Con el automático, el SDK ejecuta la función que el modelo
 * pide sin pasar por aquí, y entonces esta regla no existe. Es el valor por
 * defecto más peligroso de esa librería para este caso.
 *
 * ## Lo que NO está aquí, a propósito
 *
 * - Confirmar un pago. Lo hace una persona (`promociones-chat.service.ts`), y
 *   `PAGADO` significa «comprobante registrado», no «verificado».
 * - Decidir si algo es una emergencia. Eso lo deciden una lista cerrada de
 *   frases y el botón del menú, y es determinista.
 * - Cualquier escritura en la agenda que no sea reservar.
 */
import { Injectable } from '@nestjs/common';

import { AgendaReservasService } from '../agenda/agenda-reservas.service';
import { AgendaService } from '../agenda/agenda.service';

/** Lo que el modelo recibe como esquema de parámetros (JSON Schema). */
export interface EsquemaHerramienta {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, { type: string; description: string; pattern?: string }>>;
  readonly required: readonly string[];
}

export interface Herramienta {
  readonly nombre: string;
  /** Lo lee el modelo para decidir: dice qué devuelve y qué NO hace. */
  readonly descripcion: string;
  readonly parametros: EsquemaHerramienta;
  /** `true` si cambia el mundo. El despachador la bloquea sin permiso explícito. */
  readonly escribe: boolean;
}

/**
 * Lo que sabe el CRM de la conversación, y que el modelo NO rellena.
 *
 * El teléfono es el de la conversación de WhatsApp: autoritativo. Pedírselo al
 * modelo sería darle la posibilidad de reservar a nombre de otro número, y
 * además es un dato que ya tenemos.
 */
export interface ContextoAsistente {
  /** El teléfono de la paciente, como lo guarda la conversación. */
  readonly telefono: string;
}

export type ResultadoHerramienta =
  | { readonly ok: true; readonly datos: unknown }
  /** `motivo` se le devuelve al modelo tal cual: tiene que poder corregirse con eso. */
  | { readonly ok: false; readonly motivo: string };

const FECHA = '^\\d{4}-\\d{2}-\\d{2}$';
const HORA = '^([01]\\d|2[0-3]):[0-5]\\d$';

export const HERRAMIENTAS: readonly Herramienta[] = [
  {
    nombre: 'listar_especialidades',
    descripcion:
      'Las especialidades que atiende la clínica. Úsala cuando pregunten qué hay o con qué especialista. ' +
      'Devuelve solo las que existen: no nombres otras.',
    parametros: { type: 'object', properties: {}, required: [] },
    escribe: false,
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
    escribe: false,
  },
  {
    nombre: 'ver_medico',
    descripcion:
      'Un médico por su número, con su especialidad, su precio y su horario. ' +
      'El horario se le manda a la paciente como IMAGEN; no lo describas con palabras propias.',
    parametros: {
      type: 'object',
      properties: { medicoId: { type: 'string', description: 'Número del médico.' } },
      required: ['medicoId'],
    },
    escribe: false,
  },
  {
    nombre: 'dias_con_cupo',
    descripcion:
      'Los próximos días que tienen al menos una hora libre con ese médico. ' +
      'Vacío significa que no hay cupos o que se atiende a solicitud: dilo, no ofrezcas una fecha.',
    parametros: {
      type: 'object',
      properties: { medicoId: { type: 'string', description: 'Número del médico.' } },
      required: ['medicoId'],
    },
    escribe: false,
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
    escribe: false,
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
    escribe: true,
  },
];

/** Las declaraciones tal como las espera `tools: [{ functionDeclarations }]`. */
export function declaracionesParaElModelo(): readonly {
  name: string;
  description: string;
  parametersJsonSchema: EsquemaHerramienta;
}[] {
  return HERRAMIENTAS.map(h => ({
    name: h.nombre,
    description: h.descripcion,
    parametersJsonSchema: h.parametros,
  }));
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
    const patron = h.parametros.properties[clave]?.pattern;
    if (patron && !new RegExp(patron).test(v)) {
      return { ok: false, motivo: `«${clave}» tiene que venir como ${clave === 'fecha' ? 'AAAA-MM-DD' : 'HH:MM'}; llegó «${v}».` };
    }
    valores[clave] = v;
  }
  return { ok: true, valores };
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
   * `permitirEscritura` lo decide QUIEN LLAMA, nunca el modelo: en las primeras
   * fases va en `false` y la reserva la dispara una persona desde el chat.
   */
  async ejecutar(
    nombre: string,
    args: Record<string, unknown>,
    contexto: ContextoAsistente,
    opciones: { permitirEscritura: boolean },
  ): Promise<ResultadoHerramienta> {
    const h = HERRAMIENTAS.find(x => x.nombre === nombre);
    if (!h) return { ok: false, motivo: `No existe la herramienta «${nombre}».` };
    if (h.escribe && !opciones.permitirEscritura) {
      return { ok: false, motivo: `«${nombre}» cambia datos y está desactivada: pídele a una persona que lo haga.` };
    }
    const v = validarArgumentos(h, args);
    if (!v.ok) return v;
    const a = v.valores;

    switch (h.nombre) {
      case 'listar_especialidades':
        return { ok: true, datos: await this.agenda.especialidades({ pagina: 1, limite: 50 }) };
      case 'listar_medicos':
        return { ok: true, datos: await this.agenda.medicos({ especialidadId: a.especialidadId, pagina: 1, limite: 50 }) };
      case 'ver_medico':
        return { ok: true, datos: await this.agenda.medico(Number(a.medicoId)) };
      case 'dias_con_cupo':
        return { ok: true, datos: await this.agenda.dias({ medicoId: a.medicoId }) };
      case 'horas_libres':
        return { ok: true, datos: await this.agenda.disponibilidad({ medicoId: a.medicoId, fecha: a.fecha }) };
      case 'reservar':
        /* `telefono` sale del CONTEXTO, no de `a`: es el de la conversación.
           `observaciones` deja constancia de por dónde entró, que es lo primero
           que se pregunta cuando una reserva sale raro. */
        return {
          ok: true,
          datos: await this.reservas.reservar({
            medicoId: a.medicoId, fecha: a.fecha, hora: a.hora,
            nombre: a.nombre, ci: a.ci, telefono: contexto.telefono,
            observaciones: 'Reservada por el asistente desde WhatsApp',
          }),
        };
      default:
        return { ok: false, motivo: `«${nombre}» está en el catálogo y no tiene implementación.` };
    }
  }
}
