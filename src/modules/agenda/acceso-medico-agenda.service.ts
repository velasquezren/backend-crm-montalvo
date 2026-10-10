import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { cubreRol } from '../../common/auth/roles';
import { UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { normalizarTelefono } from '../../common/telefono/telefono';
import { esChoqueUnicoEn } from '../../prisma/choque-unico';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { AgendaMedicosCrmService } from './agenda-medicos-crm.service';

/** El médico que el número autorizado representa. */
export interface MedicoAutorizado {
  readonly agendaMedicoId: number;
  readonly nombre: string;
}

export interface AccesoMedicoVista {
  readonly agendaMedicoId: number;
  readonly telefono: string;
  readonly nombreMedico: string;
  readonly autorizadoPor: string | null;
  readonly autorizadoEn: Date;
}

/** Del teléfono, a la constancia, solo cómo termina: la bitácora no necesita el número entero. */
const terminaEn = (telefono: string) => `…${telefono.slice(-4)}`;

/**
 * Qué número de WhatsApp es de qué médico de la agenda, para que el asistente
 * le conteste SU agenda y la de nadie más. Único dueño de `AccesoMedicoAgenda`.
 *
 * ## Por qué esto basta como autorización
 *
 * El número que llega del webhook lo pone Meta (el `wa_id` de quien escribe), no
 * quien teclea: nadie escribe «soy la doctora X» y se hace pasar por ella. Lo
 * que queda por decidir es a quién pertenece cada número, y eso lo decide una
 * persona con autoridad: un ADMIN (o más). Es una decisión del propietario
 * (10/10/2026): sin código de verificación por WhatsApp. El riesgo conocido de
 * ese diseño es un número reasignado por la operadora; por eso se puede revocar
 * al instante, la lectura se hace en cada mensaje (sin caché) y cada alta y baja
 * deja constancia en `AuditLog`, dentro de la misma transacción.
 *
 * El teléfono se muestra solo a quien lo puede gestionar: es un dato privado.
 */
@Injectable()
export class AccesoMedicoAgendaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly medicos: AgendaMedicosCrmService,
  ) {}

  private exigirAdmin(usuario: UsuarioJwt): void {
    if (!cubreRol(usuario.rol, 'ADMIN')) throw new ForbiddenException('El número de WhatsApp de un médico lo autoriza administración.');
  }

  /**
   * ¿Este número es de un médico autorizado? La única puerta del asistente.
   * Sin caché a propósito: revocar tiene que valer en el siguiente mensaje.
   */
  async porTelefono(telefono: string): Promise<MedicoAutorizado | null> {
    const e164 = normalizarTelefono(telefono);
    if (!e164) return null;
    const fila = await this.prisma.accesoMedicoAgenda.findUnique({ where: { telefono: e164 }, select: { agendaMedicoId: true, nombreMedico: true } });
    return fila ? { agendaMedicoId: fila.agendaMedicoId, nombre: fila.nombreMedico } : null;
  }

  /** Lo autorizado para un médico, o `null`. Solo administración. */
  async deMedico(agendaMedicoId: number, usuario: UsuarioJwt): Promise<AccesoMedicoVista | null> {
    this.exigirAdmin(usuario);
    const fila = await this.prisma.accesoMedicoAgenda.findUnique({ where: { agendaMedicoId } });
    if (!fila) return null;
    const autor = await this.prisma.usuario.findUnique({ where: { id: fila.autorizadoPorId }, select: { nombre: true } });
    return {
      agendaMedicoId: fila.agendaMedicoId, telefono: fila.telefono, nombreMedico: fila.nombreMedico,
      autorizadoPor: autor?.nombre ?? null, autorizadoEn: fila.updatedAt,
    };
  }

  /** Asocia (o cambia) el número del médico. El médico tiene que existir en la agenda. */
  async autorizar(agendaMedicoId: number, telefonoEscrito: string, usuario: UsuarioJwt): Promise<AccesoMedicoVista> {
    this.exigirAdmin(usuario);
    const telefono = normalizarTelefono(telefonoEscrito);
    if (!telefono) throw new BadRequestException('Ese número de teléfono no es válido. Escríbelo con el código de país, por ejemplo +591 70012345.');
    const { medico } = await this.medicos.ficha(agendaMedicoId, usuario);
    if (medico.estado !== 'ACTIVO') throw new BadRequestException('Ese médico no está activo en la agenda.');
    const nombreMedico = [medico.sigla, medico.nombre].filter(Boolean).join(' ').slice(0, 200);
    try {
      await this.prisma.$transaction(async tx => {
        const antes = await tx.accesoMedicoAgenda.findUnique({ where: { agendaMedicoId }, select: { telefono: true } });
        await tx.accesoMedicoAgenda.upsert({
          where: { agendaMedicoId },
          create: { agendaMedicoId, telefono, nombreMedico, autorizadoPorId: usuario.sub },
          update: { telefono, nombreMedico, autorizadoPorId: usuario.sub },
        });
        await tx.auditLog.create({
          data: {
            entidad: 'AccesoMedicoAgenda', entidadId: String(agendaMedicoId), accion: antes ? 'ACCESO_MEDICO_CAMBIADO' : 'ACCESO_MEDICO_AUTORIZADO', usuarioId: usuario.sub,
            cambios: { telefono: terminaEn(telefono), ...(antes ? { anterior: terminaEn(antes.telefono) } : {}) } as Prisma.InputJsonValue,
          },
        });
      });
    } catch (error: unknown) {
      if (esChoqueUnicoEn(error, 'AccesoMedicoAgenda', 'telefono')) {
        const otro = await this.prisma.accesoMedicoAgenda.findUnique({ where: { telefono }, select: { nombreMedico: true } });
        throw new ConflictException(`Ese número ya está autorizado para ${otro?.nombreMedico ?? 'otro médico'}. Quítaselo primero.`);
      }
      throw error;
    }
    const vista = await this.deMedico(agendaMedicoId, usuario);
    if (!vista) throw new NotFoundException('No se pudo leer lo autorizado.');
    return vista;
  }

  /** Quita el acceso. Idempotente: quitar lo que no hay no es un error. */
  async revocar(agendaMedicoId: number, usuario: UsuarioJwt): Promise<{ ok: true }> {
    this.exigirAdmin(usuario);
    await this.prisma.$transaction(async tx => {
      const fila = await tx.accesoMedicoAgenda.findUnique({ where: { agendaMedicoId }, select: { telefono: true } });
      if (!fila) return;
      await tx.accesoMedicoAgenda.delete({ where: { agendaMedicoId } });
      await tx.auditLog.create({
        data: {
          entidad: 'AccesoMedicoAgenda', entidadId: String(agendaMedicoId), accion: 'ACCESO_MEDICO_REVOCADO', usuarioId: usuario.sub,
          cambios: { telefono: terminaEn(fila.telefono) } as Prisma.InputJsonValue,
        },
      });
    });
    return { ok: true };
  }
}
