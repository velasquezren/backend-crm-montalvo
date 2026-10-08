import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import { CacheMemoria } from '../../common/cache/cache-memoria';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { formularioDeCita, interaccionesEnLinea } from '../conversaciones/interacciones-integracion';
import { GuardarMenuDto } from './dto/guardar-menu.dto';
import { erroresDelMenu, leerMenu, MenuAtencion, normalizarMenu } from './menu-atencion';

/** El menú tal como lo edita la pantalla de Líneas. */
export interface MenuEditable {
  lineaId: string;
  linea: { nombre: string; comercial: boolean };
  /** `null`: la línea todavía no tiene menú. */
  menu: MenuAtencion | null;
  /** Lo que impediría enviarlo hoy (vacío si es válido). */
  errores: string[];
  actualizadoEn: Date | null;
  actualizadoPor: { id: string; nombre: string } | null;
  /**
   * ¿Esta línea tiene las interacciones encendidas en el servidor
   * (`interaccionesEnLinea`)? Apagada, su menú no sale aunque esté activo: la
   * pantalla lo dice para que nadie crea que ya funciona.
   */
  enviosHabilitados: boolean;
  /**
   * Qué abre la opción «Cita» EN ESTA LÍNEA: el formulario de reserva (si su WABA
   * lo tiene publicado), el de solicitud, o ninguno (solo pasa a «Atención»).
   */
  formularioCita: 'RESERVA' | 'SOLICITUD' | null;
}

/**
 * Único dueño de la tabla `MenuAtencion`. La ingesta lo lee con `activoDe`; nadie
 * más la escribe (PANORAMA, «Quién escribe cada tabla»).
 */
@Injectable()
export class MenuAtencionService {
  private readonly logger = new Logger(MenuAtencionService.name);
  /**
   * El menú activo por línea: la ingesta lo pide en CADA mensaje entrante. Se
   * invalida al guardar; el TTL cubre un cambio hecho por otra vía.
   */
  private readonly activos = new CacheMemoria<MenuAtencion | null>({ ttlMs: 60_000, maxEntradas: 20 });

  constructor(private readonly prisma: PrismaService) {}

  async editable(lineaId: string): Promise<MenuEditable> {
    const linea = await this.prisma.lineaWhatsapp.findUnique({
      where: { id: lineaId },
      select: {
        nombre: true,
        comercial: true,
        wabaId: true,
        menuAtencion: { include: { actualizadoPor: { select: { id: true, nombre: true } } } },
      },
    });
    if (!linea) throw new NotFoundException('Línea no encontrada');
    const fila = linea.menuAtencion;
    const menu = fila ? leerMenu(fila) : null;
    return {
      lineaId,
      linea: { nombre: linea.nombre, comercial: linea.comercial },
      /* Uno guardado que ya no valida se devuelve igual, con sus errores, para
         que quien lo edite vea qué corregir en vez de un menú en blanco. */
      menu: menu ?? (fila ? comoMenu(fila) : null),
      errores: fila ? [...(!menu ? erroresDelMenu(comoMenu(fila)) : []), ...erroresPorLinea(comoMenu(fila), linea.comercial)] : [],
      actualizadoEn: fila?.actualizadoEn ?? null,
      actualizadoPor: fila?.actualizadoPor ?? null,
      enviosHabilitados: interaccionesEnLinea(lineaId),
      formularioCita: formularioDeCita(linea.wabaId),
    };
  }

  async guardar(lineaId: string, dto: GuardarMenuDto, usuarioId: string): Promise<MenuEditable> {
    const existe = await this.prisma.lineaWhatsapp.findUnique({ where: { id: lineaId }, select: { id: true, comercial: true } });
    if (!existe) throw new NotFoundException('Línea no encontrada');

    const menu = normalizarMenu({
      activo: dto.activo,
      saludo: dto.saludo.trim(),
      opciones: dto.opciones.map(o => ({
        tipo: o.tipo,
        titulo: o.titulo.trim(),
        ...(o.descripcion?.trim() ? { descripcion: o.descripcion.trim() } : {}),
        ...(o.respuesta?.trim() ? { respuesta: o.respuesta.trim() } : {}),
        /* Una respuesta informativa necesita identidad estable: es lo que vuelve
           en el toque de la paciente. Se conserva la que traía; si es nueva, se crea. */
        ...(o.tipo === 'RESPUESTA' ? { clave: o.clave ?? claveNueva() } : {}),
      })),
    });
    const errores = [...erroresDelMenu(menu), ...erroresPorLinea(menu, existe.comercial)];
    if (errores.length) throw new BadRequestException(errores);

    const datos = {
      activo: menu.activo,
      saludo: menu.saludo,
      opciones: menu.opciones as unknown as Prisma.InputJsonArray,
      actualizadoPorId: usuarioId,
    };
    /* Guardar y dejar constancia van juntos: un cambio en lo que reciben las
       pacientes sin registro de quién lo hizo no se acepta. */
    await this.prisma.$transaction([
      this.prisma.menuAtencion.upsert({ where: { lineaId }, create: { lineaId, ...datos }, update: datos }),
      this.prisma.auditLog.create({
        data: {
          entidad: 'MenuAtencion',
          entidadId: lineaId,
          accion: 'MENU_ACTUALIZADO',
          usuarioId,
          cambios: JSON.parse(JSON.stringify(menu)) as Prisma.InputJsonObject,
        },
      }),
    ]);
    this.activos.invalidar(lineaId);
    return this.editable(lineaId);
  }

  /**
   * El menú que se le envía a quien escribe a esta línea, o `null` si está
   * apagado, no existe o dejó de ser válido. Ante la duda, no se envía nada.
   */
  activoDe(lineaId: string): Promise<MenuAtencion | null> {
    return this.activos.resolver(lineaId, async () => {
      const fila = await this.prisma.menuAtencion.findUnique({ where: { lineaId }, include: { linea: { select: { comercial: true } } } });
      if (!fila?.activo) return null;
      const menu = leerMenu(fila);
      if (!menu || erroresPorLinea(menu, fila.linea.comercial).length) {
        this.logger.warn(`El menú de la línea ${lineaId} no es válido: no se envía.`);
        return null;
      }
      return menu;
    });
  }
}

function erroresPorLinea(menu: MenuAtencion, comercial: boolean): string[] {
  return !comercial && menu.opciones.some(o => o.tipo === 'PROMOCIONES')
    ? ['Las promociones pertenecen a Ventas. Quita esa opción del menú de Atención.'] : [];
}

function claveNueva(): string {
  return randomBytes(4).toString('hex');
}

/** Lo guardado, sin validar, para mostrarlo con sus errores. */
function comoMenu(fila: { activo: boolean; saludo: string; opciones: Prisma.JsonValue }): MenuAtencion {
  return {
    activo: fila.activo,
    saludo: fila.saludo,
    opciones: Array.isArray(fila.opciones) ? (fila.opciones as unknown as MenuAtencion['opciones']) : [],
  };
}
