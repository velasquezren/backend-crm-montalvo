import { dimensionesImagen } from '../../common/storage/dimensiones-imagen';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { TipoMensaje } from '../../prisma/prisma-client';
import { ErrorMedia, sanitizarErrorMedia } from '../../common/fiabilidad/error-media';
import { enSegundoPlano } from '../../common/fiabilidad/en-segundo-plano';
import { R2Service } from '../../common/storage/r2.service';
import { WhatsappCloudService } from '../../common/whatsapp/whatsapp-cloud.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LineasWhatsappService } from '../lineas-whatsapp/lineas-whatsapp.service';
import { ConversacionesGateway } from './conversaciones.gateway';
import { MAX_INTENTOS_MEDIA, PLAZO_MEDIA_MS, resultadoFalloMedia, TIEMPO_MEDIA_MS } from './politica-media-entrante';

export interface MediaEntrante {
  tipo: TipoMensaje;
  mediaId: string;
  mime: string;
  nombre?: string;
}

export const MAX_BYTES_MEDIA = 25 * 1024 * 1024;
const TOPE_BARRIDO = 10;
const CONCURRENCIA = 2;
const INTERVALO_MS = 60_000;

/**
 * F06-R1. PostgreSQL conserva el trabajo aunque este proceso no llegue a arrancar
 * la descarga. El mensaje y el trabajo nacen en la misma transacción de ingesta.
 *
 * El advisory lock de transacción permanece durante TODO el intento; un segundo
 * worker no puede apropiarse de un trabajo por el mero vencimiento de una fecha.
 * La conexión del lock dura como máximo 90 s; la red se cancela a los 60 s.
 * PROCESANDO/intentos se confirman en transacciones cortas independientes;
 * el resultado final y mediaKey se confirman con el lock todavía tomado.
 * PROCESANDO es observable y sobrevive a un crash. Al morir la conexión se libera
 * el lock y otro barrido puede retomar ese estado. No se mantiene un lock de fila
 * de Mensaje mientras se espera a la red.
 */
@Injectable()
export class MediaEntranteService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MediaEntranteService.name);
  private intervalo?: NodeJS.Timeout;
  private enCurso = false;
  private detenido = false;
  private readonly cancelaciones = new Set<AbortController>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: ConversacionesGateway,
    private readonly r2: R2Service,
    private readonly whatsapp: WhatsappCloudService,
    private readonly lineas: LineasWhatsappService,
  ) {}

  protected ahora(): Date { return new Date(); }

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.intervalo = setInterval(() => this.despertar(), INTERVALO_MS);
    this.intervalo.unref();
    this.despertar();
  }

  onModuleDestroy(): void {
    this.detenido = true;
    if (this.intervalo) clearInterval(this.intervalo);
    for (const cancelacion of this.cancelaciones) cancelacion.abort();
  }

  /** El despertar acelera el caso normal; el timer y la base garantizan recuperación. */
  despertar(): void {
    if (this.detenido || process.env.NODE_ENV === 'test') return;
    void enSegundoPlano('barrido de media entrante', this.logger, () => this.barrerPendientes());
  }

  async resumen() {
    const grupos = await this.prisma.trabajoMediaEntrante.groupBy({ by: ['estado'], _count: true });
    return Object.fromEntries(grupos.map(g => [g.estado, g._count]));
  }

  async barrerPendientes(): Promise<number> {
    // Acota ráfagas de despertares y timers locales. La exclusión real está en PG.
    if (this.detenido || this.enCurso) return 0;
    this.enCurso = true;
    try {
      const pendientes = await this.prisma.trabajoMediaEntrante.findMany({
        where: { proximoIntento: { lte: this.ahora() } },
        select: { mensajeId: true },
        orderBy: [{ proximoIntento: 'asc' }, { mensajeId: 'asc' }],
        take: TOPE_BARRIDO,
      });
      if (pendientes.length === TOPE_BARRIDO) {
        this.logger.warn('Media entrante: lote de 10 completo; puede quedar trabajo para el siguiente barrido');
      }
      let reclamados = 0;
      for (let i = 0; i < pendientes.length && !this.detenido; i += CONCURRENCIA) {
        const resultados = await Promise.all(
          pendientes.slice(i, i + CONCURRENCIA).map(p => this.procesarUno(p.mensajeId)),
        );
        reclamados += resultados.filter(Boolean).length;
      }
      if (pendientes.length) this.logger.log(`Media entrante: reclamados=${reclamados} estados=${JSON.stringify(await this.resumen())}`);
      return reclamados;
    } finally {
      this.enCurso = false;
    }
  }

  /** Pública para probar dos reclamaciones simultáneas contra PostgreSQL real. */
  async procesarUno(mensajeId: string): Promise<boolean> {
    if (this.detenido) return false;
    let refrescar: string | undefined;
    let aviso: string | undefined;
    try {
      const resultado = await this.prisma.$transaction(async bloqueo => {
        const [lock] = await bloqueo.$queryRaw<Array<{ obtenido: boolean }>>`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${mensajeId}, 60061)) AS obtenido
        `;
        if (!lock?.obtenido) return false;

        const trabajo = await this.prisma.trabajoMediaEntrante.findUnique({
          where: { mensajeId },
          include: { mensaje: { select: { conversacionId: true, mediaMime: true, mediaKey: true } } },
        });
        const ahora = this.ahora();
        if (!trabajo?.proximoIntento || trabajo.proximoIntento > ahora) return false;
        if (trabajo.mensaje.mediaKey) {
          await bloqueo.trabajoMediaEntrante.update({
            where: { mensajeId }, data: { estado: 'COMPLETADO', proximoIntento: null, ultimoError: null },
          });
          return true;
        }
        if (ahora.getTime() >= trabajo.createdAt.getTime() + PLAZO_MEDIA_MS || trabajo.intentos >= MAX_INTENTOS_MEDIA) {
          await bloqueo.trabajoMediaEntrante.update({
            where: { mensajeId },
            data: resultadoFalloMedia(new ErrorMedia('INTENTO_INTERRUMPIDO'), trabajo.intentos, trabajo.createdAt, ahora),
          });
          return true;
        }

        await this.prisma.trabajoMediaEntrante.update({
          where: { mensajeId },
          data: { estado: 'PROCESANDO', reclamadoEn: ahora, proximoIntento: new Date(ahora.getTime() + INTERVALO_MS) },
        });
        const cancelacion = new AbortController();
        this.cancelaciones.add(cancelacion);
        const signal = AbortSignal.any([cancelacion.signal, AbortSignal.timeout(TIEMPO_MEDIA_MS)]);
        let intentos = trabajo.intentos;
        try {
          if (!this.r2.habilitado) throw new ErrorMedia('R2_SIN_CONFIGURAR', 'CONFIGURACION');
          const cuenta = await this.lineas.cuentaDeConversacion(trabajo.mensaje.conversacionId);
          if (!cuenta) throw new ErrorMedia('META_SIN_CONFIGURAR', 'CONFIGURACION');
          signal.throwIfAborted();
          // La configuración ausente no consume intentos. Un intento interrumpido sí.
          await this.prisma.trabajoMediaEntrante.update({
            where: { mensajeId }, data: { intentos: { increment: 1 } },
          });
          intentos++;
          const url = await this.whatsapp.urlDeMedia(trabajo.mediaId, cuenta, signal);
          const archivo = await this.whatsapp.descargarMedia(url, cuenta, signal);
          const bytes = await this.leerAcotado(archivo, signal);
          const key = `wa/${trabajo.mensaje.conversacionId}/${mensajeId}`;
          // No empezar otro efecto si la conexión que mantenía el lock se perdió.
          await bloqueo.$queryRaw`SELECT 1`;
          signal.throwIfAborted();
          await this.r2.subirMediaEntrante(key, bytes, trabajo.mensaje.mediaMime ?? 'application/octet-stream', signal);
          await bloqueo.$queryRaw`SELECT 1`;
          // Ambas escrituras se confirman al terminar la transacción DEL LOCK.
          // Si el lock se pierde o vence, PostgreSQL no puede confirmar un dueño viejo.
          /* Las medidas de la foto viajan con la clave: el chat reserva su
             caja antes de descargarla y el hilo no salta al cargar. */
          const dimensiones = dimensionesImagen(bytes, trabajo.mensaje.mediaMime);
          await bloqueo.mensaje.update({
            where: { id: mensajeId },
            data: { mediaKey: key, mediaAncho: dimensiones?.ancho ?? null, mediaAlto: dimensiones?.alto ?? null },
          });
          await bloqueo.trabajoMediaEntrante.update({
            where: { mensajeId }, data: { estado: 'COMPLETADO', proximoIntento: null, ultimoError: null },
          });
          refrescar = trabajo.mensaje.conversacionId;
        } catch (error) {
          await bloqueo.$queryRaw`SELECT 1`; // no sobrescribir al sucesor si perdimos el lock
          const fallo = sanitizarErrorMedia(error);
          // Un 401/403 también es configuración: no gastar el presupuesto por credenciales.
          if (fallo.categoria === 'CONFIGURACION') intentos = trabajo.intentos;
          const resultado = resultadoFalloMedia(fallo, intentos, trabajo.createdAt, this.ahora());
          await bloqueo.trabajoMediaEntrante.update({
            where: { mensajeId }, data: { ...resultado, intentos },
          });
          aviso = `Media ${mensajeId}: ${resultado.estado} intento=${intentos} error=${resultado.ultimoError} proximo=${resultado.proximoIntento?.toISOString() ?? '-'}`;
        } finally {
          this.cancelaciones.delete(cancelacion);
        }
        return true;
      }, { timeout: 90_000, maxWait: 5_000 });
      if (aviso) this.logger.warn(aviso);
      if (refrescar) {
        this.logger.log(`Media ${mensajeId}: COMPLETADO`);
        // Después del commit. Un fallo de WebSocket no reabre una tarea completada.
        try { this.gateway.emitirActividad(refrescar); }
        catch { this.logger.warn(`Media ${mensajeId}: refresco WebSocket no disponible`); }
      }
      return resultado;
    } catch {
      // PG puede estar caído; queda PROCESANDO/PENDIENTE en base para otro barrido.
      this.logger.error(`Media ${mensajeId}: fallo de persistencia/reclamacion; se conserva el trabajo`);
      return false;
    }
  }

  /** Limita también streams sin content-length; cancela antes de acumular >25 MB. */
  private async leerAcotado(archivo: Response, signal: AbortSignal): Promise<ArrayBuffer> {
    if (Number(archivo.headers.get('content-length')) > MAX_BYTES_MEDIA) {
      await archivo.body?.cancel();
      throw new ErrorMedia('TAMANO_EXCEDIDO', 'PERMANENTE');
    }
    if (!archivo.body) throw new ErrorMedia('CUERPO_MEDIA_VACIO');
    const lector = archivo.body.getReader();
    const partes: Uint8Array[] = [];
    let total = 0;
    const cancelar = () => { void lector.cancel().catch(() => undefined); };
    signal.addEventListener('abort', cancelar, { once: true });
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await lector.read();
        signal.throwIfAborted();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES_MEDIA) {
          await lector.cancel();
          throw new ErrorMedia('TAMANO_EXCEDIDO', 'PERMANENTE');
        }
        partes.push(value);
      }
      const bytes = new Uint8Array(total);
      let posicion = 0;
      for (const parte of partes) { bytes.set(parte, posicion); posicion += parte.byteLength; }
      return bytes.buffer;
    } finally {
      signal.removeEventListener('abort', cancelar);
      lector.releaseLock();
    }
  }
}
