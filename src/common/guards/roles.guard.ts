import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Rol } from '../../prisma/prisma-client';

import { cubreRol } from '../auth/roles';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * Guard global de roles — corre después de JwtAuthGuard.
 *
 * Aplica la jerarquía de `common/auth/roles.ts`: `@Roles('ADMIN')` deja pasar
 * también al SUPER_ADMIN sin enumerarlo endpoint por endpoint. Para restringir
 * algo SOLO al super admin: `@Roles('SUPER_ADMIN')`.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) return true;
    const rolesRequeridos = this.reflector.getAllAndOverride<Rol[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? [Rol.AGENTE];

    const { user } = context.switchToHttp().getRequest();
    const rol = user?.rol as Rol | undefined;

    // Basta con alcanzar el menos exigente de los roles pedidos.
    if (!rol || !rolesRequeridos.some(requerido => cubreRol(rol, requerido))) {
      throw new ForbiddenException('No tienes permisos para esta operación');
    }
    return true;
  }
}
