import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

import { R2Service } from '../../common/storage/r2.service';
import { esChoqueUnicoEn } from '../../prisma/choque-unico';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { AgendaConsultaClient } from '../agenda/agenda-consulta.client';
import { FilaReservaAgenda, reservasPorIds } from '../agenda/agenda-consulta.sql';
import { AsistenteLineasService } from '../asistente/asistente-lineas.service';
import { ImagenHorarioService } from '../asistente/imagen-horario.service';
import { CANDADO_AUTOMATICOS } from './atencion-humana';
import { DatosConstancia, svgDeConstancia, textoConstancia, VERSION_DISENO_CONSTANCIA } from './constancia-reserva';
import { ConversacionesGateway } from './conversaciones.gateway';
import { DespachadorSalienteService } from './despachador-saliente.service';
import { uuidEstable } from './pagos-chat';

/** Fuera de la ventana de 24 h de Meta un mensaje libre no sale: ni se intenta. */
const VENTANA_MS = 23 * 3_600_000;

/** Estados de `para_agendar` en los que el comprobante ya está cargado. */
const ESTADOS_CON_COMPROBANTE = ['PAGADO', 'ATENDIDO'];

export function datosDeConstancia(fila: FilaReservaAgenda, monto: Prisma.Decimal | null): DatosConstancia {
  const montoBs = monto === null ? null : Number(monto.toString());
  return {
    reserva: fila.id,
    fecha: fila.fecha,
    hora: fila.hora.slice(0, 5),
    paciente: fila.paciente.trim() || 'Sin nombre registrado',
    medico: fila.medico.trim() || 'Médico de la clínica',
    especialidad: fila.especialidad,
    montoBs: montoBs !== null && Number.isFinite(montoBs) && montoBs > 0 ? montoBs : null,
  };
}

/**
 * La constancia que recibe la paciente cuando el comprobante de su reserva por
 * WhatsApp queda registrado en la agenda (`ComprobantesReservaChatService`). El
 * dibujo y el texto están en `constancia-reserva.ts`.
 *
 * - **Una por reserva**: `clientMessageId` estable (`reserva-constancia:<n.º>`),
 *   con su índice único como garantía; un reintento del trabajador no la repite.
 * - **Lee la reserva de la agenda**, con la cuenta de consulta: lo que dice la
 *   imagen es lo que hay en `para_agendar`, no lo que se recuerda del Flow.
 * - **Nunca lanza**: el pago ya quedó registrado y el acuse ya salió; la
 *   constancia es lo que se suma. Si algo falla, no sale y queda en el log.
 * - Sale aunque una persona esté atendiendo el chat, como el acuse del
 *   comprobante: es la constancia de lo que ella acaba de hacer.
 * - **Solo en las líneas con el asistente encendido** (sugerir o responder,
 *   `AsistenteLineasService.encendidoEn`): se prueba en la línea de prueba
 *   antes de llegar a Ventas o Recepción. `CONSTANCIA_RESERVA=todas` la manda
 *   en todas las líneas; `CONSTANCIA_RESERVA=off` la apaga. Las dos, sin desplegar.
 *
 * Lleva el nombre de la paciente: la imagen va a `reservas/constancias/` en R2,
 * privada como cualquier adjunto del chat (el despachador firma la URL al enviar).
 */
@Injectable()
export class ConstanciaReservaService {
  private readonly logger = new Logger(ConstanciaReservaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly agenda: AgendaConsultaClient,
    private readonly motor: ImagenHorarioService,
    private readonly r2: R2Service,
    private readonly despachador: DespachadorSalienteService,
    private readonly gateway: ConversacionesGateway,
    private readonly asistente: AsistenteLineasService,
  ) {}

  private ajuste(): string {
    return (this.config.get<string>('CONSTANCIA_RESERVA') ?? '').trim().toLowerCase();
  }

  private encendida(): boolean {
    return this.ajuste() !== 'off';
  }

  /** En qué líneas sale: todas, o solo donde la clínica encendió el asistente. */
  private async saleEn(lineaId: string): Promise<boolean> {
    return this.ajuste() === 'todas' || this.asistente.encendidoEn(lineaId);
  }

  /** Manda la constancia de la reserva, si corresponde. Devuelve si salió. */
  async enviar(reservaAgenda: number, ahora = new Date()): Promise<boolean> {
    if (!this.encendida()) return false;
    try {
      const seguimiento = await this.prisma.reservaChat.findUnique({
        where: { reservaAgenda },
        select: { conversacionId: true, estado: true, monto: true, comprobanteRecibidoEn: true, conversacion: { select: { lineaId: true, cliente: { select: { telefono: true } } } } },
      });
      if (!seguimiento || seguimiento.estado !== 'PAGO_REGISTRADO') return false;
      const recibido = seguimiento.comprobanteRecibidoEn?.getTime() ?? 0;
      if (ahora.getTime() - recibido > VENTANA_MS) return false;
      if (!(await this.saleEn(seguimiento.conversacion.lineaId))) return false;
      const clientMessageId = uuidEstable(`reserva-constancia:${reservaAgenda}`);
      if (await this.prisma.mensaje.findUnique({ where: { clientMessageId }, select: { id: true } })) return false;
      if (!this.agenda.habilitada()) return false;

      const [fila] = await this.agenda.ejecutar(db => reservasPorIds(db, [reservaAgenda]));
      if (!fila || !ESTADOS_CON_COMPROBANTE.includes(fila.estado)) return false;
      const datos = datosDeConstancia(fila, seguimiento.monto);
      const texto = textoConstancia(datos);
      const imagen = await this.imagen(datos);

      const { conversacionId } = seguimiento;
      const mensaje = await this.guardar(conversacionId, clientMessageId, texto, imagen);
      if (!mensaje) return false;
      await this.despachador.texto({ mensajeId: mensaje.id, conversacionId, telefono: seguimiento.conversacion.cliente.telefono }, texto, imagen ?? undefined);
      return true;
    } catch (error: unknown) {
      /* Sin volcar datos de la paciente: solo qué reserva y qué pasó. */
      this.logger.warn(`Constancia de la reserva ${reservaAgenda} sin enviar: ${error instanceof Error ? error.message : 'falló'}`);
      return false;
    }
  }

  /** La imagen en R2, o `null` (sin R2 o si el motor falla): entonces sale el texto solo. */
  private async imagen(d: DatosConstancia): Promise<{ key: string; mime: string; nombre: string } | null> {
    if (!this.r2.habilitado) return null;
    try {
      const svg = svgDeConstancia(d);
      const huella = createHash('sha256').update(`${VERSION_DISENO_CONSTANCIA}:${svg}`).digest('hex').slice(0, 24);
      const key = `reservas/constancias/${d.reserva}-${huella}.png`;
      if (!(await this.r2.leer(key))) {
        const png = await this.motor.dibujar(svg);
        await this.r2.subir(key, png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer, 'image/png');
      }
      return { key, mime: 'image/png', nombre: 'Constancia de reserva.png' };
    } catch (error: unknown) {
      this.logger.warn(`Imagen de la constancia ${d.reserva}: ${error instanceof Error ? error.message : 'falló'}`);
      return null;
    }
  }

  /**
   * El mensaje, bajo el candado de los automáticos como todo lo que no escribe
   * una persona. Nace ENVIADO, como los demás automáticos: el despachador lo
   * corrige con lo que diga Meta y, si falla, lo reintenta su barrido.
   */
  private async guardar(conversacionId: string, clientMessageId: string, texto: string, imagen: { key: string; mime: string; nombre: string } | null) {
    try {
      const mensaje = await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${conversacionId}, ${CANDADO_AUTOMATICOS}))::text`;
        const creado = await tx.mensaje.create({
          data: {
            conversacionId, direccion: 'SALIENTE', contenido: texto, automatico: true, clientMessageId, estadoEnvio: 'ENVIADO',
            ...(imagen ? { tipo: 'IMAGEN', mediaKey: imagen.key, mediaMime: imagen.mime, mediaNombre: imagen.nombre } : {}),
          },
          select: { id: true },
        });
        /* Sube en la bandeja; `esperandoRespuesta` no se toca: un automático ni
           responde a la paciente ni deshace la respuesta de una agente. */
        await tx.conversacion.update({ where: { id: conversacionId }, data: { updatedAt: new Date() } });
        return creado;
      });
      this.gateway.emitirActividad(conversacionId);
      return mensaje;
    } catch (error: unknown) {
      /* Dos pasadas a la vez: la otra ya la guardó. */
      if (esChoqueUnicoEn(error, 'Mensaje', 'clientMessageId')) return null;
      throw error;
    }
  }
}
