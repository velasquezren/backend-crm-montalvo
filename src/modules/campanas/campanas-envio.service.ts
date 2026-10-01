import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { ZONA_CLINICA } from '../../common/fechas/zona-clinica';
import { enSegundoPlano } from '../../common/fiabilidad/en-segundo-plano';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '../../prisma/prisma-client';
import { ConversacionesService } from '../conversaciones/conversaciones.service';
import { dentroDeHorario, INTERVALO_ENVIO_MS, LOTE_POR_VUELTA, parametrosPara, VariableCampana } from './campana';

interface FiltroGuardado {
  diasSinCampana: number;
}

/**
 * El barrido que manda las campañas: cada 15 s, como mucho 20 mensajes, solo
 * de 9:00 a 20:00 en La Paz, de más a menos valor.
 *
 * Una paciente se RESERVA antes de mandarle (`PENDIENTE` → `ENVIANDO`, en un
 * UPDATE condicionado) y su clave de envío es la de su fila. Cada vuelta
 * recupera también las reservas interrumpidas. Un bloqueo PostgreSQL por
 * paciente impide robar el trabajo de un proceso vivo, incluso entre campañas.
 * El mensaje existente se enlaza antes de volver a comprobar elegibilidad;
 * nunca se vuelve a despachar un envío cuyo resultado pudiera ser incierto.
 *
 * Justo antes de cada envío se vuelve a mirar lo que pudo cambiar desde que
 * se creó: si pidió la baja o si recibió otra campaña en el plazo. Esas
 * quedan OMITIDAS, con el motivo.
 *
 * Si falla lo que vale para TODAS —la plantilla dejó de estar aprobada, la
 * línea se desconectó—, la campaña se PAUSA con el motivo y la paciente vuelve
 * a pendiente: seguir solo apilaría fallos.
 */
@Injectable()
export class CampanasEnvioService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CampanasEnvioService.name);
  private intervalo?: NodeJS.Timeout;
  /** Una vuelta a la vez: si una tarda más que el intervalo, la siguiente no se le encima. */
  private enCurso = false;
  private destruido = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversaciones: ConversacionesService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.intervalo = setInterval(
      () => void enSegundoPlano('envío de campañas', this.logger, () => this.procesar()),
      INTERVALO_ENVIO_MS,
    );
    this.intervalo.unref();
  }

  onModuleDestroy(): void {
    this.destruido = true;
    clearInterval(this.intervalo);
  }

  /** Una vuelta del barrido. Devuelve envíos confirmados o conciliados con su mensaje. */
  async procesar(ahora = new Date()): Promise<number> {
    if (this.enCurso || this.destruido) return 0;
    this.enCurso = true;
    try {
      await this.prisma.campana.updateMany({
        where: { estado: 'PROGRAMADA', programadaPara: { lte: ahora } },
        data: { estado: 'ENVIANDO' },
      });
      let enviados = 0;
      let procesados = 0;
      const enHorario = dentroDeHorario(ahora);
      const campanas = await this.prisma.campana.findMany({
        where: { OR: [
          ...(enHorario ? [{ estado: 'ENVIANDO' as const }] : []),
          { destinatarios: { some: { estado: 'ENVIANDO' } } },
        ] },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: LOTE_POR_VUELTA,
        select: { id: true },
      });
      for (const campana of campanas) {
        if (procesados >= LOTE_POR_VUELTA || this.destruido) break;
        const lote = await this.enviarLote(campana.id, LOTE_POR_VUELTA - procesados, ahora, enHorario);
        enviados += lote.enviados;
        procesados += lote.procesados;
      }
      await this.terminarLasCompletas(ahora);
      return enviados;
    } finally {
      this.enCurso = false;
    }
  }

  private async enviarLote(
    campanaId: string,
    cupo: number,
    ahora: Date,
    enHorario: boolean,
  ): Promise<{ enviados: number; procesados: number }> {
    const pendientes = await this.prisma.campanaDestinatario.findMany({
      where: { campanaId, OR: [
        { estado: 'ENVIANDO' },
        ...(enHorario ? [{ estado: 'PENDIENTE' as const, campana: { estado: 'ENVIANDO' as const } }] : []),
      ] },
      orderBy: { orden: 'asc' },
      take: cupo,
      select: { id: true, clienteId: true },
    });

    let enviados = 0;
    let procesados = 0;
    for (const destinatario of pendientes) {
      if (this.destruido) break;
      procesados += 1;
      try {
        enviados += await this.procesarDestinatario(destinatario.id, destinatario.clienteId, ahora, enHorario);
      } catch (error) {
        /* Error operativo: conserva la reserva durable. Un fallo de base
           después de Meta NO demuestra que el WhatsApp no haya salido. */
        const codigo = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : 'FALLO_OPERATIVO';
        this.logger.error(`Campaña ${campanaId}, destinatario ${destinatario.id}: ${codigo}; se recuperará en otra vuelta`);
      }
    }
    return { enviados, procesados };
  }

  private procesarDestinatario(id: string, clienteId: string, ahora: Date, enHorario: boolean): Promise<number> {
    /* Una conexión retiene solo el advisory lock, sin bloquear las filas de
       negocio durante Meta (timeout de transporte: 10 s). La reserva se
       confirma aparte para sobrevivir al crash; el resultado se confirma
       usando tx, así un dueño que perdió el lock no puede finalizar. */
    return this.prisma.$transaction(async tx => {
      const [lock] = await tx.$queryRaw<{ adquirido: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${clienteId}, 60101)) AS adquirido`;
      if (!lock.adquirido) return 0;

      const d = await tx.campanaDestinatario.findUnique({
        where: { id }, select: {
          estado: true, campanaId: true,
          cliente: { select: { nombre: true, bajaPromocionesEn: true } },
          campana: { select: { estado: true, lineaId: true, plantilla: true, idioma: true, variables: true, filtro: true } },
        },
      });
      if (!d || (d.estado !== 'PENDIENTE' && d.estado !== 'ENVIANDO')) return 0;
      const clave = claveDeEnvio(id);
      const existente = await tx.mensaje.findUnique({
        where: { clientMessageId: clave }, select: { id: true, createdAt: true },
      });
      if (existente) {
        await tx.campanaDestinatario.update({
          where: { id }, data: { estado: 'ENVIADO', mensajeId: existente.id, enviadoEn: existente.createdAt, motivo: null },
        });
        return 1;
      }
      if (d.campana.estado === 'CANCELADA') {
        await this.marcar(tx, id, 'OMITIDO', 'Campaña cancelada');
        return 0;
      }
      if (d.campana.estado !== 'ENVIANDO' || !enHorario) return 0;

      const reserva = await this.prisma.campanaDestinatario.updateMany({
        where: { id, estado: { in: ['PENDIENTE', 'ENVIANDO'] }, campana: { estado: 'ENVIANDO' } },
        data: { estado: 'ENVIANDO' },
      });
      if (!reserva.count) return 0;
      if (d.cliente.bajaPromocionesEn) {
        await this.marcar(tx, id, 'OMITIDO', 'Pidió no recibir promociones');
        return 0;
      }
      const { diasSinCampana } = d.campana.filtro as unknown as FiltroGuardado;
      const otra = await this.campanaReciente(clienteId, clave, diasSinCampana, ahora);
      if (otra) {
        await this.marcar(tx, id, 'OMITIDO', `Recibió otra campaña el ${otra}`);
        return 0;
      }

      let mensajeId: string;
      try {
        ({ mensajeId } = await this.conversaciones.enviarPlantillaDeCampana({
          clienteId, lineaId: d.campana.lineaId, plantilla: d.campana.plantilla, idioma: d.campana.idioma,
          parametros: parametrosPara(d.campana.variables as unknown as VariableCampana[], d.cliente.nombre),
          clientMessageId: clave,
        }));
      } catch (error) {
        if (error instanceof BadRequestException || error instanceof ServiceUnavailableException || error instanceof NotFoundException) {
          /* Coordinar con cancelar: no devolver una pendiente a una campaña
             ya cancelada, ni sobrescribir su estado con PAUSADA. */
          await tx.$queryRaw`SELECT id FROM "Campana" WHERE id = ${d.campanaId} FOR UPDATE`;
          const vigente = await tx.campana.findUniqueOrThrow({ where: { id: d.campanaId }, select: { estado: true } });
          await tx.campanaDestinatario.update({
            where: { id }, data: vigente.estado === 'CANCELADA'
              ? { estado: 'OMITIDO', motivo: 'Campaña cancelada' }
              : { estado: 'PENDIENTE' },
          });
          await tx.campana.updateMany({
            where: { id: d.campanaId, estado: 'ENVIANDO' },
            data: { estado: 'PAUSADA', motivoPausa: error.message.slice(0, 300) },
          });
          return 0;
        }
        if (error instanceof ConflictException) {
          const baja = await tx.cliente.findUnique({ where: { id: clienteId }, select: { bajaPromocionesEn: true } });
          if (baja?.bajaPromocionesEn) {
            await this.marcar(tx, id, 'OMITIDO', 'Pidió no recibir promociones');
            return 0;
          }
        }
        throw error;
      }
      const mensaje = await tx.mensaje.findUniqueOrThrow({ where: { id: mensajeId }, select: { createdAt: true } });
      await tx.campanaDestinatario.update({
        where: { id }, data: { estado: 'ENVIADO', mensajeId, enviadoEn: mensaje.createdAt, motivo: null },
      });
      return 1;
    }, { timeout: 30_000, maxWait: 5_000 });
  }

  /**
   * La fecha (en texto) de OTRA plantilla de Marketing recibida en el plazo,
   * o null. Sin excluir la suya, una paciente cuyo envío se guardó justo antes
   * de una caída se omitía al reintentar —«recibió otra campaña»: la misma— y
   * su mensaje quedaba fuera de las métricas.
   */
  private async campanaReciente(clienteId: string, claveDeEsta: string, dias: number, ahora: Date): Promise<string | null> {
    if (dias <= 0) return null;
    const ultima = await this.prisma.mensaje.findFirst({
      where: {
        direccion: 'SALIENTE',
        plantillaCategoria: 'MARKETING',
        OR: [{ clientMessageId: null }, { clientMessageId: { not: claveDeEsta } }],
        createdAt: { gte: new Date(ahora.getTime() - dias * 24 * 60 * 60 * 1000) },
        conversacion: { clienteId },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return ultima
      ? ultima.createdAt.toLocaleDateString('es-BO', { timeZone: ZONA_CLINICA, day: 'numeric', month: 'long' })
      : null;
  }

  private marcar(tx: Prisma.TransactionClient, id: string, estado: 'OMITIDO', motivo: string) {
    return tx.campanaDestinatario.update({ where: { id }, data: { estado, motivo: motivo.slice(0, 300) } });
  }

  /** Las que ya no tienen a nadie pendiente ni en vuelo, terminan. */
  private async terminarLasCompletas(ahora: Date): Promise<void> {
    await this.prisma.campana.updateMany({
      where: { estado: 'ENVIANDO', destinatarios: { none: { estado: { in: ['PENDIENTE', 'ENVIANDO'] } } } },
      data: { estado: 'TERMINADA', terminadaEn: ahora },
    });
  }
}

/** La clave de idempotencia de una destinataria: la misma en cada reintento. */
export function claveDeEnvio(destinatarioId: string): string {
  return `camp-${destinatarioId}`;
}
