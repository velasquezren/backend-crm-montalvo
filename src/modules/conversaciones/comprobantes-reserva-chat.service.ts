import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { enSegundoPlano } from '../../common/fiabilidad/en-segundo-plano';
import { BYTES_MAXIMOS_IMAGEN } from '../../common/storage/imagen-publica';
import { R2Service } from '../../common/storage/r2.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '../../prisma/prisma-client';
import { AgendaReservasService } from '../agenda/agenda-reservas.service';
import { ConversacionesGateway } from './conversaciones.gateway';
import { interaccionesEnLinea, interaccionesHabilitadas } from './interacciones-integracion';

const INTERVALO_MS = 30_000;
const ESPERA_MEDIA_MS = 6 * 60 * 60 * 1000;
const MAX_INTENTOS = 20;
const POR_PASADA = 10;
const LEASE_MS = 120_000;
const DETALLE = {
  NO_ES_IMAGEN: 'El comprobante debe ser una imagen JPG, PNG o WebP de hasta 5 MB. Revisa el archivo en el chat.',
  NO_ENCONTRADA: 'La reserva ya no existe en la agenda.',
  YA_NO_PENDIENTE: 'Revisa la agenda: la reserva ya tenía comprobante o recepción la gestionó. No se sobrescribió.',
  SIN_MEDIA: 'La imagen no se pudo descargar de WhatsApp.',
  AGENDA: 'No se pudo completar el registro automático. Revisa el comprobante en la agenda antes de cargarlo a mano.',
} as const;

type Pendiente = { id: string; reservaAgenda: number; intentos: number; comprobanteMensajeId: string | null;
  comprobanteRecibidoEn: Date | null; updatedAt: Date; conversacionId: string; conversacion: { lineaId: string | null } };

/** Cola durable de comprobantes; nunca confirma pagos. MySQL sigue siendo la
 * fuente. CAS con lease recuperable tras reinicio, solo líneas habilitadas. */
@Injectable()
export class ComprobantesReservaChatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ComprobantesReservaChatService.name);
  private intervalo?: NodeJS.Timeout;
  private corriendo = false;
  constructor(private readonly prisma: PrismaService, private readonly r2: R2Service,
    private readonly agenda: AgendaReservasService, private readonly gateway: ConversacionesGateway) {}

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
          comprobanteRecibidoEn: true, updatedAt: true, conversacion: { select: { lineaId: true } } },
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
      const resultado = await this.agenda.registrarPagoDesdeChat(p.reservaAgenda, bytes);
      return resultado === 'REGISTRADO' ? this.cerrar(p, lease, 'PAGO_REGISTRADO', null) : this.cerrar(p, lease, 'REVISION', DETALLE[resultado]);
    } catch {
      // No volcar errores externos, URLs firmadas, blobs ni datos personales.
      this.logger.warn('Comprobante de reserva pendiente de conciliación con agenda');
      if (p.intentos + 1 >= MAX_INTENTOS) return this.cerrar(p, lease, 'REVISION', DETALLE.AGENDA);
      await this.prisma.reservaChat.updateMany({ where: { id: p.id, estado: 'COMPROBANTE_RECIBIDO', proximoIntento: lease },
        data: { intentos: { increment: 1 }, proximoIntento: new Date(ahora.getTime() + Math.min(30_000 * 2 ** p.intentos, 900_000)) } });
      return false;
    }
  }

  private async cerrar(p: Pendiente, lease: Date, estado: 'PAGO_REGISTRADO' | 'REVISION', detalle: string | null): Promise<boolean> {
    const { count } = await this.prisma.reservaChat.updateMany({ where: { id: p.id, estado: 'COMPROBANTE_RECIBIDO', proximoIntento: lease }, data: { estado, detalle, proximoIntento: null } });
    if (count) this.gateway.emitirActividad(p.conversacionId);
    return count > 0;
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
