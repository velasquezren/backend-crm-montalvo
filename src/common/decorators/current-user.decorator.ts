import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Rol } from '@prisma/client';

export interface UsuarioJwt {
  sub: string;
  email: string;
  nombre: string;
  rol: Rol;
}

/** Inyecta el usuario autenticado (payload del JWT) en el handler. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): UsuarioJwt => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
