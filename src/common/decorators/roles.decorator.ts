import { SetMetadata } from '@nestjs/common';
import { Rol } from '@prisma/client';

export const ROLES_KEY = 'roles';

/** Restringe un endpoint a los roles indicados (ej. @Roles('ADMIN')). */
export const Roles = (...roles: Rol[]) => SetMetadata(ROLES_KEY, roles);
