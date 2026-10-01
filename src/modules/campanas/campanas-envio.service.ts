import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';

import { ZONA_CLINICA } from '../../common/fechas/zona-clinica';
import { enSegundoPlano } from '../../common/fiabilidad/en-segundo-plano';
import { PrismaService } from '../../prisma/prisma.service';
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
 * UPDATE condicionado) y su clave de envío es la de su fila: si el proceso se
 * cae a mitad, al arrancar vuelven a `PENDIENTE` y el reintento devuelve el
 * mismo mensaje en vez de mandar —y cobrar— otro. Hay un solo backend; si
 * algún día hubiera varios, la reserva ya impide que dos manden a la misma.
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversaciones: ConversacionesService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    /* Lo que quedó reservado por un proceso que se cayó vuelve a la fila. */
    const { count } = await this.prisma.campanaDestinatario.updateMany({
      where: { estado: 'ENVIANDO' },
      data: { estado: 'PENDIENTE' },
    });
    if (count) this.logger.warn(`${count} envíos de campaña quedaron a medias y vuelven a la fila`);
    this.intervalo = setInterval(
      () => void enSegundoPlano('envío de campañas', this.logger, () => this.procesar()),
      INTERVALO_ENVIO_MS,
    );
    this.intervalo.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.intervalo);
  }

  /** Una vuelta del barrido. Devuelve cuántos mensajes salieron. */
  async procesar(ahora = new Date()): Promise<number> {
    if (this.enCurso) return 0;
    this.enCurso = true;
    try {
      await this.prisma.campana.updateMany({
        where: { estado: 'PROGRAMADA', programadaPara: { lte: ahora } },
        data: { estado: 'ENVIANDO' },
      });
      let enviados = 0;
      if (dentroDeHorario(ahora)) {
        const campanas = await this.prisma.campana.findMany({
          where: { estado: 'ENVIANDO' },
          orderBy: { createdAt: 'asc' },
          select: { id: true, lineaId: true, plantilla: true, idioma: true, variables: true, filtro: true },
        });
        for (const campana of campanas) {
          if (enviados >= LOTE_POR_VUELTA) break;
          enviados += await this.enviarLote(campana, LOTE_POR_VUELTA - enviados, ahora);
        }
      }
      await this.terminarLasCompletas(ahora);
      return enviados;
    } finally {
      this.enCurso = false;
    }
  }

  private async enviarLote(
    campana: { id: string; lineaId: string; plantilla: string; idioma: string; variables: unknown; filtro: unknown },
    cupo: number,
    ahora: Date,
  ): Promise<number> {
    const variables = campana.variables as VariableCampana[];
    const { diasSinCampana } = campana.filtro as FiltroGuardado;
    const pendientes = await this.prisma.campanaDestinatario.findMany({
      where: { campanaId: campana.id, estado: 'PENDIENTE' },
      orderBy: { orden: 'asc' },
      take: cupo,
      select: { id: true, cliente: { select: { id: true, nombre: true, bajaPromocionesEn: true } } },
    });

    let enviados = 0;
    for (const destinatario of pendientes) {
      /* Pausada o cancelada a mitad del lote: se deja de mandar ya. */
      const vigente = await this.prisma.campana.count({ where: { id: campana.id, estado: 'ENVIANDO' } });
      if (!vigente) break;
      const reservada = await this.prisma.campanaDestinatario.updateMany({
        where: { id: destinatario.id, estado: 'PENDIENTE' },
        data: { estado: 'ENVIANDO' },
      });
      if (!reservada.count) continue;

      /* Se mira aquí y no se deduce de un 409: Conversaciones lo vuelve a
         comprobar al enviar, pero un 409 puede tener otros motivos. */
      if (destinatario.cliente.bajaPromocionesEn) {
        await this.marcar(destinatario.id, 'OMITIDO', 'Pidió no recibir promociones');
        continue;
      }
      const clave = claveDeEnvio(destinatario.id);
      const otraCampana = await this.campanaReciente(destinatario.cliente.id, clave, diasSinCampana, ahora);
      if (otraCampana) {
        await this.marcar(destinatario.id, 'OMITIDO', `Recibió otra campaña el ${otraCampana}`);
        continue;
      }

      try {
        const { mensajeId } = await this.conversaciones.enviarPlantillaDeCampana({
          clienteId: destinatario.cliente.id,
          lineaId: campana.lineaId,
          plantilla: campana.plantilla,
          idioma: campana.idioma,
          parametros: parametrosPara(variables, destinatario.cliente.nombre),
          clientMessageId: clave,
        });
        await this.prisma.campanaDestinatario.update({
          where: { id: destinatario.id },
          data: { estado: 'ENVIADO', mensajeId, enviadoEn: new Date() },
        });
        enviados += 1;
      } catch (error) {
        if (error instanceof BadRequestException || error instanceof ServiceUnavailableException) {
          /* Vale para todas: se pausa con el motivo y ella vuelve a la fila. */
          await this.prisma.campanaDestinatario.update({ where: { id: destinatario.id }, data: { estado: 'PENDIENTE' } });
          await this.prisma.campana.updateMany({
            where: { id: campana.id, estado: 'ENVIANDO' },
            data: { estado: 'PAUSADA', motivoPausa: error.message.slice(0, 300) },
          });
          this.logger.warn(`Campaña ${campana.id} pausada: ${error.message}`);
          break;
        } else {
          const motivo = error instanceof Error ? error.message : 'Error desconocido';
          await this.marcar(destinatario.id, 'FALLIDO', motivo);
          this.logger.error(`Campaña ${campana.id}: no se pudo enviar a ${destinatario.cliente.id}`, error);
        }
      }
    }
    return enviados;
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

  private marcar(id: string, estado: 'OMITIDO' | 'FALLIDO', motivo: string) {
    return this.prisma.campanaDestinatario.update({ where: { id }, data: { estado, motivo: motivo.slice(0, 300) } });
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
