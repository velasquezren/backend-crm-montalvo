import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';

import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { auditarResolucion, bloquearSolicitudViva, estadoDeAtencion, EstadoAtencion } from './atencion-humana';
import { ConversacionesGateway } from './conversaciones.gateway';
import { obtenerConversacionPropia } from './envio-comun';

/** Lo que devuelve cada transición: el estado autoritativo tras aplicarla. */
export interface EstadoDeAtencion {
  id: string;
  estado: EstadoAtencion | null;
  tomadaEn: Date | null;
  tomadaPor: { id: string; nombre: string } | null;
  automatizacionPausadaEn: Date | null;
}

/**
 * Las transiciones de la atención humana: tomar, liberar, resolver y reanudar
 * la automatización. La solicitud NACE en la ingesta (`registrarSolicitudAtencion`),
 * dentro de la transacción del mensaje de la paciente; aquí solo se gestiona.
 *
 * Cada transición es un UPDATE condicionado al estado que supone, no un «leer y
 * luego escribir»: de dos personas tomando a la vez, exactamente una afecta la
 * fila. Van por `$executeRaw` para no mover `updatedAt` —tomar un chat no lo
 * sube en la bandeja—, como cerrar y reabrir.
 *
 * El permiso es el de ver la conversación (`obtenerConversacionPropia`): línea
 * autorizada y, en comercial, la cartera de la agente. 404 si no la ve.
 */
@Injectable()
export class AtencionHumanaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: ConversacionesGateway,
    private readonly audit: AuditService,
  ) {}

  /**
   * «Tomar atención». Idempotente para quien ya la tiene; 409 si la tiene otra
   * persona o ya no está pendiente.
   *
   * En recepción no toca `agenteId`: la atención es compartida y la línea la
   * siguen viendo todas. En una línea comercial reclama el chat del pool con la
   * misma regla que contestar —solo si nadie lo tiene—; nunca se lo quita a otra
   * agente.
   */
  async tomar(id: string, usuarioId: string, soloAgenteId?: string): Promise<EstadoDeAtencion> {
    const conversacion = await obtenerConversacionPropia(this.prisma, id, soloAgenteId);
    /* Un chat del pool, al reclamarlo, sale de la vista de las demás agentes de la
       línea: hay que avisarles también a ellas, o conservan la fila ajena. */
    const reclama = conversacion.linea.comercial && !conversacion.agenteId;
    const verianAntes = reclama ? await this.gateway.quienesVen(id) : [];
    const ahora = new Date();
    const tomadas = await this.prisma.$executeRaw`
      UPDATE "Conversacion" SET "atencionTomadaEn" = ${ahora}, "atencionTomadaPorId" = ${usuarioId}
      WHERE id = ${id} AND "atencionSolicitadaEn" IS NOT NULL AND "atencionTomadaEn" IS NULL`;

    if (!tomadas) {
      const actual = await this.estado(id);
      if (actual.estado === 'EN_ATENCION' && actual.tomadaPor?.id === usuarioId) return actual;
      throw new ConflictException(
        actual.estado === 'EN_ATENCION'
          ? `Ya la está atendiendo ${actual.tomadaPor?.nombre ?? 'otra persona'}.`
          : 'Esta solicitud ya no está pendiente: la resolvieron o se cerró el chat.',
      );
    }

    if (conversacion.linea.comercial && !conversacion.agenteId) {
      await this.prisma.$executeRaw`
        UPDATE "Conversacion" SET "agenteId" = ${usuarioId} WHERE id = ${id} AND "agenteId" IS NULL`;
    }
    await this.audit.registrar('Conversacion', id, 'ATENCION_TOMADA', usuarioId);
    this.gateway.emitirActividad(id, verianAntes);
    return this.estado(id);
  }

  /**
   * Devolverla a la espera, para que la tome otra persona. Solo quien la tomó,
   * o alguien con alcance global (quien reparte el trabajo). El reloj de espera
   * sigue siendo el original: liberar no la hace parecer recién llegada.
   */
  async liberar(id: string, usuarioId: string, alcanceGlobal: boolean, soloAgenteId?: string): Promise<EstadoDeAtencion> {
    await obtenerConversacionPropia(this.prisma, id, soloAgenteId);
    const liberadas = alcanceGlobal
      ? await this.prisma.$executeRaw`
          UPDATE "Conversacion" SET "atencionTomadaEn" = NULL, "atencionTomadaPorId" = NULL
          WHERE id = ${id} AND "atencionTomadaEn" IS NOT NULL`
      : await this.prisma.$executeRaw`
          UPDATE "Conversacion" SET "atencionTomadaEn" = NULL, "atencionTomadaPorId" = NULL
          WHERE id = ${id} AND "atencionTomadaEn" IS NOT NULL AND "atencionTomadaPorId" = ${usuarioId}`;

    if (!liberadas) {
      const actual = await this.estado(id);
      if (actual.estado === 'EN_ATENCION') throw new ForbiddenException('Solo quien la atiende puede liberarla.');
      throw new ConflictException('Esta solicitud no está en atención.');
    }
    await this.audit.registrar('Conversacion', id, 'ATENCION_LIBERADA', usuarioId);
    this.gateway.emitirActividad(id);
    return this.estado(id);
  }

  /**
   * Intervención completada: sale de «Atención». La conversación sigue abierta
   * (cerrarla es otra decisión) y la automatización sigue pausada.
   */
  async resolver(id: string, usuarioId: string, soloAgenteId?: string): Promise<EstadoDeAtencion> {
    await obtenerConversacionPropia(this.prisma, id, soloAgenteId);
    const resuelta = await this.prisma.$transaction(async tx => {
      const viva = await bloquearSolicitudViva(tx, id);
      if (!viva) return false;
      await tx.$executeRaw`
        UPDATE "Conversacion" SET "atencionSolicitadaEn" = NULL, "atencionMotivo" = NULL, "atencionMensajeId" = NULL,
          "atencionTomadaEn" = NULL, "atencionTomadaPorId" = NULL
        WHERE id = ${id}`;
      await auditarResolucion(tx, id, usuarioId, viva, 'RESOLVER', new Date());
      return true;
    });
    if (!resuelta) throw new ConflictException('Esta solicitud ya estaba resuelta.');
    this.gateway.emitirActividad(id);
    return this.estado(id);
  }

  /**
   * La única puerta para que la automatización vuelva a escribir en este chat.
   * Explícita, auditada y nunca con una solicitud viva: mientras alguien espera
   * a una persona, no le contesta una máquina.
   */
  async reanudarAutomatizacion(id: string, usuarioId: string, soloAgenteId?: string): Promise<EstadoDeAtencion> {
    await obtenerConversacionPropia(this.prisma, id, soloAgenteId);
    const reanudadas = await this.prisma.$executeRaw`
      UPDATE "Conversacion" SET "automatizacionPausadaEn" = NULL
      WHERE id = ${id} AND "automatizacionPausadaEn" IS NOT NULL AND "atencionSolicitadaEn" IS NULL`;
    if (!reanudadas) {
      const actual = await this.estado(id);
      throw new ConflictException(
        actual.estado ? 'Primero resuelve la solicitud de atención.' : 'La automatización no estaba pausada.',
      );
    }
    await this.audit.registrar('Conversacion', id, 'AUTOMATIZACION_REANUDADA', usuarioId);
    this.gateway.emitirActividad(id);
    return this.estado(id);
  }

  private async estado(id: string): Promise<EstadoDeAtencion> {
    const c = await this.prisma.conversacion.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        atencionSolicitadaEn: true,
        atencionTomadaEn: true,
        atencionTomadaPor: { select: { id: true, nombre: true } },
        automatizacionPausadaEn: true,
      },
    });
    return {
      id: c.id,
      estado: estadoDeAtencion(c),
      tomadaEn: c.atencionTomadaEn,
      tomadaPor: c.atencionTomadaPor,
      automatizacionPausadaEn: c.automatizacionPausadaEn,
    };
  }
}
