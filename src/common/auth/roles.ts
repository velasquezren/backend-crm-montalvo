import { Rol } from '../../prisma/prisma-client';

import { UsuarioJwt } from '../decorators/current-user.decorator';

/**
 * Jerarquía de entrada a los módulos y alcance de los datos comerciales.
 * Los permisos operativos por línea se resuelven en acceso-conversacion:
 * recepción atiende todos los chats de sus líneas sin adquirir rango de agente.
 */

/** Cada rol cubre a los de rango menor. */
export const RANGO_ROL: Readonly<Record<Rol, number>> = {
  [Rol.RECEPCION]: 0,
  [Rol.ASISTENTE]: 0,
  [Rol.AGENTE]: 1,
  [Rol.ADMIN]: 2,
  [Rol.SUPER_ADMIN]: 3,
};

/**
 * Roles OPERATIVOS: atienden los chats de sus líneas y no tienen alcance
 * comercial. No agendan sobre leads, no acceden a líneas comerciales y
 * localizan pacientes por conversación accesible, no por cartera.
 *
 * Existe como lista única a propósito. Antes cada módulo escribía
 * `rol === 'RECEPCION'` por su cuenta —seis copias entre actividades, usuarios,
 * líneas y el filtro Prisma de acceso-conversacion—, que es exactamente la
 * forma en que al añadir SUPER_ADMIN una tabla quedó desincronizada. Añadir un
 * rol operativo debe ser tocar esta línea y nada más.
 */
export const ROLES_OPERATIVOS: readonly Rol[] = [Rol.RECEPCION, Rol.ASISTENTE];

/** ¿Este rol atiende líneas sin alcance comercial? */
export function esRolOperativo(rol: Rol): boolean {
  return ROLES_OPERATIVOS.includes(rol);
}

/**
 * Roles que entregan resultados médicos al paciente, además de administración
 * (alcance global). Es una CAPACIDAD, no un rango: `ASISTENTE` está por debajo
 * de un agente de ventas y aun así es quien entrega.
 *
 * Existe porque el permiso anterior era solo la membresía en la línea de
 * resultados, y esa línea —Recepción— la comparten recepcionistas, asistentes
 * y agentes. Medido en producción el 2026-09-22: un AGENTE de ventas con
 * acceso a Recepción podía entregar informes médicos. La membresía sigue
 * haciendo falta; esta lista dice quién, de entre los miembros, entrega.
 * Espejo en el frontend: `core/auth/roles.ts`.
 */
export const ROLES_ENTREGA_RESULTADOS: readonly Rol[] = [Rol.ASISTENTE];

/** ¿Este rol entrega resultados médicos? Administración siempre. */
export function puedeEntregarResultados(rol: Rol): boolean {
  return tieneAlcanceGlobal(rol) || ROLES_ENTREGA_RESULTADOS.includes(rol);
}

/** ¿`rol` alcanza el nivel de `rolMinimo`? */
export function cubreRol(rol: Rol, rolMinimo: Rol): boolean {
  return RANGO_ROL[rol] >= RANGO_ROL[rolMinimo];
}

/**
 * ¿Este rol ve la información de todo el equipo, en vez de solo la suya?
 * De ADMIN para arriba: un super admin puede todo lo que puede un admin.
 */
export function tieneAlcanceGlobal(rol: Rol): boolean {
  return cubreRol(rol, Rol.ADMIN);
}

/**
 * Id del agente al que hay que limitar la consulta, o `undefined` si el usuario
 * ve todo. Es justo lo que esperan los services en su parámetro `soloAgenteId`.
 *
 * ```ts
 * findAll(@Query() query: QueryClienteDto, @CurrentUser() usuario: UsuarioJwt) {
 *   return this.service.findAll(query, alcanceAgente(usuario));
 * }
 * ```
 */
export function alcanceAgente(usuario: UsuarioJwt): string | undefined {
  return tieneAlcanceGlobal(usuario.rol) ? undefined : usuario.sub;
}
