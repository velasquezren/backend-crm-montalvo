import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { enSegundoPlano } from '../../common/fiabilidad/en-segundo-plano';
import { BYTES_MAXIMOS_IMAGEN } from '../../common/storage/imagen-publica';
import { R2Service } from '../../common/storage/r2.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '../../prisma/prisma-client';
import { esChoqueUnicoEn } from '../../prisma/choque-unico';
import { AgendaReservasService } from '../agenda/agenda-reservas.service';
import { AsistenteLineasService } from '../asistente/asistente-lineas.service';
import { LecturaComprobante, referenciaComparable } from '../asistente/comprobante';
import { LectorComprobantes } from '../asistente/modelo.port';
import { CANDADO_AUTOMATICOS } from './atencion-humana';
import { decidirComprobanteDeReserva, detalleDeLectura, evaluarComprobanteDeReserva, lecturaGuardada, TEXTO_NO_ES_COMPROBANTE, textoRevisionParaPaciente } from './comprobante-reserva';
import { ConstanciaReservaService } from './constancia-reserva.service';
import { ConversacionesGateway } from './conversaciones.gateway';
import { DespachadorSalienteService } from './despachador-saliente.service';
import { interaccionesEnLinea, interaccionesHabilitadas } from './interacciones-integracion';
import { uuidEstable } from './pagos-chat';
import { ContactoWhatsapp, destinoWhatsapp } from '../../common/whatsapp/destino';

const INTERVALO_MS = 30_000;
const ESPERA_MEDIA_MS = 6 * 60 * 60 * 1000;
const MAX_INTENTOS = 20;
const POR_PASADA = 10;
const LEASE_MS = 120_000;
/** Lecturas fallidas (Gemini caído, respuesta rara) antes de dejarlo a una persona. */
const INTENTOS_LECTURA = 3;
const DETALLE = {
  NO_ES_IMAGEN: 'El comprobante debe ser una imagen JPG, PNG o WebP de hasta 5 MB. Revisa el archivo en el chat.',
  NO_ENCONTRADA: 'La reserva ya no existe en la agenda.',
  YA_NO_PENDIENTE: 'Revisa la agenda: la reserva ya tenía comprobante o recepción la gestionó. No se sobrescribió.',
  SIN_MEDIA: 'La imagen no se pudo descargar de WhatsApp.',
  AGENDA: 'No se pudo completar el registro automático. Revisa el comprobante en la agenda antes de cargarlo a mano.',
  SIN_LECTURA: 'La IA no pudo leer el comprobante. Revísalo en el chat antes de cargarlo a mano en la agenda.',
} as const;

type Pendiente = { id: string; reservaAgenda: number; intentos: number; comprobanteMensajeId: string | null;
  comprobanteRecibidoEn: Date | null; updatedAt: Date; createdAt: Date; monto: Prisma.Decimal | null; lecturaComprobante: Prisma.JsonValue;
  conversacionId: string; conversacion: { lineaId: string | null; cliente: ContactoWhatsapp } };

/** Cola durable de comprobantes; nunca confirma pagos. MySQL sigue siendo la
 * fuente. CAS con lease recuperable tras reinicio, solo líneas habilitadas.
 *
 * Con la lectura de comprobantes encendida en la línea (Líneas WhatsApp →
 * Asistente), la IA lee la imagen ANTES de llevarla a la agenda y solo pasa sola
 * la que coincide (`comprobante-reserva.ts`). Con la lectura apagada, como antes. */
@Injectable()
export class ComprobantesReservaChatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ComprobantesReservaChatService.name);
  private intervalo?: NodeJS.Timeout;
  private corriendo = false;
  constructor(private readonly prisma: PrismaService, private readonly r2: R2Service,
    private readonly agenda: AgendaReservasService, private readonly gateway: ConversacionesGateway,
    private readonly constancia: ConstanciaReservaService, private readonly lineas: AsistenteLineasService,
    private readonly lector: LectorComprobantes, private readonly despachador: DespachadorSalienteService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.intervalo = setInterval(() => void enSegundoPlano('comprobantes de reservas del chat', this.logger, () => this.procesar()), INTERVALO_MS);
    this.intervalo.unref();
  }
  onModuleDestroy(): void { clearInterval(this.intervalo); }

  /** La agenda es autoridad sobre la gestión. Cerrar la espera evita asociar
   * una imagen futura al QR de una reserva que recepción ya gestionó. */
  async reconciliarAgenda(reservaAgenda: number, estado: string, tieneComprobante: boolean, tx: Prisma.TransactionClient): Promise<string[]> {
    if (estado === 'PENDIENTE') {
      const anterior = await tx.reservaChat.findUnique({ where: { reservaAgenda }, select: { id: true, estado: true, conversacionId: true } });
      if (anterior?.estado === 'GESTIONADA') {
        const { count } = await tx.reservaChat.updateMany({ where: { id: anterior.id, estado: 'GESTIONADA' }, data: {
          estado: 'REVISION', detalle: 'La reserva volvió a pendiente en la agenda. Recepción debe revisar el seguimiento anterior.', proximoIntento: null,
        } });
        if (count) return [anterior.conversacionId];
      }
      return [];
    }
    const destino = estado === 'ATENDIDO' ? 'GESTIONADA'
      : estado === 'PAGADO' && tieneComprobante ? 'PAGO_REGISTRADO'
      : estado === 'NO_ENCONTRADA' ? 'REVISION' : null;
    if (!destino) return [];
    const cambiadas: string[] = [];
    const filas = await tx.reservaChat.findMany({ where: { reservaAgenda, estado: { not: destino } },
      select: { id: true, conversacionId: true, estado: true } });
    for (const fila of filas) {
      const { count } = await tx.reservaChat.updateMany({ where: { id: fila.id, estado: fila.estado },
        data: { estado: destino, proximoIntento: null, detalle: estado === 'NO_ENCONTRADA' ? DETALLE.NO_ENCONTRADA : null } });
      if (count) cambiadas.push(fila.conversacionId);
    }
    return cambiadas;
  }

  async procesar(ahora = new Date()): Promise<number> {
    if (this.corriendo || !interaccionesHabilitadas()) return 0;
    this.corriendo = true;
    try {
      const lineas = (await this.prisma.lineaWhatsapp.findMany({ select: { id: true } })).map(l => l.id).filter(interaccionesEnLinea);
      if (!lineas.length) return 0;
      const pendientes = await this.prisma.reservaChat.findMany({
        where: { estado: 'COMPROBANTE_RECIBIDO', comprobanteMensajeId: { not: null },
          conversacion: { lineaId: { in: lineas } },
          OR: [{ proximoIntento: null }, { proximoIntento: { lte: ahora } }] },
        orderBy: { updatedAt: 'asc' }, take: POR_PASADA,
        select: { id: true, conversacionId: true, reservaAgenda: true, intentos: true, comprobanteMensajeId: true,
          comprobanteRecibidoEn: true, updatedAt: true, createdAt: true, monto: true, lecturaComprobante: true,
          conversacion: { select: { lineaId: true, cliente: { select: { telefono: true, waUsuarioId: true } } } } },
      });
      let resueltos = 0;
      for (const p of pendientes) {
        if (!interaccionesEnLinea(p.conversacion.lineaId)) continue;
        const lease = new Date(ahora.getTime() + LEASE_MS);
        const toma = await this.prisma.reservaChat.updateMany({ where: { id: p.id, estado: 'COMPROBANTE_RECIBIDO', updatedAt: p.updatedAt,
          OR: [{ proximoIntento: null }, { proximoIntento: { lte: ahora } }] }, data: { proximoIntento: lease } });
        if (!toma.count) continue;
        if (await this.procesarUno(p, ahora, lease)) resueltos++;
      }
      return resueltos;
    } finally { this.corriendo = false; }
  }

  private async procesarUno(p: Pendiente, ahora: Date, lease: Date): Promise<boolean> {
    try {
      const mensaje = await this.prisma.mensaje.findFirst({ where: { id: p.comprobanteMensajeId!, conversacionId: p.conversacionId, direccion: 'ENTRANTE' }, select: { mediaKey: true, mediaMime: true } });
      if (mensaje?.mediaMime && !mensaje.mediaMime.startsWith('image/')) return this.cerrar(p, lease, 'REVISION', DETALLE.NO_ES_IMAGEN);
      if (!mensaje?.mediaKey) {
        return ahora.getTime() - (p.comprobanteRecibidoEn ?? p.updatedAt).getTime() > ESPERA_MEDIA_MS
          ? this.cerrar(p, lease, 'REVISION', DETALLE.SIN_MEDIA) : false;
      }
      const objeto = await this.r2.leer(mensaje.mediaKey);
      if (!objeto) throw new Error('Media temporalmente no disponible');
      if ((objeto.bytes ?? 0) > BYTES_MAXIMOS_IMAGEN) {
        await objeto.cuerpo.cancel();
        return this.cerrar(p, lease, 'REVISION', DETALLE.NO_ES_IMAGEN);
      }
      const bytes = await leerImagenAcotada(objeto.cuerpo);
      if (!bytes) return this.cerrar(p, lease, 'REVISION', DETALLE.NO_ES_IMAGEN);
      if (!interaccionesEnLinea(p.conversacion.lineaId)) return false;
      if (!(await this.verificado(p, bytes, mensaje.mediaMime ?? 'image/jpeg', ahora, lease))) return false;
      const resultado = await this.agenda.registrarPagoDesdeChat(p.reservaAgenda, bytes);
      if (resultado !== 'REGISTRADO') return this.cerrar(p, lease, 'REVISION', DETALLE[resultado]);
      const registrado = await this.cerrar(p, lease, 'PAGO_REGISTRADO', null);
      /* La constancia, una vez y solo si ESTA pasada lo registró. No lanza. */
      if (registrado) await this.constancia.enviar(p.reservaAgenda, ahora);
      return registrado;
    } catch {
      // No volcar errores externos, URLs firmadas, blobs ni datos personales.
      this.logger.warn('Comprobante de reserva pendiente de conciliación con agenda');
      if (p.intentos + 1 >= MAX_INTENTOS) return this.cerrar(p, lease, 'REVISION', DETALLE.AGENDA);
      await this.prisma.reservaChat.updateMany({ where: { id: p.id, estado: 'COMPROBANTE_RECIBIDO', proximoIntento: lease },
        data: { intentos: { increment: 1 }, proximoIntento: new Date(ahora.getTime() + Math.min(30_000 * 2 ** p.intentos, 900_000)) } });
      return false;
    }
  }

  private async cerrar(p: Pendiente, lease: Date, estado: 'PAGO_REGISTRADO' | 'REVISION', detalle: string | null, lectura?: LecturaComprobante): Promise<boolean> {
    const { count } = await this.prisma.reservaChat.updateMany({ where: { id: p.id, estado: 'COMPROBANTE_RECIBIDO', proximoIntento: lease },
      data: { estado, detalle, proximoIntento: null, ...(lectura ? { lecturaComprobante: lectura as unknown as Prisma.InputJsonValue } : {}) } });
    if (count) this.gateway.emitirActividad(p.conversacionId);
    return count > 0;
  }

  /**
   * ¿Puede seguir a la agenda? `true` si la línea no lee comprobantes (como antes)
   * o si la IA lo leyó y coincide en todo. Si no, deja la reserva donde corresponde
   * —esperando otro, o en revisión— y devuelve `false`. Una lectura que falla se
   * reintenta; a la tercera, revisión: nunca pasa a la agenda sin leerse.
   */
  private async verificado(p: Pendiente, bytes: Buffer, mime: string, ahora: Date, lease: Date): Promise<boolean> {
    const mensajeId = p.comprobanteMensajeId!;
    if (!p.conversacion.lineaId || !(await this.lineas.leeComprobantes(p.conversacion.lineaId))) return true;
    const anterior = lecturaGuardada(p.lecturaComprobante);
    /* Ya leída en una pasada anterior (la agenda no respondió): no se paga otra lectura. */
    if (anterior?.mensajeId === mensajeId) {
      if (anterior.resultado === 'COINCIDE') return true;
      await this.cerrar(p, lease, 'REVISION', detalleDeLectura(anterior));
      return false;
    }
    /* Sin monto no hay con qué comparar (no debería pasar: sin monto no se manda QR). */
    if (p.monto === null) {
      await this.cerrar(p, lease, 'REVISION', DETALLE.SIN_LECTURA);
      return false;
    }
    let lectura: LecturaComprobante;
    try {
      lectura = await this.leer(p, mensajeId, bytes, mime, ahora);
    } catch (error: unknown) {
      this.logger.warn(`Comprobante de la reserva ${p.reservaAgenda} sin leer: ${error instanceof Error ? error.message : 'falló'}`);
      if (p.intentos + 1 >= INTENTOS_LECTURA) {
        if (await this.cerrar(p, lease, 'REVISION', DETALLE.SIN_LECTURA)) await this.avisarRevision(p, mensajeId, null);
        return false;
      }
      await this.prisma.reservaChat.updateMany({ where: { id: p.id, estado: 'COMPROBANTE_RECIBIDO', proximoIntento: lease },
        data: { intentos: { increment: 1 }, proximoIntento: new Date(ahora.getTime() + 60_000 * 2 ** p.intentos) } });
      return false;
    }
    /* Una línea por lectura, sin datos de la paciente: qué reserva y qué salió. */
    this.logger.log(`Comprobante de la reserva ${p.reservaAgenda} leído: ${lectura.resultado}`);
    const decision = decidirComprobanteDeReserva(lectura, anterior);
    if (decision === 'REGISTRAR') {
      /* Queda guardada antes de ir a la agenda: si la agenda falla, el reintento no vuelve a leer. */
      const { count } = await this.prisma.reservaChat.updateMany({ where: { id: p.id, estado: 'COMPROBANTE_RECIBIDO', proximoIntento: lease },
        data: { lecturaComprobante: lectura as unknown as Prisma.InputJsonValue } });
      if (count) this.gateway.emitirActividad(p.conversacionId);
      return count > 0;
    }
    if (decision === 'REVISAR') {
      if (await this.cerrar(p, lease, 'REVISION', detalleDeLectura(lectura), lectura)) await this.avisarRevision(p, mensajeId, lectura);
      return false;
    }
    /* No es un comprobante: la reserva vuelve a esperar el suyo y se le pide. */
    const { count } = await this.prisma.reservaChat.updateMany({ where: { id: p.id, estado: 'COMPROBANTE_RECIBIDO', proximoIntento: lease },
      data: { estado: 'ESPERANDO_COMPROBANTE', comprobanteMensajeId: null, comprobanteRecibidoEn: null, proximoIntento: null, intentos: 0, detalle: null,
        lecturaComprobante: lectura as unknown as Prisma.InputJsonValue } });
    if (count) {
      this.gateway.emitirActividad(p.conversacionId);
      await this.avisar(p, `reserva-no-comprobante:${mensajeId}`, TEXTO_NO_ES_COMPROBANTE);
    }
    return false;
  }

  /** Que no se quede sin respuesta: su comprobante lo ve ahora una persona. */
  private avisarRevision(p: Pendiente, mensajeId: string, lectura: LecturaComprobante | null): Promise<void> {
    const centavos = Math.round((p.monto?.toNumber() ?? 0) * 100);
    return this.avisar(p, `reserva-revision:${mensajeId}`, textoRevisionParaPaciente(lectura, centavos));
  }

  private async leer(p: Pendiente, mensajeId: string, bytes: Buffer, mime: string, ahora: Date): Promise<LecturaComprobante> {
    const { datos } = await this.lector.leer({ bytes: new Uint8Array(bytes), mime });
    const referencia = referenciaComparable(datos.referencia);
    /* Un comprobante reutilizado: la misma operación ya llegó por otra cita o por una promoción. */
    const repetidas = referencia ? await Promise.all([
      this.prisma.reservaChat.count({ where: { id: { not: p.id }, lecturaComprobante: { path: ['referenciaNormalizada'], equals: referencia } } }),
      this.prisma.pagoPromocion.count({ where: { lecturaComprobante: { path: ['referenciaNormalizada'], equals: referencia } } }),
    ]) : [0, 0];
    return {
      version: 1,
      mensajeId,
      leidoEn: ahora.toISOString(),
      modelo: this.lector.nombre,
      datos,
      referenciaNormalizada: referencia,
      ...evaluarComprobanteDeReserva(datos, {
        monto: p.monto!.toNumber(),
        pedidoEn: p.createdAt,
        ahora,
        referenciaRepetida: repetidas[0] + repetidas[1] > 0,
      }),
    };
  }

  /**
   * Una vez por imagen (`clientMessageId` estable por `clave`), como la constancia:
   * sale aunque una persona atienda el chat, porque responde a lo que ella acaba de
   * mandar. No lanza: el estado de la reserva ya quedó, y una persona ve la lectura.
   */
  private async avisar(p: Pendiente, clave: string, texto: string): Promise<void> {
    const clientMessageId = uuidEstable(clave);
    try {
      const mensaje = await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${p.conversacionId}, ${CANDADO_AUTOMATICOS}))::text`;
        const creado = await tx.mensaje.create({ data: { conversacionId: p.conversacionId, direccion: 'SALIENTE', contenido: texto,
          automatico: true, asistente: true, clientMessageId, estadoEnvio: 'ENVIADO' }, select: { id: true } });
        await tx.conversacion.update({ where: { id: p.conversacionId }, data: { updatedAt: new Date() } });
        return creado;
      });
      this.gateway.emitirActividad(p.conversacionId);
      await this.despachador.texto({ mensajeId: mensaje.id, conversacionId: p.conversacionId, telefono: destinoWhatsapp(p.conversacion.cliente) }, texto);
    } catch (error: unknown) {
      if (esChoqueUnicoEn(error, 'Mensaje', 'clientMessageId')) return;
      this.logger.warn(`Aviso del comprobante de la reserva ${p.reservaAgenda} sin enviar: ${error instanceof Error ? error.message : 'falló'}`);
    }
  }
}

/** El Content-Length puede faltar o mentir: acotar los bytes realmente leídos. */
export async function leerImagenAcotada(cuerpo: ReadableStream<Uint8Array>): Promise<Buffer | null> {
  const lector = cuerpo.getReader();
  const partes: Uint8Array[] = [];
  let bytes = 0;
  let vencido = false;
  const timer = setTimeout(() => { vencido = true; void lector.cancel().catch(() => undefined); }, 10_000);
  try {
    while (true) {
      const parte = await lector.read();
      if (parte.done) break;
      bytes += parte.value.byteLength;
      if (bytes > BYTES_MAXIMOS_IMAGEN) return null;
      partes.push(parte.value);
    }
    if (vencido) throw new Error('Media agotó tiempo');
    return bytes ? Buffer.concat(partes) : null;
  } finally { clearTimeout(timer); await lector.cancel().catch(() => undefined); }
}
