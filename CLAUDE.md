# CRM Clínica Montalvo — backend

API del CRM de una clínica estética en Bolivia. NestJS 10 + Prisma 5 + PostgreSQL.
Lo usan a diario agentes de venta reales sobre datos de pacientes reales: **no hay
entorno de staging**. Un error aquí lo ve una paciente.

## Dónde está todo

Dos repositorios hermanos bajo el mismo directorio padre:

```
CRM/
├── backend-crm-montalvo/    ← estás aquí
└── frontend-crm-montalvo/   ← Angular 21, PWA, desplegado en Vercel
```

`CRM_MANIFESTO.md` vive en el repo del **frontend** pero gobierna los dos: es la
referencia de arquitectura que citan los skills.

## Antes de escribir código

Carga el skill `crm-backend-module`. No es opcional ni es para cambios grandes:
cubre paginación, escopado por rol, concurrencia en webhooks, firma de Meta y
migraciones, y casi todo cambio toca al menos uno de esos. Su descripción explica
cuándo aplica.

Ese skill documenta **cicatrices**, no teoría: cada regla está ahí porque algo se
rompió en producción. Si una te parece excesiva, probablemente estás a punto de
reintroducir el bug que la motivó.

Para cualquier tarea que no sea "tocar un endpoint" —desplegar, diagnosticar
lentitud, decidir si algo escala, u orientarte la primera vez en este repo—
carga además `crm-backend-arquitectura`: infraestructura real del servidor,
escala real de datos, cómo desplegar paso a paso, y dónde mirar para
rendimiento sin inventar problemas que no existen a esta escala.

## Comandos

```bash
npm run build          # check:skills + nest build — la compuerta real
npm test               # unitarias (rápidas, sin base)
npm run test:integracion:preparar && npm run test:integracion   # necesitan Postgres
npx prisma migrate dev --name <nombre> --create-only            # revisar el SQL antes
```

La base local escucha en el **puerto 5433**, no en el 5432.

**No uses el navegador en este proyecto.** Para probar un endpoint, `curl` contra
la base local.

## Invariantes

- **`npm run build` es la verdad.** Encadena `check:skills`, que compara los skills
  con el código y falla si mienten. Si te contradice, el equivocado es el skill:
  corrígelo en el mismo commit.
- **Ningún `any`.** Tampoco `catch (e: any)` — usa `unknown` y estrecha.
- **Ningún módulo toca la tabla de otro dominio.** Se llama a su service.
- **Todo listado se pagina.** Hay 15.000+ pacientes.
- **Nunca compares roles a mano** (`rol === 'ADMIN'`): usa `alcanceAgente()` /
  `cubreRol()` de `common/auth/roles.ts`. La jerarquía es `AGENTE < ADMIN < SUPER_ADMIN`.
- **Si tocas `schema.prisma`, la migración se genera y se commitea.** Sin eso, quien
  clone el repo queda con la base desincronizada.
- **Todo campo de un DTO lleva su decorador de `class-validator`.** El
  `ValidationPipe` global corre con `whitelist: true`: un DTO sin decoradores no
  llega incompleto, llega `{}` —siempre, sin lanzar y sin log—. `check:skills` lo
  rechaza.
- **Permiso y preferencia de vista son parámetros distintos.** El alcance por rol
  sale de `alcanceAgente()`; un filtro de la interfaz (`?soloMios=true`) se combina
  con AND y nunca lo sustituye. Fundirlos ya recortó en silencio lo que ven las
  agentes.

## Notificaciones

`emitirActividad()` refresca las pestañas abiertas y lo llama todo. **Solo
`notificarEntrante()` manda push al teléfono, y solo lo llama `procesarEntrante`** —
el único punto donde ha escrito una paciente. Si haces que otro sitio notifique,
las agentes recibirán avisos por sus propios envíos y por cada tilde de entrega de
Meta; eso termina con la notificación desactivada y con la que sí importa perdida.

Sin `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` la función queda apagada, igual que R2 y
WhatsApp. **No generes llaves al vuelo**: cambian en cada reinicio e invalidan todas
las suscripciones sin avisar.

## Caché

Una sola implementación: `common/cache/cache-memoria.ts` (TTL + tope de entradas +
deduplicación de cargas en vuelo). **No escribas otro `Map` con `expiresAt` a mano** —
había tres y una de ellas no borraba nunca, que es como se llegó a la fuga de KPIs.

Vive en el proceso, no es distribuida. Si algún día el backend escala a varias
instancias, ese archivo es el único sitio donde cambiar a Redis.

## Observabilidad

Toda petición HTTP lleva un `requestId` (cabecera `X-Request-Id`), asignado por
`asignarRequestId` en `main.ts` — el primer middleware de la cadena. `LoggingInterceptor`
(global, en `app.module.ts`) registra una línea por petición **exitosa**; `AllExceptionsFilter`
(global, en `main.ts`) registra los errores. Entre los dos, cada petición deja exactamente una
línea de log con su `requestId`, que también viaja en el cuerpo de cualquier error — así se
cruza lo que vio la agente con el log del servidor sin depender de la hora aproximada. Ninguno
de los dos registra cuerpo ni cabeceras (son datos de pacientes).

`AllExceptionsFilter` no cambia la forma de un `HttpException` normal (400/401/404 siguen
siendo `{ statusCode, message, error }`, igual que antes): solo le suma `requestId`. Es la red
de seguridad para lo que NO es un `HttpException` — antes cualquier error de programación caía
al 500 default de Nest, sin forma consistente.

`GET /health` (`common/health/`) es `@Public()` + `@SkipThrottle()` y verifica la base con
`SELECT 1`; 503 si no responde. Sirve para monitoreo/systemd y para confirmar rápido que un
despliegue subió — no reemplaza los dos curls de verificación post-despliegue (`/auth/login`
vacío → 400, `/planilla-comisiones/periodos` sin token → 401), que prueban que el
`ValidationPipe` y el guard siguen vivos.

## Trampas conocidas

- **Comisiones: el Excel importado viene en DÓLARES**, y se convierte a Bs con el
  tipo de cambio al final. Asumir bolivianos en la base rompe el cálculo de forma
  silenciosa — ya pasó. El razonamiento completo está en la cabecera de
  `calculo-comisiones.service.ts`; léelo antes de tocar ese módulo.
- **La UI muestra Bs (es-BO)**; el dólar es interno al cálculo de comisiones.
- **`prisma/schema.prisma` es la fuente de verdad de los enums del frontend**, que
  los genera desde aquí. Añadir un valor a un enum obliga a correr `npm run sync:tipos`
  en el otro repo o su build falla.
