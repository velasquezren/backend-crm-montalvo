import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { enSegundoPlano } from '../../common/fiabilidad/en-segundo-plano';
import { AccesoMedicoAgendaService, MedicoAutorizado } from '../agenda/acceso-medico-agenda.service';
import { AgendaMedicoCitasService } from '../agenda/agenda-medico-citas.service';
import { Mensaje, MotivoAtencion, Prisma, ResultadoTurnoAsistente } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { pieDeLaImagen, textoListado, textoResumen } from '../asistente/agenda-medico-imagen';
import { AsistenteDeLinea, AsistenteLineasService } from '../asistente/asistente-lineas.service';
import { ConversacionAsistente, TrazaTurno } from '../asistente/conversacion-asistente';
import { AccionAsistente, EstadoPagoParaAsistente, HERRAMIENTAS, PuertoMedico, PuertoVentas } from '../asistente/herramientas';
import { ImagenAgendaMedicoService } from '../asistente/imagen-agenda-medico.service';
import { ImagenHorarioService } from '../asistente/imagen-horario.service';
import { Clasificacion, ClasificadorMensajes, ModeloConversacional, TurnoModelo, UsoModelo } from '../asistente/modelo.port';
import { ahoraEnLaPaz, promptDelMedico, promptDelSistema } from '../asistente/prompt-sistema';
import { conPresentacion, debePresentarse, paraWhatsapp } from '../asistente/texto-whatsapp';
import { TEXTO_AUDIO_NO_ENTENDIDO } from '../asistente/transcripcion';
import { CLASIFICACION_FALLIDA, decidirTriaje } from '../asistente/triaje';
import { CobrosService } from '../cobros/cobros.service';
import { orientacionDeEmergencia } from '../menu-atencion/menu-atencion';
import { MenuAtencionService } from '../menu-atencion/menu-atencion.service';
import { ConversacionesGateway } from './conversaciones.gateway';
import { obtenerConversacionPropia } from './envio-comun';
import { EscuchaAudiosService } from './escucha-audios.service';
import { IngestaWhatsappService } from './ingesta-whatsapp.service';
import { interaccionesEnLinea } from './interacciones-integracion';
import { informesEnLinea } from '../resultados/informes-chat.service';
import { pagoDelChat } from './pagos-chat';
import { PromocionesChatService } from './promociones-chat.service';
import type { PromocionChat } from '../promociones/promociones.service';
import { AccionSugerida, accionesDe, accionesSugeridas } from './sugerencias-chat';

/*
 * El asistente de IA dentro de un chat (docs/asistente-ia.md). Dueño de
 * `SugerenciaAsistente` y `TurnoAsistente`.
 *
 * La ingesta le avisa de cada texto o nota de voz que llega a una línea con asistente; aquí
 * se espera unos segundos (las pacientes escriben en ráfagas: «hola» · «una
 * consulta» · «cuánto sale el botox»), se filtra, se piensa, y:
 *
 * - SUGERIR: queda una sugerencia en el chat para la agente. No se le escribe a
 *   nadie ni cambia nada del chat.
 * - RESPONDER: sale como automático marcado `asistente`, por el MISMO camino
 *   que el menú y el acuse (`IngestaWhatsappService`), que respeta la pausa y
 *   la atención humana bajo su candado.
 *
 * Nada de esto es durable a propósito: si el proceso se reinicia en medio de
 * un turno, el mensaje queda como estaba sin asistente —en «Sin responder»,
 * para una persona—. Reintentar un turno horas después sería peor que no
 * contestar.
 */

/** Lo que la ingesta le pasa al asistente. */
export interface EntranteParaAsistente {
  readonly conversacionId: string;
  readonly mensajeId: string;
  readonly lineaId: string;
  readonly telefono: string;
  readonly asistente: AsistenteDeLinea;
}

/** Lo que la ingesta necesita del asistente; se registra al arrancar (`usarAsistente`). */
export interface ProgramadorAsistente {
  activoEn(lineaId: string): Promise<AsistenteDeLinea | null>;
  programar(e: EntranteParaAsistente): void;
}

/** Lo que se le dice a la paciente cuando el asistente la pasa a una persona. No lo escribe el modelo. */
export const TEXTO_DERIVACION = 'Gracias por escribirnos. Le paso tu consulta a una persona del equipo, que te responderá por aquí.';

/**
 * Cuánto se espera a que termine de escribir. Cada mensaje nuevo reinicia la espera…
 * 3 s (antes 6, 12/10): la ráfaga típica entra en ese tiempo, y si llega otro mensaje
 * mientras piensa, `llegoAlgoDespues` descarta la respuesta y el turno siguiente
 * contesta todo junto. Más corto no cambia QUÉ contesta, solo cuándo.
 */
const ESPERA_POR_DEFECTO_MS = 3_000;
/** …pero nunca más que esto desde el primero. */
const ESPERA_MAXIMA_MS = 20_000;
/** Turnos simultáneos en todo el servidor: comparte máquina y pool con las agentes. */
const TURNOS_SIMULTANEOS = 3;
/** Si una persona escribió hace menos que esto, está atendiendo: el asistente no interrumpe. */
const PERSONA_ATENDIENDO_MS = 15 * 60_000;
/** Una conversación con más turnos que esto en una hora es un bucle o un abuso. */
const TURNOS_POR_HORA = 15;
/** Lo que se le muestra del historial al modelo. */
const MENSAJES_DE_CONTEXTO = 30;
const VENTANA_MS = 24 * 3_600_000;

const SELECT_MENSAJE = {
  id: true, direccion: true, tipo: true, contenido: true, mediaNombre: true, transcripcion: true, automatico: true, createdAt: true,
  interaccion: { select: { vista: true } },
} satisfies Prisma.MensajeSelect;
type MensajeDeContexto = Pick<Mensaje, Exclude<keyof typeof SELECT_MENSAJE, 'interaccion'>> & { interaccion?: { vista: Prisma.JsonValue } | null };

/**
 * Un mensaje como lo ve el modelo. Lo que no puede ver, lo dice. Una nota de voz
 * de la ráfaga que se contesta llega transcrita (`escuchados`); las anteriores, no.
 */
export function aTurno(m: MensajeDeContexto, escuchados?: ReadonlyMap<string, string | null>): TurnoModelo | null {
  const vista = m.interaccion?.vista;
  if (vista && typeof vista === 'object' && !Array.isArray(vista) && vista['proposito'] === 'INFORMES') return null;
  const pie = m.contenido.trim().slice(0, 1000);
  const oido = m.tipo === 'AUDIO' ? escuchados?.get(m.id) : undefined;
  const texto = m.tipo === 'TEXTO' ? pie
    : m.tipo === 'IMAGEN' ? `[Imagen${pie ? `: ${pie}` : ''}]`
    : m.tipo === 'DOCUMENTO' ? `[Documento${m.mediaNombre ? ` «${m.mediaNombre}»` : ''}]`
    : m.tipo === 'AUDIO' ? (oido ? `[Nota de voz, transcrita] ${oido}` : oido === null ? '[Nota de voz: no se pudo escuchar]' : '[Audio: no lo puedes escuchar]')
    : m.tipo === 'VIDEO' ? '[Video]'
    : '[Sticker]';
  if (!texto) return null;
  return m.direccion === 'ENTRANTE' ? { rol: 'paciente', texto } : { rol: 'clinica', texto };
}

/** Lo que la paciente escribió desde el último mensaje de la clínica: la ráfaga que se contesta. */
export function rafagaDeLaPaciente(historial: readonly TurnoModelo[]): string {
  const ultimos: string[] = [];
  for (let i = historial.length - 1; i >= 0; i--) {
    const t = historial[i];
    if (t.rol !== 'paciente') break;
    ultimos.unshift(t.texto);
  }
  return ultimos.join('\n');
}

const ESTADO_PAGO: Record<string, EstadoPagoParaAsistente> = {
  PENDIENTE: 'ESPERANDO_COMPROBANTE',
  COMPROBANTE_ENVIADO: 'COMPROBANTE_EN_REVISION',
  CONFIRMADO: 'CONFIRMADO',
  ANULADO: 'ANULADO',
};

const sumarUso = (a: UsoModelo, b: UsoModelo): UsoModelo => ({ tokensEntrada: a.tokensEntrada + b.tokensEntrada, tokensSalida: a.tokensSalida + b.tokensSalida });

interface Registro {
  readonly resultado: ResultadoTurnoAsistente;
  readonly motivo?: string;
  readonly categoria?: string;
  readonly traza?: TrazaTurno;
  readonly tokensExtra?: UsoModelo;
}

@Injectable()
export class AsistenteChatService implements ProgramadorAsistente, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AsistenteChatService.name);
  private readonly esperas = new Map<string, { temporizador: NodeJS.Timeout; desde: number }>();
  private readonly enCurso = new Set<string>();
  private turnosActivos = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: ConversacionesGateway,
    private readonly ingesta: IngestaWhatsappService,
    private readonly lineas: AsistenteLineasService,
    private readonly conversacion: ConversacionAsistente,
    private readonly modelo: ModeloConversacional,
    private readonly clasificador: ClasificadorMensajes,
    private readonly imagenes: ImagenHorarioService,
    private readonly accesoMedicos: AccesoMedicoAgendaService,
    private readonly citasMedico: AgendaMedicoCitasService,
    private readonly imagenesAgenda: ImagenAgendaMedicoService,
    private readonly escuchas: EscuchaAudiosService,
    private readonly promociones: PromocionesChatService,
    private readonly cobros: CobrosService,
    private readonly menus: MenuAtencionService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.ingesta.usarAsistente(this);
  }

  onModuleDestroy(): void {
    for (const { temporizador } of this.esperas.values()) clearTimeout(temporizador);
    this.esperas.clear();
  }

  activoEn(lineaId: string): Promise<AsistenteDeLinea | null> {
    return this.lineas.activoEn(lineaId);
  }

  /* ── El turno ───────────────────────────────────────────────────────── */

  /** Espera a que termine de escribir y entonces atiende. Sin `await`: la ingesta no espera. */
  programar(e: EntranteParaAsistente): void {
    const ahora = Date.now();
    const previa = this.esperas.get(e.conversacionId);
    if (previa) clearTimeout(previa.temporizador);
    const desde = previa?.desde ?? ahora;
    const espera = Math.max(0, Math.min(this.esperaMs(), desde + ESPERA_MAXIMA_MS - ahora));
    const temporizador = setTimeout(() => {
      this.esperas.delete(e.conversacionId);
      void enSegundoPlano(`turno del asistente en ${e.conversacionId}`, this.logger, () => this.cuandoHayaLugar(e));
    }, espera);
    temporizador.unref();
    this.esperas.set(e.conversacionId, { temporizador, desde });
  }

  /** Presentarse como asistente: una vez por día y por chat, salvo `ASISTENTE_PRESENTACION=off`. */
  private presentarse(yaPresentado: boolean): boolean {
    return debePresentarse(yaPresentado, this.config.get<string>('ASISTENTE_PRESENTACION'));
  }

  private esperaMs(): number {
    const v = Number(this.config.get<string>('ASISTENTE_ESPERA_MS'));
    return Number.isFinite(v) && v >= 0 ? v : ESPERA_POR_DEFECTO_MS;
  }

  /** Un turno por conversación y pocos a la vez; si no hay lugar, vuelve a esperar. */
  private async cuandoHayaLugar(e: EntranteParaAsistente): Promise<void> {
    if (this.enCurso.has(e.conversacionId) || this.turnosActivos >= TURNOS_SIMULTANEOS) {
      this.programar(e);
      return;
    }
    this.enCurso.add(e.conversacionId);
    this.turnosActivos++;
    try {
      await this.atender(e);
    } finally {
      this.enCurso.delete(e.conversacionId);
      this.turnosActivos--;
    }
  }

  /**
   * Un turno completo. Público para las pruebas, que lo llaman sin la espera.
   * Devuelve lo que hizo, que es también lo que queda registrado.
   */
  async atender(e: EntranteParaAsistente): Promise<ResultadoTurnoAsistente> {
    const inicio = Date.now();
    const registrar = (r: Registro) => this.registrar(e, r, inicio).then(() => r.resultado);
    const responde = e.asistente.modo === 'RESPONDER';

    const conversacion = await this.prisma.conversacion.findUnique({
      where: { id: e.conversacionId },
      select: { automatizacionPausadaEn: true, cliente: { select: { nombre: true } } },
    });
    if (!conversacion) return 'OMITIDO';
    const mensajes = (await this.prisma.mensaje.findMany({
      /* Sin lo que no le llegó. Con `OR` y no con `NOT`: en SQL, `NOT (estado = 'FALLIDO')`
         descarta también los NULL, que son TODOS los mensajes de ella. */
      where: { conversacionId: e.conversacionId, createdAt: { gte: new Date(inicio - VENTANA_MS) }, OR: [{ estadoEnvio: null }, { estadoEnvio: { not: 'FALLIDO' } }] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MENSAJES_DE_CONTEXTO,
      select: SELECT_MENSAJE,
    })).reverse();

    const ultimoEntrante = [...mensajes].reverse().find(m => m.direccion === 'ENTRANTE');
    if (!ultimoEntrante || (ultimoEntrante.tipo !== 'TEXTO' && ultimoEntrante.tipo !== 'AUDIO')) {
      return registrar({ resultado: 'OMITIDO', motivo: 'Lo último que mandó no es un texto ni una nota de voz.' });
    }
    const personas = mensajes.filter(m => m.direccion === 'SALIENTE' && !m.automatico);
    if (personas.some(m => m.createdAt > ultimoEntrante.createdAt)) return registrar({ resultado: 'OMITIDO', motivo: 'Una persona ya contestó.' });
    /* ¿Quien escribe es un médico con el número autorizado? Es otra conversación, con otras reglas. */
    const medico = await this.accesoMedicos.porTelefono(e.telefono);
    /* La pausa protege a una PACIENTE que pidió una persona; a un médico solo lo dejaría
       sin su agenda. Lo que sí vale para los dos: si una persona está escribiendo, no se interrumpe. */
    if (responde && !medico && conversacion.automatizacionPausadaEn) return registrar({ resultado: 'OMITIDO', motivo: 'La automatización está pausada: espera a una persona.' });
    if (responde && personas.some(m => m.createdAt.getTime() > inicio - PERSONA_ATENDIENDO_MS)) {
      return registrar({ resultado: 'OMITIDO', motivo: 'Una persona está atendiendo este chat.' });
    }
    const turnosRecientes = await this.prisma.turnoAsistente.count({
      where: { conversacionId: e.conversacionId, createdAt: { gte: new Date(inicio - 3_600_000) }, resultado: { not: 'OMITIDO' } },
    });
    if (turnosRecientes >= TURNOS_POR_HORA) {
      if (responde) await this.ingesta.respaldoSinAsistente(e.conversacionId, e.telefono);
      return registrar({ resultado: 'OMITIDO', motivo: `Más de ${TURNOS_POR_HORA} turnos en una hora.` });
    }

    /* Un médico en «Sugerir» se omite ANTES de escuchar: lo que no se va a contestar no se manda a transcribir. */
    if (medico && !responde) {
      return registrar({ resultado: 'OMITIDO', motivo: 'Es un médico autorizado: su agenda solo se contesta en «Responder solo».' });
    }

    /* Las notas de voz de la ráfaga, a texto. Desde aquí son mensajes como cualquier otro. */
    const escucha = await this.escuchas.escuchar(mensajes);
    if (ultimoEntrante.tipo === 'AUDIO' && !escucha.transcripciones.get(ultimoEntrante.id)) {
      return this.audioNoEntendido(e, ultimoEntrante, responde, !!medico, registrar, escucha.uso);
    }
    const historial = mensajes.map(m => aTurno(m, escucha.transcripciones)).filter((t): t is TurnoModelo => t !== null);
    if (medico) return this.atenderMedico(e, medico, historial, ultimoEntrante, inicio, registrar, escucha.uso);

    /* 1. El filtro de entrada, antes de que el modelo escriba nada. */
    let clasificacion: Pick<Clasificacion, 'categoria' | 'confianza'>;
    let tokensExtra: UsoModelo = { tokensEntrada: 0, tokensSalida: 0 };
    try {
      const c = await this.clasificador.clasificar({ mensaje: rafagaDeLaPaciente(historial), contexto: historial, criterio: e.asistente.criterioDerivacion });
      clasificacion = c;
      tokensExtra = sumarUso(c.uso, escucha.uso);
    } catch (error: unknown) {
      /* Si el filtro no responde, no se arriesga: se trata como duda. */
      this.logger.warn(`Clasificador: ${error instanceof Error ? error.message : 'falló'}`);
      clasificacion = CLASIFICACION_FALLIDA;
      tokensExtra = escucha.uso;
    }
    const triaje = decidirTriaje(clasificacion);
    if (triaje.tipo === 'DERIVAR') {
      if (responde) await this.derivar(e, triaje.motivoAtencion);
      else await this.sugerir(e, '', [], triaje.aviso);
      return registrar({ resultado: 'DERIVO', motivo: triaje.aviso, categoria: clasificacion.categoria, tokensExtra });
    }

    /* 2. La conversación. */
    const salida = await this.conversacion.responder({
      sistema: promptDelSistema({
        ahora: ahoraEnLaPaz(new Date(inicio)),
        nombrePaciente: conversacion.cliente.nombre,
        ventas: e.asistente.comercial,
        conocimiento: e.asistente.conocimiento,
      }),
      contexto: { telefono: e.telefono, ventas: e.asistente.comercial ? this.puertoVentas(e) : null, informes: informesEnLinea(e.lineaId) },
      historial,
      permitirEscritura: false,
    });
    const base = { categoria: clasificacion.categoria, traza: salida.traza, tokensExtra };
    if (salida.tipo === 'sin-respuesta') {
      if (responde) await this.ingesta.respaldoSinAsistente(e.conversacionId, e.telefono);
      return registrar({ resultado: 'FALLO', motivo: salida.motivo, ...base });
    }

    const derivacion = salida.acciones.find(a => a.tipo === 'DERIVAR');
    const envios = salida.acciones.filter(a => a.tipo !== 'DERIVAR');
    // La gestión de informes usa exclusivamente el texto determinista de la lista.
    const texto = envios.some(a => a.tipo === 'INFORMES') ? '' : salida.texto ? paraWhatsapp(salida.texto) : '';

    if (!responde) {
      /* Lo médico no se sugiere ni redactado: la agente lo escribe ella. */
      const sinTexto = derivacion?.tipo === 'DERIVAR' && (derivacion.motivo === 'MEDICO' || derivacion.motivo === 'URGENCIA');
      const aviso = derivacion?.tipo === 'DERIVAR' ? `El asistente sugiere que lo atienda una persona: ${derivacion.resumen}` : null;
      await this.sugerir(e, sinTexto ? '' : texto, envios, aviso);
      return registrar({ resultado: derivacion ? 'DERIVO' : 'SUGIRIO', motivo: aviso ?? undefined, ...base });
    }

    /* 3. RESPONDER: solo si nada cambió mientras pensaba. */
    if (await this.llegoAlgoDespues(e.conversacionId, ultimoEntrante)) {
      return registrar({ resultado: 'OMITIDO', motivo: 'Llegó otro mensaje mientras pensaba: lo contesta el turno siguiente.', ...base });
    }
    if (derivacion?.tipo === 'DERIVAR') {
      await this.derivar(e, derivacion.motivo === 'URGENCIA' ? 'POSIBLE_URGENCIA' : 'DERIVADA_ASISTENTE');
      return registrar({ resultado: 'DERIVO', motivo: derivacion.resumen, ...base });
    }
    if (texto) {
      const presentado = await this.prisma.mensaje.findFirst({
        where: { conversacionId: e.conversacionId, asistente: true, createdAt: { gte: new Date(inicio - VENTANA_MS) } },
        select: { id: true },
      });
      if (!(await this.ingesta.responderComoAsistente(e.conversacionId, e.telefono, conPresentacion(texto, this.presentarse(!!presentado))))) {
        return registrar({ resultado: 'OMITIDO', motivo: 'Se pausó la automatización mientras pensaba.', ...base });
      }
    }
    for (const accion of envios) await this.ejecutar(e.conversacionId, e.telefono, e.lineaId, accion, { respetaPausa: true });
    return registrar({ resultado: 'RESPONDIO', ...base });
  }

  /* ── Un médico pregunta por su agenda ───────────────────────────────── */

  /**
   * Lo que el modelo no puede decir sin haberlo consultado. Las HORAS pueden salir
   * de una consulta informativa (el horario de un médico, los cupos). Las
   * CANTIDADES y ESTADOS de citas, nunca del modelo: solo de `mi_agenda`, cuyo texto
   * arma el código. Un «tienes 3 citas» tras mirar las especialidades es inventado.
   */
  private static readonly AFIRMA_HORAS = /\b\d{1,2}:\d{2}\b/;
  private static readonly AFIRMA_CITAS = /\b\d+\s+citas?\b|\b(confirmadas?|por confirmar|pendientes?)\b/i;

  /**
   * El turno de un médico autorizado (docs/asistente-ia.md, «Agenda del médico»).
   *
   * - Solo en «Responder solo» (lo comprueba `atender`, antes de escuchar sus audios):
   *   el borrador de «Sugerir» lo ve una agente, y la agenda de un médico no es para ella.
   * - Sin el filtro de entrada ni nada que mande, cobre o reserve: `mi_agenda`
   *   (atada al médico que salió del NÚMERO), lo informativo de la clínica
   *   (especialidades, médicos, horarios, cupos, promociones) y pasar a una persona.
   * - Lo que se le manda lo arma el código con los datos de la agenda; el texto del
   *   modelo, si lo hay, se descarta cuando ya se le mandó el listado.
   */
  private async atenderMedico(
    e: EntranteParaAsistente, medico: MedicoAutorizado, historial: readonly TurnoModelo[], ultimoEntrante: MensajeDeContexto,
    inicio: number, registrar: (r: Registro) => Promise<ResultadoTurnoAsistente>, tokensExtra: UsoModelo,
  ): Promise<ResultadoTurnoAsistente> {
    const salida = await this.conversacion.responder({
      sistema: promptDelMedico({
        ahora: ahoraEnLaPaz(new Date(inicio)), medico: medico.nombre, conocimiento: e.asistente.conocimiento, ventas: e.asistente.comercial,
      }),
      /* Las promociones se leen por el puerto de ventas; mandarlas o cobrar no está en sus herramientas. */
      contexto: { telefono: e.telefono, ventas: e.asistente.comercial ? this.puertoVentas(e) : null, medico: this.puertoMedico(medico) },
      historial,
      permitirEscritura: false,
    });
    const base = { categoria: 'MEDICO_AGENDA', traza: salida.traza, tokensExtra };
    if (salida.tipo === 'sin-respuesta') {
      /* Con un médico no vale el acuse de siempre: una persona lo atiende. */
      await this.derivar(e, 'DERIVADA_ASISTENTE', { medico: true });
      return registrar({ resultado: 'FALLO', motivo: salida.motivo, ...base });
    }
    if (await this.llegoAlgoDespues(e.conversacionId, ultimoEntrante)) {
      return registrar({ resultado: 'OMITIDO', motivo: 'Llegó otro mensaje mientras pensaba: lo contesta el turno siguiente.', ...base });
    }
    const derivacion = salida.acciones.find(a => a.tipo === 'DERIVAR');
    if (derivacion?.tipo === 'DERIVAR') {
      await this.derivar(e, derivacion.motivo === 'URGENCIA' ? 'POSIBLE_URGENCIA' : 'DERIVADA_ASISTENTE', { medico: true });
      return registrar({ resultado: 'DERIVO', motivo: derivacion.resumen, ...base });
    }
    const agendas = salida.acciones.filter((a): a is Extract<AccionAsistente, { tipo: 'AGENDA_MEDICO' }> => a.tipo === 'AGENDA_MEDICO');
    if (agendas.length > 0) {
      let primero = true;
      for (const a of agendas) {
        if (!(await this.enviarAgendaMedico(e, a, primero))) {
          return registrar({ resultado: 'OMITIDO', motivo: 'Se pausó la automatización mientras pensaba.', ...base });
        }
        primero = false;
      }
      return registrar({ resultado: 'RESPONDIO', ...base });
    }
    /* Sin consulta no hay dato. Con una consulta informativa (el horario de otro
       médico, cupos) las horas salen de ella; las citas, nunca del modelo. */
    const texto = salida.texto ? paraWhatsapp(salida.texto) : '';
    const consultoLaClinica = salida.traza.herramientas.some(h => h.ok && HERRAMIENTAS.some(x => x.nombre === h.nombre && x.informativa));
    const inventa = AsistenteChatService.AFIRMA_CITAS.test(texto) || (!consultoLaClinica && AsistenteChatService.AFIRMA_HORAS.test(texto));
    if (!texto || inventa) {
      await this.derivar(e, 'DERIVADA_ASISTENTE', { medico: true });
      return registrar({ resultado: 'DERIVO', motivo: texto ? 'El modelo habló de la agenda sin consultarla.' : 'Sin respuesta utilizable.', ...base });
    }
    const presentado = await this.prisma.mensaje.findFirst({
      where: { conversacionId: e.conversacionId, asistente: true, createdAt: { gte: new Date(inicio - VENTANA_MS) } }, select: { id: true },
    });
    if (!(await this.ingesta.responderComoAsistente(e.conversacionId, e.telefono, conPresentacion(texto, this.presentarse(!!presentado)), { medico: true, resuelve: true }))) {
      return registrar({ resultado: 'OMITIDO', motivo: 'Se pausó la automatización mientras pensaba.', ...base });
    }
    return registrar({ resultado: 'RESPONDIO', ...base });
  }

  /** La agenda de ESTE médico, atada a él: el modelo solo elige el día. */
  private puertoMedico(medico: MedicoAutorizado): PuertoMedico {
    return { nombre: medico.nombre, agendaDelDia: fecha => this.citasMedico.delDia(medico.agendaMedicoId, fecha) };
  }

  /**
   * Imagen con el resumen de pie si es una lista; texto si solo pidió cantidades o si la imagen no se pudo.
   * Sale aunque haya una solicitud en curso (la pausa es para pacientes) y deja su chat
   * fuera de «Sin responder»: su autoservicio quedó servido.
   */
  private async enviarAgendaMedico(e: EntranteParaAsistente, a: Extract<AccionAsistente, { tipo: 'AGENDA_MEDICO' }>, primero: boolean): Promise<boolean> {
    const { medico, agenda, detalle } = a;
    const presentar = async (texto: string) => {
      if (!primero) return texto;
      const antes = await this.prisma.mensaje.findFirst({
        where: { conversacionId: e.conversacionId, asistente: true, createdAt: { gte: new Date(Date.now() - VENTANA_MS) } }, select: { id: true },
      });
      return conPresentacion(texto, this.presentarse(!!antes));
    };
    if (detalle === 'LISTA' && agenda.total > 0) {
      const imagen = await this.imagenesAgenda.de(medico, agenda);
      if (imagen) {
        return this.ingesta.imagenDesdeAsistente(e.conversacionId, e.telefono, await presentar(pieDeLaImagen(medico, agenda)), imagen, { respetaPausa: false, repetible: true, resuelve: true });
      }
      return this.ingesta.responderComoAsistente(e.conversacionId, e.telefono, await presentar(textoListado(medico, agenda)), { medico: true, resuelve: true });
    }
    return this.ingesta.responderComoAsistente(e.conversacionId, e.telefono, await presentar(textoResumen(medico, agenda)), { medico: true, resuelve: true });
  }

  /**
   * La nota de voz que se iba a contestar no se pudo escuchar (no bajó a tiempo,
   * pesaba demasiado, no se entendía o el proveedor falló). No se adivina: en
   * «Responder solo» se le pide, con un texto fijo, que lo escriba; en «Sugerir»,
   * la agente ve el aviso y la escucha ella.
   */
  private async audioNoEntendido(
    e: EntranteParaAsistente, ultimo: MensajeDeContexto, responde: boolean, medico: boolean,
    registrar: (r: Registro) => Promise<ResultadoTurnoAsistente>, tokensExtra: UsoModelo,
  ): Promise<ResultadoTurnoAsistente> {
    const motivo = 'No se pudo escuchar la nota de voz.';
    if (!responde) {
      await this.sugerir(e, '', [], 'El asistente no pudo escuchar esta nota de voz: escúchala tú.');
      return registrar({ resultado: 'OMITIDO', motivo, tokensExtra });
    }
    if (await this.llegoAlgoDespues(e.conversacionId, ultimo)) {
      return registrar({ resultado: 'OMITIDO', motivo: `${motivo} Llegó otro mensaje: lo contesta el turno siguiente.`, tokensExtra });
    }
    const enviado = await this.ingesta.responderComoAsistente(e.conversacionId, e.telefono, TEXTO_AUDIO_NO_ENTENDIDO, { medico });
    return registrar({ resultado: enviado ? 'RESPONDIO' : 'OMITIDO', motivo: `${motivo} Se le pidió que lo escriba.`, tokensExtra });
  }

  /** ¿Escribió ella o una persona después del mensaje que se está contestando? */
  private async llegoAlgoDespues(conversacionId: string, ultimo: MensajeDeContexto): Promise<boolean> {
    return !!(await this.prisma.mensaje.findFirst({
      where: {
        conversacionId, createdAt: { gt: ultimo.createdAt },
        OR: [{ direccion: 'ENTRANTE' }, { direccion: 'SALIENTE', automatico: false }],
      },
      select: { id: true },
    }));
  }

  /**
   * La pasa a una persona: la solicitud en «Atención» y un aviso que no inventa nada.
   * Con un médico (`medico`), la solicitud queda pero lo automático NO se pausa: su
   * próxima pregunta por la agenda se sigue contestando.
   */
  private async derivar(e: EntranteParaAsistente, motivo: Extract<MotivoAtencion, 'POSIBLE_URGENCIA' | 'DERIVADA_ASISTENTE'>, { medico = false } = {}): Promise<void> {
    await this.ingesta.derivarDesdeAsistente(e.conversacionId, e.mensajeId, motivo, { pausar: !medico });
    /* Ante una posible urgencia, la orientación que aprobó la clínica, si la escribió. */
    const orientacion = motivo === 'POSIBLE_URGENCIA' ? orientacionDeEmergencia(await this.menus.activoDe(e.lineaId)) : null;
    await this.ingesta.avisoDelAsistente(e.conversacionId, e.telefono, orientacion ?? TEXTO_DERIVACION);
  }

  /** Lo que el turno mandó hacer (RESPONDER) o lo que una agente aprobó de una sugerencia. */
  private async ejecutar(conversacionId: string, telefono: string, lineaId: string, accion: AccionAsistente | AccionSugerida, { respetaPausa }: { respetaPausa: boolean }): Promise<boolean> {
    try {
      if (accion.tipo === 'INFORMES') return await this.ingesta.ofrecerInformes(conversacionId, telefono);
      if (accion.tipo === 'PROMOCION' && accion.promocionId) {
        return await this.ingesta.tarjetaDesdeAsistente(conversacionId, telefono, lineaId, accion.promocionId, { respetaPausa, servicioId: accion.servicioId });
      }
      if (accion.tipo === 'HORARIO' && accion.medicoId !== undefined) {
        const nombre = 'nombre' in accion ? accion.nombre : accion.titulo;
        const pie = [`🗓️ Horario de ${nombre}`, accion.horario ?? ''].filter(Boolean).join('\n');
        const imagen = await this.imagenes.de(accion.medicoId).catch((error: unknown) => {
          this.logger.warn(`Imagen del horario ${accion.medicoId}: ${error instanceof Error ? error.message : 'falló'}`);
          return null;
        });
        return await this.ingesta.imagenDesdeAsistente(conversacionId, telefono, pie, imagen, { respetaPausa });
      }
    } catch (error: unknown) {
      this.logger.error(`No se pudo ejecutar «${accion.tipo}» del asistente`, error instanceof Error ? error.stack : undefined);
    }
    return false;
  }

  /** Lo comercial de ESTA conversación, atado a ella: el modelo no pasa ids. */
  private puertoVentas(e: EntranteParaAsistente): PuertoVentas {
    const precio = (p: Pick<PromocionChat, 'precio' | 'precioRegular' | 'precioPromocional' | 'servicios'>) => ({
      precio: p.precio, precioRegular: p.precioRegular, precioPromocional: p.precioPromocional, servicios: p.servicios,
    });
    return {
      promociones: async () => (await this.promociones.paraMenu()).map(p => ({
        id: p.id, titulo: p.titulo, resumen: p.resumen, condiciones: '', etiquetaOferta: p.etiquetaOferta, vigenteHasta: p.vigenteHasta, ...precio(p),
      })),
      promocion: async id => {
        const p = await this.promociones.porId(id).catch(() => null);
        if (!p) return null;
        const cobro = await this.cobros.listoPara(e.lineaId);
        return {
          id: p.id, titulo: p.titulo, resumen: p.resumen, condiciones: p.condiciones, etiquetaOferta: p.etiquetaOferta, vigenteHasta: p.vigenteHasta, ...precio(p),
          sePuedePagarPorChat: !!cobro && (p.precio !== null || p.servicios.length > 0),
          sePuedeEnviarTarjeta: interaccionesEnLinea(e.lineaId),
        };
      },
      estadoDePago: async () => {
        const [pago, cobro] = await Promise.all([pagoDelChat(this.prisma, e.conversacionId), this.cobros.listoPara(e.lineaId)]);
        return {
          qrDisponible: !!cobro,
          pago: pago ? { estado: ESTADO_PAGO[pago.estado] ?? 'ANULADO', promocion: pago.promocion.titulo, monto: pago.monto, motivoRechazo: pago.motivoRechazo } : null,
        };
      },
    };
  }

  /* ── Sugerencias ────────────────────────────────────────────────────── */

  /** Una sugerencia nueva reemplaza a la anterior: como mucho una pendiente por chat. */
  private async sugerir(e: EntranteParaAsistente, texto: string, acciones: readonly AccionAsistente[], aviso: string | null): Promise<void> {
    if (!texto && !acciones.length && !aviso) return;
    await this.prisma.$transaction(async tx => {
      await tx.sugerenciaAsistente.updateMany({ where: { conversacionId: e.conversacionId, estado: 'PENDIENTE' }, data: { estado: 'SUPERADA', resueltaEn: new Date() } });
      await tx.sugerenciaAsistente.create({
        data: {
          conversacionId: e.conversacionId, mensajeId: e.mensajeId, texto: texto.slice(0, 4096),
          acciones: accionesSugeridas(acciones) as unknown as Prisma.InputJsonValue, aviso: aviso?.slice(0, 300) ?? null,
        },
      });
    });
    this.gateway.emitirActividad(e.conversacionId);
  }

  /** La agente la usó (la llevó a su caja de texto) o la descartó. Idempotente. */
  async resolverSugerencia(conversacionId: string, sugerenciaId: string, estado: 'USADA' | 'DESCARTADA', usuarioId: string, soloAgenteId?: string): Promise<{ ok: true }> {
    await obtenerConversacionPropia(this.prisma, conversacionId, soloAgenteId);
    await this.prisma.sugerenciaAsistente.updateMany({
      where: { id: sugerenciaId, conversacionId, estado: 'PENDIENTE' },
      data: { estado, resueltaEn: new Date(), resueltaPorId: usuarioId },
    });
    this.gateway.emitirActividad(conversacionId);
    return { ok: true };
  }

  /** Una agente aprueba una acción de la sugerencia: la tarjeta de una promoción, la imagen de un horario. */
  async ejecutarAccionSugerida(conversacionId: string, sugerenciaId: string, indice: number, usuarioId: string, soloAgenteId?: string): Promise<{ enviado: boolean }> {
    const conversacion = await obtenerConversacionPropia(this.prisma, conversacionId, soloAgenteId);
    const s = await this.prisma.sugerenciaAsistente.findFirst({
      where: { id: sugerenciaId, conversacionId, estado: { in: ['PENDIENTE', 'USADA'] } },
      select: { acciones: true },
    });
    if (!s) throw new NotFoundException('Esa sugerencia ya no está vigente.');
    const accion = accionesDe(s.acciones)[indice];
    if (!accion) throw new NotFoundException('Esa acción no existe en la sugerencia.');
    const ultimoEntrante = await this.prisma.mensaje.findFirst({
      where: { conversacionId, direccion: 'ENTRANTE' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true },
    });
    if (!ultimoEntrante || Date.now() - ultimoEntrante.createdAt.getTime() >= VENTANA_MS) {
      throw new BadRequestException('Pasaron más de 24 h desde su último mensaje: WhatsApp solo permite una plantilla.');
    }
    /* La aprobó una persona: sale aunque el chat esté pausado esperando a una persona. */
    const enviado = await this.ejecutar(conversacionId, conversacion.cliente.telefono, conversacion.linea.id, accion, { respetaPausa: false });
    if (!enviado) throw new ConflictException('No se pudo enviar: la promoción ya no está vigente o la línea no lo permite.');
    await this.prisma.auditLog.create({
      data: { entidad: 'SugerenciaAsistente', entidadId: sugerenciaId, accion: 'SUGERENCIA_ACCION', usuarioId, cambios: { tipo: accion.tipo, indice } },
    });
    return { enviado };
  }

  /* ── Registro ───────────────────────────────────────────────────────── */

  private async registrar(e: EntranteParaAsistente, r: Registro, inicio: number): Promise<void> {
    try {
      await this.prisma.turnoAsistente.create({
        data: {
          conversacionId: e.conversacionId, lineaId: e.lineaId, mensajeId: e.mensajeId, modo: e.asistente.modo,
          resultado: r.resultado, motivo: r.motivo?.slice(0, 300) ?? null, categoria: r.categoria ?? null,
          herramientas: (r.traza?.herramientas ?? []) as unknown as Prisma.InputJsonValue,
          modelo: r.resultado === 'OMITIDO' ? null : this.modelo.nombre.slice(0, 60),
          tokensEntrada: (r.traza?.tokensEntrada ?? 0) + (r.tokensExtra?.tokensEntrada ?? 0),
          tokensSalida: (r.traza?.tokensSalida ?? 0) + (r.tokensExtra?.tokensSalida ?? 0),
          latenciaMs: Date.now() - inicio,
        },
      });
    } catch (error: unknown) {
      /* El registro es para auditar; su fallo no deshace lo que ya se hizo. */
      this.logger.warn(`No se pudo registrar el turno: ${error instanceof Error ? error.message : 'falló'}`);
    }
  }
}
