import { Rol } from '../../prisma/prisma-client';

import { UsuarioJwt } from '../decorators/current-user.decorator';

/**
 * Fuente única de la jerarquía de roles del CRM.
 *
 * Todo lo que dependa del rol —quién entra a un endpoint (`RolesGuard`) y
 * cuántos datos ve una vez dentro (`alcanceAgente`)— sale de aquí. Antes esto
 * vivía repartido: el guard tenía su tabla de rangos y el escopado su propia
 * lista de roles, y al añadir SUPER_ADMIN una quedó desactualizada respecto de
 * la otra. Con un solo lugar, añadir un rol es tocar `RANGO_ROL` y nada más.
 */

/** Cada rol cubre a los de rango menor. */
export const RANGO_ROL: Readonly<Record<Rol, number>> = {
  [Rol.AGENTE]: 1,
  [Rol.ADMIN]: 2,
  [Rol.SUPER_ADMIN]: 3,
};

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
