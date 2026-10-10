import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { enSegundoPlano } from '../../common/fiabilidad/en-segundo-plano';
import { Mensaje, MotivoAtencion, Prisma, ResultadoTurnoAsistente } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { AsistenteDeLinea, AsistenteLineasService } from '../asistente/asistente-lineas.service';
import { ConversacionAsistente, TrazaTurno } from '../asistente/conversacion-asistente';
import { AccionAsistente, EstadoPagoParaAsistente, PuertoVentas } from '../asistente/herramientas';
import { ImagenHorarioService } from '../asistente/imagen-horario.service';
import { Clasificacion, ClasificadorMensajes, ModeloConversacional, TurnoModelo, UsoModelo } from '../asistente/modelo.port';
import { ahoraEnLaPaz, promptDelSistema } from '../asistente/prompt-sistema';
import { conPresentacion, paraWhatsapp } from '../asistente/texto-whatsapp';
import { CLASIFICACION_FALLIDA, decidirTriaje } from '../asistente/triaje';
import { CobrosService } from '../cobros/cobros.service';
import { orientacionDeEmergencia } from '../menu-atencion/menu-atencion';
import { MenuAtencionService } from '../menu-atencion/menu-atencion.service';
import { ConversacionesGateway } from './conversaciones.gateway';
import { obtenerConversacionPropia } from './envio-comun';
import { IngestaWhatsappService } from './ingesta-whatsapp.service';
import { interaccionesEnLinea } from './interacciones-integracion';
import { pagoDelChat } from './pagos-chat';
import { PromocionesChatService } from './promociones-chat.service';
import { AccionSugerida, accionesDe, accionesSugeridas } from './sugerencias-chat';

/*
 * El asistente de IA dentro de un chat (docs/asistente-ia.md). Dueño de
 * `SugerenciaAsistente` y `TurnoAsistente`.
 *
 * La ingesta le avisa de cada texto que llega a una línea con asistente; aquí
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

/** Cuánto se espera a que termine de escribir. Cada mensaje nuevo reinicia la espera… */
const ESPERA_POR_DEFECTO_MS = 6_000;
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
  id: true, direccion: true, tipo: true, contenido: true, mediaNombre: true, automatico: true, createdAt: true,
} satisfies Prisma.MensajeSelect;
type MensajeDeContexto = Pick<Mensaje, keyof typeof SELECT_MENSAJE>;

/** Un mensaje como lo ve el modelo. Lo que no puede ver, lo dice. */
export function aTurno(m: MensajeDeContexto): TurnoModelo | null {
  const pie = m.contenido.trim().slice(0, 1000);
  const texto = m.tipo === 'TEXTO' ? pie
    : m.tipo === 'IMAGEN' ? `[Imagen${pie ? `: ${pie}` : ''}]`
    : m.tipo === 'DOCUMENTO' ? `[Documento${m.mediaNombre ? ` «${m.mediaNombre}»` : ''}]`
    : m.tipo === 'AUDIO' ? '[Audio: no lo puedes escuchar]'
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
    if (!ultimoEntrante || ultimoEntrante.tipo !== 'TEXTO') return registrar({ resultado: 'OMITIDO', motivo: 'Lo último que mandó no es un texto.' });
    const personas = mensajes.filter(m => m.direccion === 'SALIENTE' && !m.automatico);
    if (personas.some(m => m.createdAt > ultimoEntrante.createdAt)) return registrar({ resultado: 'OMITIDO', motivo: 'Una persona ya contestó.' });
    if (responde && conversacion.automatizacionPausadaEn) return registrar({ resultado: 'OMITIDO', motivo: 'La automatización está pausada: espera a una persona.' });
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

    const historial = mensajes.map(aTurno).filter((t): t is TurnoModelo => t !== null);

    /* 1. El filtro de entrada, antes de que el modelo escriba nada. */
    let clasificacion: Pick<Clasificacion, 'categoria' | 'confianza'>;
    let tokensExtra: UsoModelo = { tokensEntrada: 0, tokensSalida: 0 };
    try {
      const c = await this.clasificador.clasificar({ mensaje: rafagaDeLaPaciente(historial), contexto: historial, criterio: e.asistente.criterioDerivacion });
      clasificacion = c;
      tokensExtra = c.uso;
    } catch (error: unknown) {
      /* Si el filtro no responde, no se arriesga: se trata como duda. */
      this.logger.warn(`Clasificador: ${error instanceof Error ? error.message : 'falló'}`);
      clasificacion = CLASIFICACION_FALLIDA;
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
      contexto: { telefono: e.telefono, ventas: e.asistente.comercial ? this.puertoVentas(e) : null },
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
    const texto = salida.texto ? paraWhatsapp(salida.texto) : '';

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
      if (!(await this.ingesta.responderComoAsistente(e.conversacionId, e.telefono, conPresentacion(texto, !presentado)))) {
        return registrar({ resultado: 'OMITIDO', motivo: 'Se pausó la automatización mientras pensaba.', ...base });
      }
    }
    for (const accion of envios) await this.ejecutar(e.conversacionId, e.telefono, e.lineaId, accion, { respetaPausa: true });
    return registrar({ resultado: 'RESPONDIO', ...base });
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

  /** La pasa a una persona: la solicitud en «Atención» y un aviso a la paciente que no inventa nada. */
  private async derivar(e: EntranteParaAsistente, motivo: Extract<MotivoAtencion, 'POSIBLE_URGENCIA' | 'DERIVADA_ASISTENTE'>): Promise<void> {
    await this.ingesta.derivarDesdeAsistente(e.conversacionId, e.mensajeId, motivo);
    /* Ante una posible urgencia, la orientación que aprobó la clínica, si la escribió. */
    const orientacion = motivo === 'POSIBLE_URGENCIA' ? orientacionDeEmergencia(await this.menus.activoDe(e.lineaId)) : null;
    await this.ingesta.avisoDelAsistente(e.conversacionId, e.telefono, orientacion ?? TEXTO_DERIVACION);
  }

  /** Lo que el turno mandó hacer (RESPONDER) o lo que una agente aprobó de una sugerencia. */
  private async ejecutar(conversacionId: string, telefono: string, lineaId: string, accion: AccionAsistente | AccionSugerida, { respetaPausa }: { respetaPausa: boolean }): Promise<boolean> {
    try {
      if (accion.tipo === 'PROMOCION' && accion.promocionId) {
        return await this.ingesta.tarjetaDesdeAsistente(conversacionId, telefono, lineaId, accion.promocionId, { respetaPausa });
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
    const precio = (p: { precio: number | null; precioRegular: number | null; precioPromocional: number | null }) => ({
      precio: p.precio, precioRegular: p.precioRegular, precioPromocional: p.precioPromocional,
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
          sePuedePagarPorChat: !!cobro && p.precio !== null,
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
