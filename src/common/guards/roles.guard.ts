import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Rol } from '@prisma/client';

import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * Jerarquía de roles: cada uno cubre a los de rango menor.
 *
 * Así `@Roles('ADMIN')` deja pasar también al SUPER_ADMIN sin tener que
 * enumerarlo endpoint por endpoint —y sin que se olvide en el próximo que se
 * añada—. Para restringir algo SOLO al super admin: `@Roles('SUPER_ADMIN')`.
 */
const RANGO: Record<Rol, number> = {
  AGENTE: 1,
  ADMIN: 2,
  SUPER_ADMIN: 3,
};

/** Guard global de roles — corre después de JwtAuthGuard. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const rolesRequeridos = this.reflector.getAllAndOverride<Rol[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!rolesRequeridos || rolesRequeridos.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();
    const rango = user ? RANGO[user.rol as Rol] : undefined;
    if (rango === undefined) {
      throw new ForbiddenException('No tienes permisos para esta operación');
    }

    // Basta con alcanzar el menos exigente de los roles pedidos.
    const minimoExigido = Math.min(...rolesRequeridos.map(rol => RANGO[rol]));
    if (rango < minimoExigido) {
      throw new ForbiddenException('No tienes permisos para esta operación');
    }
    return true;
  }
}
