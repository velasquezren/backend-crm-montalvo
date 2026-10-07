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

/**
 * ¿Este rol ve TODAS las reservas de la agenda de la clínica (pantalla
 * Reservas)? Quien gestiona las citas: recepción, asistente y administración.
 * Una agente de ventas ve las de una paciente solo desde su chat, si puede ver
 * ese chat. Es una CAPACIDAD, no un rango: recepción está por debajo de una
 * agente y aun así es quien confirma las citas. Espejo: `core/auth/roles.ts`.
 */
export function puedeVerAgendaClinica(rol: Rol): boolean {
  return tieneAlcanceGlobal(rol) || esRolOperativo(rol);
}

/**
 * Roles que administran los médicos y horarios de la agenda de la clínica
 * (Directorio médico), además de administración. Decisión del propietario
 * (7/10/2026): administración y recepción. Asistencia ve la agenda pero no la
 * edita. Es una CAPACIDAD, no un rango. Espejo: `core/auth/roles.ts`.
 */
export const ROLES_ADMINISTRAN_AGENDA: readonly Rol[] = [Rol.RECEPCION];

/** ¿Este rol edita médicos, horarios y especialidades de la agenda? Administración siempre. */
export function puedeEditarAgendaClinica(rol: Rol): boolean {
  return tieneAlcanceGlobal(rol) || ROLES_ADMINISTRAN_AGENDA.includes(rol);
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
 * Los roles de alcance global, como LISTA, para las consultas: un `where` de
 * Prisma no puede llamar a `tieneAlcanceGlobal`.
 *
 * Se deriva del rango y no se escribe a mano: `['ADMIN', 'SUPER_ADMIN']`
 * estaba copiado en tres consultas (audiencia de un chat, avisos a admins,
 * reasignación), y es la misma forma en que ROLES_OPERATIVOS nació —seis
 * copias que se desincronizaron al añadir un rol—. Un rol nuevo con rango de
 * admin entra aquí solo.
 */
export const ROLES_ALCANCE_GLOBAL: readonly Rol[] = (Object.keys(RANGO_ROL) as Rol[]).filter(tieneAlcanceGlobal);

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
