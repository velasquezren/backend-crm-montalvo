import { esRolOperativo, tieneAlcanceGlobal } from '../../common/auth/roles';
import { Prisma, Rol } from '../../prisma/prisma-client';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateUsuarioDto } from './dto/create-usuario.dto';
import { UpdateUsuarioDto } from './dto/update-usuario.dto';

const SIN_PASSWORD = {
  id: true,
  lineasWhatsapp: { select: { lineaId: true } },
  silenciosLinea: { select: { lineaId: true } },
  nombre: true,
  email: true,
  rol: true,
  activo: true,
  foto: true,
  codigo: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Módulo Usuarios/Agentes — ciclo de vida de agentes (crear, editar, desactivar).
 * El passwordHash jamás sale del service.
 */
@Injectable()
export class UsuariosService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateUsuarioDto) {
    const existente = await this.prisma.usuario.findUnique({ where: { email: dto.email } });
    if (existente) {
      throw new ConflictException(`Ya existe un usuario con el email ${dto.email}`);
    }

    const lineaIds = dto.lineaIds ?? [];
    const rol = dto.rol ?? 'AGENTE';
    await this.validarLineas(lineaIds, rol);
    const silencio = silencioValidado(dto.lineasSilenciadas ?? [], await this.lineasVisibles(rol, lineaIds));
    const creado = await this.prisma.usuario.create({
      data: {
        nombre: dto.nombre,
        email: dto.email,
        passwordHash: await bcrypt.hash(dto.password, 10),
        rol: dto.rol,
        lineasWhatsapp: { create: lineaIds.map(lineaId => ({ lineaId })) },
        silenciosLinea: { create: [...silencio].map(lineaId => ({ lineaId })) },
        codigo: await this.normalizarCodigo(dto.codigo),
      },
      select: SIN_PASSWORD,
    });
    return vista(creado);
  }

  async findAll() {
    return (await this.prisma.usuario.findMany({ select: SIN_PASSWORD, orderBy: { nombre: 'asc' } })).map(vista);
  }

  async findOne(id: string) {
    const usuario = await this.prisma.usuario.findUnique({ where: { id }, select: SIN_PASSWORD });
    if (!usuario) {
      throw new NotFoundException(`Usuario ${id} no encontrado`);
    }
    return vista(usuario);
  }

  /** Solo para AuthService — incluye el hash para validar credenciales. */
  async findByEmailConPassword(email: string) {
    return this.prisma.usuario.findUnique({ where: { email } });
  }

  async update(id: string, dto: UpdateUsuarioDto, ejecutorId?: string) {
    const { password, lineaIds, lineasSilenciadas, ...resto } = dto;
    const passwordHash = password ? await bcrypt.hash(password, 10) : undefined;
    return this.prisma.$transaction(async tx => {
      // Una sola orden para todas las mutaciones de acceso; protege también al último superadmin.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(730013)::text`;
      const actual = await tx.usuario.findUnique({ where: { id }, select: SIN_PASSWORD });
      if (!actual) throw new NotFoundException(`Usuario ${id} no encontrado`);
      const lineasActuales = actual.lineasWhatsapp.map(l => l.lineaId);
      const silencioActual = actual.silenciosLinea.map(s => s.lineaId);
      const permisos = lineaIds ?? lineasActuales;
      const rolFinal = dto.rol ?? actual.rol;
      await this.validarLineas(permisos, rolFinal, tx);
      /* Sin `lineasSilenciadas` se conserva el silencio que había, recortado a
         las líneas que seguirá viendo: perder una línea —o dejar de ser admin—
         se lleva su silencio, y si vuelve a verla, vuelve sonando. */
      const visibles = await this.lineasVisibles(rolFinal, permisos, tx);
      const silencio = lineasSilenciadas !== undefined
        ? silencioValidado(lineasSilenciadas, visibles)
        : new Set(silencioActual.filter(id => visibles.includes(id)));
      const cambianLineas = lineaIds !== undefined && !mismoConjunto(lineaIds, lineasActuales);
      /* «Viene» no es «cambia»: la pantalla de Agentes manda siempre el rol, el
         mismo que tenía, y tomarlo como cambio cerraba la sesión de la agente
         cada vez que alguien guardaba su ficha. */
      const cambiaRol = resto.rol !== undefined && resto.rol !== actual.rol;
      const cambiaActivo = resto.activo !== undefined && resto.activo !== actual.activo;
      const cambiaSilencio = !mismoConjunto([...silencio], silencioActual);
      if (ejecutorId === id && cambiaRol) {
        throw new BadRequestException('No puedes cambiarte a ti mismo el rol.');
      }
      if (ejecutorId === id && cambiaActivo && resto.activo === false) {
        throw new BadRequestException('No puedes desactivar tu propia cuenta.');
      }
      if (actual.rol === 'SUPER_ADMIN' && ((cambiaRol && resto.rol !== 'SUPER_ADMIN') || (cambiaActivo && resto.activo === false))) {
        await this.verificarQueQuedaOtroSuperAdmin(id, tx);
      }
      const actualizado = await tx.usuario.update({
        where: { id },
        data: {
          ...resto,
          ...(resto.codigo !== undefined ? { codigo: await this.normalizarCodigo(resto.codigo, id, tx) } : {}),
          ...(passwordHash ? { passwordHash } : {}),
          /* Se revocan las sesiones solo si cambian los permisos de verdad:
             contraseña, rol, estado o el CONJUNTO de líneas. Cambiar cuáles le
             suenan no toca permisos —la audiencia se relee en cada aviso—, y
             reenviar los mismos valores tampoco. */
          ...(password || cambiaRol || cambiaActivo || cambianLineas
            ? { versionSesion: { increment: 1 } } : {}),
          ...(cambianLineas
            ? { lineasWhatsapp: { deleteMany: {}, create: permisos.map(lineaId => ({ lineaId })) } } : {}),
          ...(cambiaSilencio
            ? { silenciosLinea: { deleteMany: {}, create: [...silencio].map(lineaId => ({ lineaId })) } } : {}),
        }, select: SIN_PASSWORD,
      });
      if (cambianLineas || cambiaRol || cambiaActivo) {
        if (!actualizado.activo || !tieneAlcanceGlobal(actualizado.rol)) {
          await tx.conversacion.updateMany({ where: { agenteId: id, ...(actualizado.activo ? { lineaId: { notIn: permisos } } : {}) }, data: { agenteId: null } });
        }
      }
      if (cambianLineas) {
        await tx.auditLog.create({ data: { entidad: 'Usuario', entidadId: id, accion: 'LINEAS_ASIGNADAS', usuarioId: ejecutorId, cambios: { lineaIds } } });
      }
      if (cambiaSilencio) {
        await tx.auditLog.create({ data: { entidad: 'Usuario', entidadId: id, accion: 'AVISOS_LINEAS', usuarioId: ejecutorId, cambios: { lineasSilenciadas: [...silencio] } } });
      }
      return vista(actualizado);
    });
  }

  /**
   * Las líneas que esa persona ve con ese rol: todas si el rol es global, las
   * de su acceso si no. Es sobre lo único que puede silenciar.
   */
  private async lineasVisibles(rol: Rol, acceso: string[], db: Prisma.TransactionClient = this.prisma): Promise<string[]> {
    if (!tieneAlcanceGlobal(rol)) return acceso;
    return (await db.lineaWhatsapp.findMany({ select: { id: true } })).map(l => l.id);
  }

  private async validarLineas(ids: string[], rol: Rol, db: Prisma.TransactionClient = this.prisma): Promise<void> {
    if (!ids.length) return;
    const lineas = await db.lineaWhatsapp.findMany({ where: { id: { in: ids } }, select: { id: true, comercial: true } });
    if (lineas.length !== ids.length) throw new BadRequestException('Alguna línea no existe o está repetida.');
    if (esRolOperativo(rol) && lineas.some(l => l.comercial)) {
      throw new BadRequestException('Este rol solo puede acceder a líneas de atención; la línea comercial corresponde a agentes de ventas.');
    }
  }

  /**
   * El código de empresa es único. El vacío se guarda como `null`, no como '':
   * varias cadenas vacías chocarían contra el índice único, mientras que Postgres
   * permite tantos NULL como haga falta.
   */
  private async normalizarCodigo(codigo: string | undefined, exceptoId?: string, db: Prisma.TransactionClient = this.prisma) {
    const limpio = codigo?.trim();
    if (!limpio) return null;

    const enUso = await db.usuario.findUnique({
      where: { codigo: limpio },
      select: { id: true, nombre: true },
    });
    if (enUso && enUso.id !== exceptoId) {
      throw new ConflictException(
        `El código "${limpio}" ya lo usa ${enUso.nombre}.`,
      );
    }
    return limpio;
  }

  /** Desactivación en vez de borrado — el historial de ventas/comisiones se preserva. */
  async desactivar(id: string, ejecutorId?: string) {
    return this.update(id, { activo: false }, ejecutorId);
  }

  /**
   * Evita el bloqueo total: siempre debe quedar al menos un SUPER_ADMIN activo.
   *
   * Es el rol crítico —sin él nadie puede gestionar agentes ni asignar los
   * códigos de empresa de los que depende la planilla— y además es el único que
   * puede volver a crear otro super admin.
   */
  private async verificarQueQuedaOtroSuperAdmin(excluyendoId: string, db: Prisma.TransactionClient = this.prisma): Promise<void> {
    const otros = await db.usuario.count({
      where: { rol: 'SUPER_ADMIN', activo: true, id: { not: excluyendoId } },
    });
    if (otros === 0) {
      throw new BadRequestException(
        'Es el último super administrador activo: asigna otro antes de desactivarlo o cambiar su rol.',
      );
    }
  }
}

/**
 * El silencio pedido, comprobado contra las líneas que de verdad ve.
 *
 * Silenciar una línea que no ve no significa nada, y la fila quedaría
 * esperando: el día que le dieran esa línea, llegaría ya callada sin que nadie
 * lo hubiera decidido.
 */
function silencioValidado(silenciadas: string[], lineas: string[]): Set<string> {
  const ajenas = silenciadas.filter(id => !lineas.includes(id));
  if (ajenas.length) throw new BadRequestException('Solo se pueden silenciar líneas que la cuenta puede ver.');
  return new Set(silenciadas);
}

type ConSilencios<T> = T & { silenciosLinea: { lineaId: string }[] };

/**
 * La forma pública de un usuario: el silencio como lista (`lineasSilenciadas`)
 * y no como la relación cruda, que es un detalle de almacenamiento.
 */
function vista<T>(usuario: ConSilencios<T>) {
  const { silenciosLinea, ...resto } = usuario;
  return { ...resto, lineasSilenciadas: silenciosLinea.map(s => s.lineaId) };
}

function mismoConjunto(a: readonly string[], b: readonly string[]): boolean {
  const unicos = new Set(a);
  return unicos.size === new Set(b).size && b.every(id => unicos.has(id));
}
