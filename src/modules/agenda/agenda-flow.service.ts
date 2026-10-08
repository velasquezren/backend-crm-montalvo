import { HttpException, Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { interaccionesEnLinea } from '../conversaciones/interacciones-integracion';
import { CacheMemoria } from '../../common/cache/cache-memoria';
import { abrirTokenFlow, sellarCierreReserva } from '../../common/whatsapp/flows/token-flow';
import { AgendaReservasService } from './agenda-reservas.service';
import { AgendaService } from './agenda.service';
import { EspecialidadAgenda, MedicoAgenda } from './agenda.contrato';
import { CrearReservaAgendaDto } from './dto/reserva-agenda.dto';

/**
 * El Flow de WhatsApp «Reservar una cita» (`reserva-cita.v1.json`): las
 * pantallas que pide el cliente de WhatsApp a nuestro endpoint, una a una.
 *
 * Es la reserva web, por otra puerta: lee con los mismos services
 * (`AgendaService`: especialidades, médicos, días, horas libres) y reserva con
 * `AgendaReservasService.reservar`, que escribe `para_agendar` como ScriptCase
 * y avisa por Telegram. Nada se guarda aquí: cada pantalla trae en su `data`
 * lo elegido hasta entonces, y el servidor lo vuelve a comprobar.
 *
 * Quién es la paciente lo dice el `flow_token` sellado (`token-flow.ts`): su
 * teléfono, el del chat en que se le envió el Flow. Nunca lo escribe ella.
 */

export const VERSION_FLOW_RESERVA = 'reserva-cita.v1';

/** Lo que el cliente de WhatsApp manda al endpoint, ya descifrado. */
interface PeticionFlow {
  action?: unknown;
  screen?: unknown;
  data?: unknown;
  flow_token?: unknown;
}

type Datos = Record<string, unknown>;
type Pantalla = { screen: string; data: Datos };

/** El `flow_token` no abre: el protocolo pide 427 para que WhatsApp cierre el Flow. */
export class TokenFlowInvalido extends Error {}

/** Límites de Meta para las opciones de Dropdown y RadioButtonsGroup. */
const MAX_TITULO = 30;
const MAX_DESCRIPCION = 300;
const MAX_RADIOS = 20;
/**
 * Lo que se espera al QR del médico antes de cerrar el Flow. La reserva ya está
 * hecha: WhatsApp corta a los 10 s y la paciente vería un error sobre una reserva
 * que sí existe. Sin QR a tiempo, recepción coordina el pago (como con la web);
 * la copia sigue en segundo plano y la siguiente paciente ya la encuentra.
 */
const ESPERA_QR_MS = 3_000;

const recortar = (texto: string, max: number) => (texto.length <= max ? texto : `${texto.slice(0, max - 1).trimEnd()}…`);
const texto = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const sinAviso = { aviso: '', hay_aviso: false };
const conAviso = (aviso: string) => ({ aviso, hay_aviso: true });

/** «2026-10-08» → «jueves 8 de octubre». */
export function fechaLarga(fecha: string): string {
  return new Intl.DateTimeFormat('es-BO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${fecha}T12:00:00Z`));
}

export function textoDePrecio(precio: MedicoAgenda['precio']): string {
  if (!precio) return 'Recepción te confirmará el precio de la consulta.';
  const bs = precio.importeCentavos / 100;
  return `Consulta: Bs ${bs.toLocaleString('es-BO', { minimumFractionDigits: Number.isInteger(bs) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** El celular de Bolivia del chat, en 8 dígitos; `null` si el chat no es de un celular boliviano. */
export function celularBoliviano(telefono: string): string | null {
  const local = telefono.replace(/^591/, '');
  return /^[67]\d{7}$/.test(local) ? local : null;
}

@Injectable()
export class AgendaFlowService {
  private readonly logger = new Logger(AgendaFlowService.name);
  /** Especialidades con al menos un médico que se reserva en línea: armarla cuesta una consulta por especialidad. */
  private readonly catalogo = new CacheMemoria<{ especialidad: EspecialidadAgenda; medicos: MedicoAgenda[] }[]>({ ttlMs: 60_000, maxEntradas: 1 });

  constructor(
    private readonly agenda: AgendaService,
    private readonly reservas: AgendaReservasService,
  ) {}

  /** La respuesta a una petición del Flow (sin cifrar: el controlador cifra). */
  async responder(entrada: unknown): Promise<unknown> {
    const p = (typeof entrada === 'object' && entrada !== null ? entrada : {}) as PeticionFlow;
    if (p.action === 'ping') return { data: { status: 'active' } };
    const datos = (typeof p.data === 'object' && p.data !== null ? p.data : {}) as Datos;
    // Aviso de error del cliente de WhatsApp sobre una respuesta nuestra: se acusa y se registra.
    if (typeof datos['error'] === 'string') {
      this.logger.warn(`El Flow de reserva informó un error: ${recortar(String(datos['error']), 120)}`);
      return { data: { acknowledged: true } };
    }
    const token = abrirTokenFlow(p.flow_token);
    if (!token?.lineaId || !interaccionesEnLinea(token.lineaId)) throw new TokenFlowInvalido();

    if (p.action === 'INIT' || p.action === 'BACK') return this.especialidades();
    if (p.action !== 'data_exchange') return this.especialidades();
    switch (datos['paso']) {
      case 'especialidad': return this.medicos(texto(datos['especialidad']));
      case 'medico': return this.fechas(texto(datos['especialidad']), texto(datos['medico']));
      case 'fecha': return this.horas(texto(datos['medico']), texto(datos['fecha']));
      case 'confirmar': return this.confirmar(datos, token.telefono, p.flow_token as string);
      default: return this.especialidades();
    }
  }

  /** Especialidades con médicos en línea, cada una con los suyos (ordenados como en la agenda). */
  private catalogoEnLinea() {
    return this.catalogo.resolver('enLinea', async () => {
      const especialidades = (await this.agenda.especialidades({ pagina: 1, limite: 100 })).datos;
      const resultado: { especialidad: EspecialidadAgenda; medicos: MedicoAgenda[] }[] = [];
      // De a una: la cuenta de lectura tiene pocas conexiones y la landing también la usa.
      for (const especialidad of especialidades) {
        const medicos = (await this.agenda.medicos({ especialidadId: especialidad.id, pagina: 1, limite: 100 })).datos.filter(m => m.modalidad === 'ONLINE');
        if (medicos.length > 0) resultado.push({ especialidad, medicos });
      }
      return resultado;
    });
  }

  private async especialidades(aviso?: string): Promise<Pantalla> {
    const catalogo = await this.catalogoEnLinea();
    return {
      screen: 'ESPECIALIDAD',
      data: {
        especialidades: catalogo.map(c => ({ id: c.especialidad.id, title: recortar(c.especialidad.nombre, MAX_TITULO) })),
        ...(aviso ? conAviso(aviso) : catalogo.length ? sinAviso : conAviso('Ahora no hay médicos con reserva en línea. Cierra este formulario y escríbenos por el chat.')),
      },
    };
  }

  private async medicos(especialidadId: string, aviso?: string): Promise<Pantalla> {
    const entrada = (await this.catalogoEnLinea()).find(c => c.especialidad.id === especialidadId);
    if (!entrada) return this.especialidades('Esa especialidad ya no tiene reserva en línea. Elige otra.');
    return {
      screen: 'MEDICO',
      data: {
        especialidad: entrada.especialidad.id,
        especialidad_nombre: entrada.especialidad.nombre,
        medicos: entrada.medicos.slice(0, MAX_RADIOS).map(m => ({
          id: m.id,
          title: recortar(m.nombre, MAX_TITULO),
          description: recortar([m.horarioInformativo, m.precio ? textoDePrecio(m.precio) : null].filter(Boolean).join(' · ') || 'Con reserva en línea', MAX_DESCRIPCION),
        })),
        ...(aviso ? conAviso(aviso) : sinAviso),
      },
    };
  }

  private async medicoEnLinea(medicoId: string): Promise<MedicoAgenda | null> {
    if (!/^\d{1,10}$/.test(medicoId)) return null;
    try {
      const { medico } = await this.agenda.medico(Number(medicoId));
      return medico.modalidad === 'ONLINE' ? medico : null;
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 404) return null;
      throw error;
    }
  }

  private async fechas(especialidadId: string, medicoId: string, aviso?: string): Promise<Pantalla> {
    const medico = await this.medicoEnLinea(medicoId);
    if (!medico) return this.medicos(especialidadId, 'Ese profesional ya no reserva en línea. Elige otro.');
    const { fechas } = await this.agenda.dias({ medicoId });
    if (fechas.length === 0) return this.medicos(especialidadId, `${medico.nombre} no tiene horas libres en los próximos 30 días. Elige otro profesional o escríbenos por el chat.`);
    return {
      screen: 'FECHA',
      data: {
        medico: medico.id,
        medico_nombre: medico.nombre,
        fechas: fechas.map(f => ({ id: f, title: recortar(fechaLarga(f), MAX_TITULO) })),
        ...(aviso ? conAviso(aviso) : sinAviso),
      },
    };
  }

  /**
   * La pantalla de hora y datos. `previo`: lo que la paciente ya escribió, para
   * que un aviso (hora ocupada, carnet mal escrito) no le haga escribirlo otra vez.
   */
  private async horas(medicoId: string, fecha: string, aviso?: string, previo?: { nombre: string; ci: string; observaciones: string }): Promise<Pantalla> {
    const medico = await this.medicoEnLinea(medicoId);
    if (!medico) return this.especialidades('Ese profesional ya no reserva en línea. Elige otra vez.');
    const disponible = await this.agenda.disponibilidad({ medicoId, fecha });
    if (disponible.horarios.length === 0) {
      return this.fechas(medico.especialidadId, medicoId, `El ${fechaLarga(fecha)} ya no tiene horas libres. Elige otro día.`);
    }
    return {
      screen: 'DATOS',
      data: {
        medico: medico.id,
        fecha,
        resumen: recortar(`${medico.nombre} · ${fechaLarga(fecha)}`, 80),
        horas: disponible.horarios.map(h => ({ id: h.hora, title: h.hora })),
        precio: textoDePrecio(medico.precio),
        nombre: previo?.nombre ?? '',
        ci: previo?.ci ?? '',
        observaciones: previo?.observaciones ?? '',
        ...(aviso ? conAviso(aviso) : sinAviso),
      },
    };
  }

  /** Reserva igual que la web. Si la hora se ocupó mientras escribía, la misma pantalla con las horas al día. */
  private async confirmar(datos: Datos, telefono: string, flowToken: string): Promise<unknown> {
    const medicoId = texto(datos['medico']);
    const fecha = texto(datos['fecha']);
    const previo = { nombre: texto(datos['nombre']).slice(0, 120), ci: texto(datos['ci']).slice(0, 20), observaciones: texto(datos['observaciones']).slice(0, 300) };
    const celular = celularBoliviano(telefono);
    if (!celular) {
      return this.horas(medicoId, fecha, 'La reserva en línea es para celulares de Bolivia. Escríbenos por el chat y te agendamos.', previo);
    }
    const dto = plainToInstance(CrearReservaAgendaDto, {
      medicoId, fecha, hora: texto(datos['hora']),
      nombre: texto(datos['nombre']), telefono: celular, ci: texto(datos['ci']),
      observaciones: texto(datos['observaciones']).slice(0, 500),
    });
    const errores = validateSync(dto);
    if (errores.length > 0) {
      const campo = errores[0].property;
      const aviso = campo === 'ci' ? 'Revisa el carnet: solo letras, números, puntos o guiones.'
        : campo === 'nombre' ? 'Escribe el nombre y apellido de quien viene.'
        : 'Revisa la hora elegida.';
      return this.horas(medicoId, fecha, aviso, previo);
    }
    try {
      const reserva = await this.reservas.reservar(dto);
      const resumen = `${reserva.medico} · ${fechaLarga(reserva.fecha)} · ${reserva.hora}`;
      const { precio, bancoId } = reserva.pago;
      const qrClave = precio && bancoId !== null ? await this.qrATiempo(bancoId) : null;
      /* El chat cobra solo con monto Y QR: uno sin el otro no se puede pagar. */
      const pago = sellarCierreReserva({
        telefono, reserva: reserva.codigo, montoCentavos: qrClave && precio ? precio.importeCentavos : null, qrClave,
      }, flowToken);
      return {
        screen: 'SUCCESS',
        data: {
          extension_message_response: {
            params: { flow_token: flowToken, flow_version: VERSION_FLOW_RESERVA, reserva: String(reserva.codigo), resumen: recortar(resumen, 200), pago },
          },
        },
      };
    } catch (error) {
      if (error instanceof HttpException) {
        const cuerpo = error.getResponse() as { codigo?: string; message?: string } | string;
        const codigo = typeof cuerpo === 'object' ? cuerpo.codigo : undefined;
        if (codigo === 'HORA_NO_DISPONIBLE') return this.horas(medicoId, fecha, 'Esa hora acaba de ocuparse. Elige otra.', previo);
        if (error.getStatus() < 500) return this.horas(medicoId, fecha, typeof cuerpo === 'object' && cuerpo.message ? String(cuerpo.message) : 'Revisa los datos.', previo);
      }
      this.logger.warn(`Reserva por Flow no completada: ${error instanceof Error ? error.message : 'error'}`);
      return this.horas(medicoId, fecha, 'No pudimos registrar la reserva. Vuelve a intentarlo o escríbenos por el chat.', previo);
    }
  }

  private qrATiempo(bancoId: number): Promise<string | null> {
    let reloj: NodeJS.Timeout | undefined;
    const limite = new Promise<null>(resolver => { reloj = setTimeout(() => resolver(null), ESPERA_QR_MS); reloj.unref(); });
    return Promise.race([this.reservas.prepararQr(bancoId), limite]).finally(() => clearTimeout(reloj));
  }
}
