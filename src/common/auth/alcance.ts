import { Rol } from '@prisma/client';

import { UsuarioJwt } from '../decorators/current-user.decorator';

/**
 * Alcance de visibilidad de datos, por rol.
 *
 * Antes cada controlador decidía esto a mano con `usuario.rol === 'ADMIN'`,
 * repetido en catorce sitios. Al aparecer SUPER_ADMIN todos esos ifs pasaron a
 * ser falsos para él y el super administrador quedó viendo solo lo suyo, como
 * si fuera un agente. Con un único helper eso no puede volver a pasar: añadir
 * un rol es cambiar esta lista y nada más.
 *
 * Ojo con la diferencia frente a `RolesGuard`: el guard decide **si se puede
 * entrar** a un endpoint; esto decide **cuántos datos se ven** una vez dentro.
 */

/** Roles que ven todo el CRM sin escoparse a un agente concreto. */
const ROLES_CON_ALCANCE_GLOBAL: readonly Rol[] = [Rol.ADMIN, Rol.SUPER_ADMIN];

/** ¿Este rol ve la información de todo el equipo? */
export function tieneAlcanceGlobal(rol: Rol): boolean {
  return ROLES_CON_ALCANCE_GLOBAL.includes(rol);
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
