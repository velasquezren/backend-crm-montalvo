import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { enSegundoPlano } from '../../common/fiabilidad/en-segundo-plano';
import { R2Service } from '../../common/storage/r2.service';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { AsistenteLineasService } from '../asistente/asistente-lineas.service';
import { evaluarComprobante, LecturaComprobante, referenciaComparable } from '../asistente/comprobante';
import { LectorComprobantes } from '../asistente/modelo.port';
import { ConversacionesGateway } from './conversaciones.gateway';
import { PromocionesChatService } from './promociones-chat.service';

/** Lo que Gemini lee como imagen o documento. Otro formato no se intenta. */
const FORMATOS = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
/** Un comprobante es una captura o un PDF de una página: más que esto no es eso. */
const BYTES_MAXIMOS = 10 * 1024 * 1024;
const INTERVALO_MS = 30_000;
const TOPE_BARRIDO = 5;
export const INTENTOS_LECTURA = 3;
/** Un comprobante que nadie verificó en una semana ya no necesita lectura. */
const ANTIGUEDAD_MAXIMA_MS = 7 * 86_400_000;

/**
 * Lee los comprobantes de pago que llegan al chat, para quien los verifica
 * (docs/asistente-ia.md). Un barrido y no una llamada en la ingesta: el
 * comprobante se descarga en segundo plano (`MediaEntranteService`) y la
 * lectura tiene que esperar a que esté en R2; además así sobrevive a un
 * reinicio. Lo que guarda lo escribe `PromocionesChatService`, dueño de
 * `PagoPromocion`.
 *
 * Nunca confirma nada: deja escrito qué dice el comprobante y qué no cuadra.
 */
@Injectable()
export class LecturaComprobantesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LecturaComprobantesService.name);
  private intervalo?: NodeJS.Timeout;
  private enCurso = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
    private readonly gateway: ConversacionesGateway,
    private readonly lineas: AsistenteLineasService,
    private readonly lector: LectorComprobantes,
    private readonly pagos: PromocionesChatService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.intervalo = setInterval(() => void enSegundoPlano('lectura de comprobantes', this.logger, () => this.barrer()), INTERVALO_MS);
    this.intervalo.unref();
  }

  onModuleDestroy(): void {
    if (this.intervalo) clearInterval(this.intervalo);
  }

  /** Público para las pruebas. Devuelve cuántos leyó. */
  async barrer(ahora = new Date()): Promise<number> {
    if (this.enCurso || !this.lineas.estadoProveedor().listo) return 0;
    this.enCurso = true;
    try {
      const pendientes = await this.prisma.pagoPromocion.findMany({
        where: {
          estado: 'COMPROBANTE_ENVIADO', comprobanteMensajeId: { not: null },
          lecturaComprobante: { equals: Prisma.DbNull }, lecturaIntentos: { lt: INTENTOS_LECTURA },
          updatedAt: { gte: new Date(ahora.getTime() - ANTIGUEDAD_MAXIMA_MS) },
        },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: TOPE_BARRIDO,
        select: { id: true, conversacionId: true, lineaId: true, monto: true, createdAt: true, comprobanteMensajeId: true },
      });
      if (pendientes.length === TOPE_BARRIDO) this.logger.warn(`Lectura de comprobantes: lote de ${TOPE_BARRIDO} completo; queda trabajo para el siguiente barrido`);
      let leidos = 0;
      /* Uno a la vez: comparte la máquina y el pool con las agentes. */
      for (const pago of pendientes) {
        if (await this.leerUno(pago, ahora)) leidos++;
      }
      return leidos;
    } finally {
      this.enCurso = false;
    }
  }

  private async leerUno(
    pago: { id: string; conversacionId: string; lineaId: string; monto: Prisma.Decimal; createdAt: Date; comprobanteMensajeId: string | null },
    ahora: Date,
  ): Promise<boolean> {
    const mensajeId = pago.comprobanteMensajeId;
    if (!mensajeId) return false;
    try {
      if (!(await this.lineas.leeComprobantes(pago.lineaId))) return false;
      const mensaje = await this.prisma.mensaje.findFirst({ where: { id: mensajeId, conversacionId: pago.conversacionId }, select: { mediaKey: true, mediaMime: true } });
      /* Todavía se está descargando: el barrido siguiente lo encuentra listo. */
      if (!mensaje?.mediaKey) return false;
      const mime = mensaje.mediaMime ?? '';
      if (!FORMATOS.has(mime)) {
        /* No se va a poder leer nunca: se gastan los intentos para no volver a mirarlo. */
        for (let i = 0; i < INTENTOS_LECTURA; i++) await this.pagos.reclamarLectura(pago.id, mensajeId, INTENTOS_LECTURA);
        return false;
      }
      if (!(await this.pagos.reclamarLectura(pago.id, mensajeId, INTENTOS_LECTURA))) return false;
      const objeto = await this.r2.leer(mensaje.mediaKey);
      if (!objeto) throw new Error('El comprobante no está en R2.');
      if ((objeto.bytes ?? 0) > BYTES_MAXIMOS) throw new Error('El comprobante pesa más de 10 MB.');
      const bytes = new Uint8Array(await new Response(objeto.cuerpo).arrayBuffer());

      const { datos } = await this.lector.leer({ bytes, mime });
      const referencia = referenciaComparable(datos.referencia);
      const [cobro, repetida] = await Promise.all([
        this.prisma.cobroLinea.findUnique({ where: { lineaId: pago.lineaId }, select: { titular: true } }),
        referencia
          ? this.prisma.pagoPromocion.count({ where: { id: { not: pago.id }, lecturaComprobante: { path: ['referenciaNormalizada'], equals: referencia } } })
          : Promise.resolve(0),
      ]);
      const lectura: LecturaComprobante = {
        version: 1,
        mensajeId,
        leidoEn: ahora.toISOString(),
        modelo: this.lector.nombre,
        datos,
        referenciaNormalizada: referencia,
        ...evaluarComprobante(datos, {
          monto: pago.monto.toNumber(),
          titular: cobro?.titular ?? null,
          pedidoEn: pago.createdAt,
          ahora,
          referenciaRepetida: repetida > 0,
        }),
      };
      if (!(await this.pagos.guardarLectura(pago.id, mensajeId, lectura))) return false;
      this.gateway.emitirActividad(pago.conversacionId);
      return true;
    } catch (error: unknown) {
      /* El intento ya quedó gastado; a los tres se deja de intentar. */
      this.logger.warn(`Comprobante del pago ${pago.id} sin leer: ${error instanceof Error ? error.message : 'falló'}`);
      return false;
    }
  }
}
