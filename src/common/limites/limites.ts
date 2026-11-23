import { SkipThrottle, Throttle } from '@nestjs/throttler';

/**
 * Límite de peticiones (RNF-01): un único throttler global con nombre propio.
 *
 * Los decoradores de `@nestjs/throttler` se aplican POR NOMBRE de throttler.
 * `@SkipThrottle()` sin argumentos y `@Throttle({ default: … })` apuntan a uno
 * llamado `default`, que aquí no existe: no fallan, simplemente no hacen nada.
 * Así estuvieron los webhooks de Meta (limitados a 120/min cuando debían ir
 * sin límite) y los endpoints de FileMaker (120/min en vez de 30 y 60).
 *
 * Por eso nadie importa esos decoradores directamente: se usan `SinLimite` y
 * `Limite`, y `limites.spec.ts` rechaza cualquier uso directo.
 */
export const LIMITE_GENERAL = 'general';

export const LIMITES_GLOBALES = [{ name: LIMITE_GENERAL, ttl: 60_000, limit: 120 }];

/** Exime del límite global (webhooks de Meta, health). Va siempre con una defensa propia. */
export const SinLimite = (): MethodDecorator & ClassDecorator =>
  SkipThrottle({ [LIMITE_GENERAL]: true });

/** Sustituye el límite global por `limit` peticiones cada `ttl` ms, por IP. */
export const Limite = (limit: number, ttl: number): MethodDecorator & ClassDecorator =>
  Throttle({ [LIMITE_GENERAL]: { limit, ttl } });
