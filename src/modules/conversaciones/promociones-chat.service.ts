import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { cubreRol } from '../../common/auth/roles';
import { UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { R2Service } from '../../common/storage/r2.service';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { CobrosService } from '../cobros/cobros.service';
import { textoDelQr } from '../cobros/cobro-reglas';
import { MensajePreparado } from '../../common/whatsapp/interacciones/mensaje-interactivo';
import { LeadsService } from '../leads/leads.service';
import { PromocionChat, PromocionesService } from '../promociones/promociones.service';
import { VentasService } from '../ventas/ventas.service';
import { auditarResolucion, bloquearSolicitudViva, CANDADO_AUTOMATICOS, SIN_ATENCION } from './atencion-humana';
import { ConversacionesGateway } from './conversaciones.gateway';
import { ConversacionesService } from './conversaciones.service';
import { obtenerConversacionPropia } from './envio-comun';
import { PAGO_ABIERTO, PAGO_EN_CURSO, PagoDelChat, ResultadoAccionPago, pagoDelChat, uuidEstable } from './pagos-chat';
import { tarjetaDePromocion, textoOtroComprobante, textoPagoConfirmado } from './promocion-chat';

/** Lo que hay que mandarle a la paciente al empezar el pago: el QR y su pie. */
export interface InicioDePago {
  pagoId: string;
  texto: string;
  imagen: { clave: string; mime: string };
}

/**
 * Qué pasa al tocar «Pagar ahora»: se le manda el QR, su comprobante de ESTA
 * promoción ya está en verificación (no se le pide otra vez), o hoy no se puede
 * cobrar por chat (`null`: lo ve una persona).
 */
export type ResultadoDePagar = InicioDePago | 'EN_VERIFICACION' | null;

/** Un comprobante más grande no se copia a la venta (la venta guarda el respaldo, no un archivo de 100 MB). */
const BYTES_MAXIMOS_COMPROBANTE = 10 * 1024 * 1024;

/**
 * La promoción dentro del chat (docs/pagos-promocion.md): su tarjeta, de qué
 * promoción viene la paciente y el pago. Único dueño de `PagoPromocion`. La venta
 * la crea `VentasService`, el lead lo anota `LeadsService` y la promoción y el QR
 * los leen sus módulos: este servicio no escribe sus tablas.
 *
 * Ciclo: PENDIENTE (se le envió el QR) → COMPROBANTE_ENVIADO (mandó la foto; pasa a
 * «Atención») → CONFIRMADO (una persona lo verificó: nace la venta) o, si hay que
 * pedir otro, vuelve a PENDIENTE. ANULADO cierra sin venta. Nunca «pagado» antes de
 * que una persona lo verifique.
 */
@Injectable()
export class PromocionesChatService {
  private readonly logger = new Logger(PromocionesChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
    private readonly gateway: ConversacionesGateway,
    private readonly conversaciones: ConversacionesService,
    private readonly cobros: CobrosService,
    private readonly promociones: PromocionesService,
    private readonly leads: LeadsService,
    private readonly ventas: VentasService,
  ) {}

  /* ── La promoción ───────────────────────────────────────────────────── */

  /** La de un código `PRM-…`, si está visible hoy. */
  porCodigo(codigo: string): Promise<PromocionChat | null> {
    return this.promociones.paraChatPorCodigo(codigo);
  }

  porId(id: string): Promise<PromocionChat | null> {
    return this.promociones.paraChatPorId(id);
  }

  /** ¿Hay alguna publicada para WhatsApp hoy? Decide si el menú muestra la opción, sin traer la lista. */
  hayParaMenu(): Promise<boolean> {
    return this.promociones.hayParaMenuWhatsapp();
  }

  /** Las publicadas para WhatsApp hoy: la lista de la opción «Promociones» del menú. */
  paraMenu(): Promise<PromocionChat[]> {
    return this.promociones.paraMenuWhatsapp();
  }

  /** La tarjeta para esta línea: con «Pagar ahora» solo si la línea tiene un QR vigente. */
  async tarjeta(lineaId: string, promocion: PromocionChat): Promise<MensajePreparado | null> {
    const linea = await this.prisma.lineaWhatsapp.findUnique({ where: { id: lineaId }, select: { comercial: true } });
    if (!linea?.comercial) return null;
    return tarjetaDePromocion(promocion, { puedePagar: Boolean(await this.cobros.listoPara(lineaId)) });
  }

  /** Escribió con el código: la promoción queda en su lead (si no vino ya por un anuncio). */
  atribuir(clienteId: string, promocionId: string): Promise<boolean> {
    return this.leads.atribuirPromocion(clienteId, promocionId);
  }

  /* ── El pago ────────────────────────────────────────────────────────── */

  /**
   * La paciente tocó «Pagar ahora». Empieza el pago (o retoma el que ya tenía de
   * esa promoción) y devuelve el QR a mandar. `null` si hoy no se puede cobrar por
   * chat: la promoción dejó de estar visible, no tiene precio o la línea no tiene
   * un QR vigente. Elegir otra promoción anula el pago anterior sin comprobante.
   */
  async iniciar(conversacionId: string, lineaId: string, promocionId: string): Promise<ResultadoDePagar> {
    const [promocion, cobro] = await Promise.all([this.promociones.paraChatPorId(promocionId), this.cobros.listoPara(lineaId)]);
    if (!promocion || promocion.precio === null || !cobro) return null;
    const monto = promocion.precio;
    const pago = await this.prisma.$transaction(async tx => {
      /* El mismo candado que los automáticos y la atención humana: dos toques
         simultáneos a «Pagar ahora» no abren dos pagos. */
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${conversacionId}, ${CANDADO_AUTOMATICOS}))::text`;
      // La línea proviene del chat, nunca de un parámetro independiente.
      if (!await tx.conversacion.findFirst({ where: { id: conversacionId, lineaId, linea: { comercial: true } }, select: { id: true } })) return null;
      const abierto = await tx.pagoPromocion.findFirst({
        where: { conversacionId, ...PAGO_EN_CURSO },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, promocionId: true, estado: true, monto: true },
      });
      /* Retoma el suyo con SU monto congelado: si el precio cambió entretanto, lo
         que se le dice es lo que se registrará al confirmar. */
      if (abierto?.estado === 'CONFIRMADO') return abierto;
      if (abierto?.promocionId === promocionId) {
        if (abierto.estado === 'PENDIENTE') {
          // Retomar el QR abre otra ventana para recibir su comprobante.
          await tx.pagoPromocion.updateMany({ where: { id: abierto.id, estado: 'PENDIENTE' }, data: { updatedAt: new Date() } });
        }
        return abierto;
      }
      if (abierto?.estado === 'COMPROBANTE_ENVIADO') return null; // ya pagó otra: lo resuelve una persona
      if (abierto) {
        await tx.pagoPromocion.update({ where: { id: abierto.id }, data: { estado: 'ANULADO', motivoRechazo: 'Eligió otra promoción.', cerradoEn: new Date() } });
      }
      return tx.pagoPromocion.create({ data: { conversacionId, lineaId, promocionId, monto }, select: { id: true, promocionId: true, estado: true, monto: true } });
    });
    if (!pago) return null;
    if (pago.estado === 'COMPROBANTE_ENVIADO' || pago.estado === 'CONFIRMADO') return 'EN_VERIFICACION';
    this.gateway.emitirActividad(conversacionId);
    return {
      pagoId: pago.id,
      texto: textoDelQr({ titulo: promocion.titulo, monto: pago.monto.toNumber(), banco: cobro.banco, titular: cobro.titular, instrucciones: cobro.instrucciones }),
      imagen: cobro.imagen,
    };
  }

  /**
   * Una persona verificó el comprobante. En este orden, para que nunca quede una
   * venta sin pago ni un pago confirmado por dos:
   *
   * 1. Se RECLAMA el pago (compare-and-set a CONFIRMADO, sin venta todavía): desde
   *    aquí nadie más puede pedir otro comprobante ni anularlo.
   * 2. Nace la venta (ligada a la promoción y a su lead, con el comprobante copiado
   *    a la carpeta de ventas). Si falla, el pago vuelve a «por verificar».
   * 3. Se enlaza la venta y el chat sale de «Atención», en una transacción.
   *
   * Si algo corta entre 2 y 3, quien lo reclamó lo reintenta: la venta es
   * idempotente por pago (`clientRequestId`) y el paso 3 se completa. Después, la
   * paciente recibe la confirmación como un mensaje de quien confirmó.
   */
  async confirmar(conversacionId: string, pagoId: string, usuario: UsuarioJwt, soloAgenteId?: string): Promise<ResultadoAccionPago> {
    if (!cubreRol(usuario.rol, 'AGENTE')) throw new ForbiddenException('Confirmar un pago registra una venta: lo hace una agente o un admin.');
    const conversacion = await obtenerConversacionPropia(this.prisma, conversacionId, soloAgenteId);
    const pago = await this.prisma.pagoPromocion.findFirst({
      where: { id: pagoId, conversacionId },
      include: { promocion: { select: { titulo: true, codigo: true } }, cerradoPor: { select: { nombre: true } } },
    });
    if (!pago) throw new NotFoundException('Ese pago no existe en esta conversación.');
    if (pago.estado === 'CONFIRMADO' && pago.ventaId) return pagoDelChat(this.prisma, conversacionId);
    /* Reclamado y sin venta: quedó a medias. Solo quien lo reclamó lo completa
       (la venta idempotente es la suya). */
    const reanudar = pago.estado === 'CONFIRMADO';
    if (reanudar && pago.cerradoPorId !== usuario.sub) {
      throw new ConflictException(`Lo está confirmando ${pago.cerradoPor?.nombre ?? 'otra persona'}.`);
    }
    if (!pago.comprobanteMensajeId || (!reanudar && pago.estado !== 'COMPROBANTE_ENVIADO')) {
      throw new ConflictException('Este pago no tiene un comprobante por verificar.');
    }
    const comprobanteMensajeId = pago.comprobanteMensajeId;

    /* 1. Reclamar. */
    if (!reanudar) {
      const { count } = await this.prisma.pagoPromocion.updateMany({
        where: { id: pago.id, estado: 'COMPROBANTE_ENVIADO', comprobanteMensajeId },
        data: { estado: 'CONFIRMADO', cerradoPorId: usuario.sub, cerradoEn: new Date() },
      });
      if (!count) throw new ConflictException('Otra persona ya resolvió este pago.');
    }

    /* 2. La venta. */
    const monto = pago.monto.toNumber();
    let ventaId: string;
    try {
      const comprobante = await this.copiarComprobante(conversacionId, comprobanteMensajeId, pago.id, usuario.sub);
      const anuncios = await this.promociones.anunciosDe(pago.promocionId);
      const leadId = await this.leads.leadDePromocion(conversacion.clienteId, pago.promocionId, anuncios);
      const venta = await this.ventas.create(
        {
          clienteId: conversacion.clienteId,
          producto: `Promoción: ${pago.promocion.titulo}`.slice(0, 160),
          monto,
          estado: 'GANADA',
          metodoPago: 'QR',
          comprobante: 'WhatsApp',
          comprobanteKey: comprobante.clave,
          comprobanteMime: comprobante.mime,
          comprobanteNombre: comprobante.nombre,
          ...(leadId ? { leadId } : {}),
          notas: `Pago de la promoción ${pago.promocion.codigo} verificado en el chat de WhatsApp.`,
          /* La misma intención otra vez (doble clic, reintento) devuelve esta venta. */
          clientRequestId: `pago-promocion-${pago.id}`,
        },
        usuario.sub,
      );
      ventaId = venta.id;
    } catch (error) {
      /* Sin venta, el pago no queda «confirmado»: vuelve a esperar que alguien lo verifique. */
      await this.prisma.pagoPromocion.updateMany({
        where: { id: pago.id, estado: 'CONFIRMADO', ventaId: null, cerradoPorId: usuario.sub },
        data: { estado: 'COMPROBANTE_ENVIADO', cerradoPorId: null, cerradoEn: null },
      });
      throw error;
    }

    /* 3. Enlazar, sacar de «Atención» y dejar constancia, juntos. */
    await this.prisma.$transaction(async tx => {
      await tx.pagoPromocion.update({ where: { id: pago.id }, data: { ventaId, cerradoEn: new Date() } });
      await this.resolverAtencionDelComprobante(tx, conversacionId, comprobanteMensajeId, usuario.sub);
      await tx.auditLog.create({
        data: { entidad: 'PagoPromocion', entidadId: pago.id, accion: 'PAGO_CONFIRMADO', usuarioId: usuario.sub, cambios: { ventaId, monto, promocionId: pago.promocionId } },
      });
    });
    const avisoPaciente = await this.avisarPaciente(conversacionId, textoPagoConfirmado(pago.promocion.titulo, monto), usuario.sub, soloAgenteId, `pago-confirmado:${pago.id}`);
    this.gateway.emitirActividad(conversacionId);
    const actual = await pagoDelChat(this.prisma, conversacionId);
    return actual ? { ...actual, avisoPaciente } : null;
  }

  /** El comprobante no sirve: vuelve a esperar uno, con el motivo, y se le pide otro. */
  async pedirOtroComprobante(conversacionId: string, pagoId: string, motivo: string, usuario: UsuarioJwt, soloAgenteId?: string): Promise<ResultadoAccionPago> {
    if (!cubreRol(usuario.rol, 'AGENTE')) throw new ForbiddenException('La revisión de pagos corresponde a Ventas o administración.');
    await obtenerConversacionPropia(this.prisma, conversacionId, soloAgenteId);
    const anterior = await this.prisma.$transaction(async tx => {
      const pago = await tx.pagoPromocion.findFirst({ where: { id: pagoId, conversacionId }, select: { comprobanteMensajeId: true, estado: true } });
      if (!pago) throw new NotFoundException('Ese pago no existe en esta conversación.');
      const { count } = await tx.pagoPromocion.updateMany({
        where: { id: pagoId, estado: 'COMPROBANTE_ENVIADO' },
        data: { estado: 'PENDIENTE', comprobanteMensajeId: null, motivoRechazo: motivo },
      });
      if (!count) throw new ConflictException('Este pago no tiene un comprobante por verificar.');
      if (pago.comprobanteMensajeId) await this.resolverAtencionDelComprobante(tx, conversacionId, pago.comprobanteMensajeId, usuario.sub);
      await tx.auditLog.create({ data: { entidad: 'PagoPromocion', entidadId: pagoId, accion: 'COMPROBANTE_RECHAZADO', usuarioId: usuario.sub, cambios: { motivo } } });
      return pago.comprobanteMensajeId;
    });
    const avisoPaciente = await this.avisarPaciente(conversacionId, textoOtroComprobante(motivo), usuario.sub, soloAgenteId, `otro-comprobante:${pagoId}:${anterior ?? ''}`);
    this.gateway.emitirActividad(conversacionId);
    const actual = await pagoDelChat(this.prisma, conversacionId);
    return actual ? { ...actual, avisoPaciente } : null;
  }

  /** Se cierra sin venta (desistió, pagó de otra forma). No le escribe: lo hace la persona si hace falta. */
  async anular(conversacionId: string, pagoId: string, usuario: UsuarioJwt, soloAgenteId?: string): Promise<PagoDelChat | null> {
    if (!cubreRol(usuario.rol, 'AGENTE')) throw new ForbiddenException('La revisión de pagos corresponde a Ventas o administración.');
    await obtenerConversacionPropia(this.prisma, conversacionId, soloAgenteId);
    await this.prisma.$transaction(async tx => {
      const pago = await tx.pagoPromocion.findFirst({ where: { id: pagoId, conversacionId }, select: { comprobanteMensajeId: true } });
      if (!pago) throw new NotFoundException('Ese pago no existe en esta conversación.');
      const { count } = await tx.pagoPromocion.updateMany({
        where: { id: pagoId, estado: { in: [...PAGO_ABIERTO] } },
        data: { estado: 'ANULADO', cerradoPorId: usuario.sub, cerradoEn: new Date() },
      });
      if (!count) throw new ConflictException('Este pago ya estaba cerrado.');
      if (pago.comprobanteMensajeId) await this.resolverAtencionDelComprobante(tx, conversacionId, pago.comprobanteMensajeId, usuario.sub);
      await tx.auditLog.create({ data: { entidad: 'PagoPromocion', entidadId: pagoId, accion: 'PAGO_ANULADO', usuarioId: usuario.sub } });
    });
    this.gateway.emitirActividad(conversacionId);
    return pagoDelChat(this.prisma, conversacionId);
  }

  /**
   * Si la solicitud viva del chat es ESTE comprobante, se resuelve con su
   * constancia (misma transacción). Otra solicitud (pidió una persona, una
   * emergencia) no se toca: no la resolvió verificar un pago.
   */
  private async resolverAtencionDelComprobante(tx: Prisma.TransactionClient, conversacionId: string, comprobanteMensajeId: string, usuarioId: string): Promise<void> {
    const viva = await bloquearSolicitudViva(tx, conversacionId);
    if (!viva || viva.motivo !== 'COMPROBANTE_PAGO') return;
    const actual = await tx.conversacion.findUniqueOrThrow({ where: { id: conversacionId }, select: { atencionMensajeId: true } });
    if (actual.atencionMensajeId !== comprobanteMensajeId) return;
    await tx.conversacion.update({ where: { id: conversacionId }, data: SIN_ATENCION });
    await auditarResolucion(tx, conversacionId, usuarioId, viva, 'RESOLVER', new Date());
  }

  /**
   * Copia el comprobante del chat a la carpeta de ventas de quien confirma (la
   * única que `VentasService` acepta como respaldo propio). La clave es fija por
   * pago: reintentar sobrescribe el mismo archivo.
   */
  private async copiarComprobante(conversacionId: string, mensajeId: string, pagoId: string, usuarioId: string): Promise<{ clave: string; mime: string; nombre: string }> {
    const mensaje = await this.prisma.mensaje.findFirst({ where: { id: mensajeId, conversacionId }, select: { mediaKey: true, mediaMime: true, mediaNombre: true } });
    if (!mensaje?.mediaKey) throw new ConflictException('El comprobante todavía se está descargando. Intenta de nuevo en unos segundos.');
    const objeto = await this.r2.leer(mensaje.mediaKey);
    if (!objeto) throw new ConflictException('No se pudo leer el comprobante del chat.');
    if ((objeto.bytes ?? 0) > BYTES_MAXIMOS_COMPROBANTE) throw new ConflictException('El comprobante pesa más de 10 MB: regístralo a mano en Ventas.');
    const cuerpo = await new Response(objeto.cuerpo).arrayBuffer();
    const mime = mensaje.mediaMime ?? objeto.tipo ?? 'application/octet-stream';
    const extension = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    const clave = `comprobantes/${usuarioId}/pago-${pagoId}.${extension}`;
    await this.r2.subir(clave, cuerpo, mime);
    return { clave, mime, nombre: mensaje.mediaNombre ?? `comprobante-${pagoId}.${extension}` };
  }

  /**
   * Le escribe a la paciente como la persona que actuó (no es un automático:
   * respondió alguien). Si la ventana de 24 h se cerró no puede salir texto libre;
   * el pago ya quedó resuelto igual y la persona le escribe con una plantilla.
   */
  private async avisarPaciente(conversacionId: string, texto: string, usuarioId: string, soloAgenteId: string | undefined, intencion: string): Promise<'ENCOLADO' | 'NO_ENVIADO'> {
    try {
      await this.conversaciones.enviarMensaje(conversacionId, texto, usuarioId, soloAgenteId, undefined, uuidEstable(intencion));
      return 'ENCOLADO';
    } catch (error) {
      this.logger.warn(`El pago se resolvió pero no se pudo avisar a la paciente: ${error instanceof Error ? error.message : String(error)}`);
      return 'NO_ENVIADO';
    }
  }
}
