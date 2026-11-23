# Rate-limit tras un proxy inverso: `trust proxy` o el límite es global

> Parte de la skill `crm-backend-module`: lee antes su [índice](../SKILL.md).

El `ThrottlerGuard` (y el `@Throttle` del login) filtran por `req.ip`. Detrás
de Apache/nginx en loopback, sin configurar `trust proxy` Express ve siempre
`127.0.0.1` → **todas** las peticiones caen en el mismo bucket y el límite
"por IP" se comparte entre todos los usuarios (5 logins fallidos y quedan
todos bloqueados). En `main.ts`: `app.set('trust proxy', 'loopback')` — toma
la IP real del `X-Forwarded-For` que agrega el proxy, y `loopback` (no `true`)
evita que un cliente externo falsifique su IP. Los webhooks de proveedores
(Meta) van con `@SinLimite()`: sus ráfagas y reintentos no deben chocar
contra el límite —tras varios 429 Meta desactiva la suscripción— y son
idempotentes de todos modos.

**Nunca** `@SkipThrottle()` ni `@Throttle({ default: … })` de la librería: se
aplican por nombre de throttler y el global se llama `general`, así que no hacen
nada (así estuvieron los webhooks hasta 2026-11). Usar `SinLimite()` y
`Limite(limit, ttl)` de `common/limites/limites.ts`; `limites.spec.ts` rechaza
el uso directo.
