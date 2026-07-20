import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Marca un endpoint como accesible sin JWT (login, webhooks de Meta). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
