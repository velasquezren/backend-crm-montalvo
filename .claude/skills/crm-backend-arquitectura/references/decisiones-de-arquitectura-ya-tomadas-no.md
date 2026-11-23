# 5. Decisiones de arquitectura ya tomadas — no las reabras sin el porqué

> Parte de la skill `crm-backend-arquitectura`: lee antes su [índice](../SKILL.md).

Cada una de estas resuelve algo específico del contexto de §2 (máquina
compartida con Resultados, sin staging; varias nacieron en el VPS viejo de un
núcleo y siguen valiendo) o de la escala real de §3. Si una te parece
"de más", probablemente estás a punto de reintroducir el problema que resolvió.

- **`common/auth/roles.ts`** — única fuente de la jerarquía de roles
  (`AGENTE` < `ADMIN` < `SUPER_ADMIN`). `RolesGuard` y el escopado por agente
  leen de acá; nunca se compara `usuario.rol === 'ADMIN'` a mano. Detalle
  completo en `crm-backend-module`.
- **`common/cache/cache-memoria.ts`** — una sola implementación de caché
  in-process, con TTL y tope de entradas. Vive en el proceso porque hay UNA
  instancia (§2); si esto escala a varias instancias, es el único lugar donde
  cambiar a Redis. No es prematuro tenerlo centralizado: había tres `Map`
  distintos con `expiresAt` a mano y uno nunca limpiaba — así se llegó a una
  fuga de memoria real en KPIs.
- **`common/guards/meta-signature.guard.ts`** — la firma HMAC de Meta se
  verifica en un solo lugar compartido por todos los webhooks (WhatsApp, Lead
  Ads), no reimplementada por cada uno. `check:skills` obliga a que todo
  `@Post()` bajo `webhooks/` lo use.
- **`common/audit/audit.service.ts`** — auditoría centralizada para mutaciones
  críticas (ventas, comisiones, reasignación de clientes). Nunca tumba la
  operación de negocio (va en try/catch).
- **Observabilidad** (agregada 2026-08-20): `common/logging/request-id.middleware.ts`
  asigna un id por petición (`X-Request-Id`); `common/logging/logging.interceptor.ts`
  registra una línea por petición exitosa; `common/filters/all-exceptions.filter.ts`
  es la red de seguridad para lo que no es un `HttpException` — no cambia la
  forma de los errores existentes, solo suma `requestId`. `common/health/health.controller.ts`
  expone `GET /health` con chequeo real de base (`SELECT 1`).
- **Split de mensajería de WhatsApp** (2026-08-20): `conversaciones.service.ts`
  llegó a 1025 líneas mezclando CRUD/lectura del inbox, mensajería saliente del
  agente e ingesta del webhook entrante. `modules/conversaciones/ingesta-whatsapp.service.ts`
  se llevó solo la ingesta (`procesarEntrante`, get-or-create de conversación,
  acuse fuera de horario) — único llamador: el controller del webhook. Mismo
  comportamiento, mismas queries, verificado con la suite de integración contra
  Postgres real antes de tocar producción. Con el mismo criterio salieron
  después (2026-09-30) las plantillas de WhatsApp —listar, enviar, las del
  sistema, las de campaña y «Nuevo chat»— a `modules/conversaciones/envio-plantillas.service.ts`,
  y las consultas puras del inbox a `modules/conversaciones/consultas-inbox.ts`.
  Lo que comparten el envío de texto y el de plantillas vive en
  `modules/conversaciones/envio-comun.ts`.
- **Tareas periódicas: `@TareaPeriodica` + pg-boss** (`common/trabajos/`,
  23/10/2026) — los barridos largos (tipo de cambio, categoría de pacientes,
  cierre por inactividad, recordatorios, aviso de ventas a Meta) se marcan con
  el decorador y `TrabajosService` los programa. Con `TRABAJOS_PGBOSS=on`, en
  pg-boss sobre el mismo Postgres: cron a la hora de La Paz (no la del VPS),
  cola `stately` (no se apilan vueltas), reintentos e historial en `pgboss.job`.
  Sin la bandera, o si pg-boss no arranca, vuelven a su `setInterval`: encenderlo
  no puede empeorar el peor caso. Su schema lo crea la migración
  `pgboss_trabajos` y la app corre con `migrate: false` (sin DDL al arrancar);
  subir pg-boss exige su `getMigrationPlans` en otra migración. Va en **11.x**,
  la última CommonJS: la 12 es solo ESM y Jest no la carga hasta Node 24.9,
  igual que NestJS 12. Las colas durables propias (reintentos de envío, media,
  comprobantes, transcripción) **no** se mudaron: su lease, backoff y
  FALLIDO/INCIERTO ya están probados contra Postgres y moverlas no compra nada.
- **WebSocket para "algo cambió", REST para los datos** — el gateway nunca
  manda el dato en el payload del socket, solo avisa; evita que el escopado por
  rol tenga que reimplementarse en el canal de WebSocket.
- **Sin repository pattern, sin DDD/hexagonal, sin microservicios** — decisión
  activa, no descuido. A esta escala (§3) y con un solo proceso (§2), Prisma
  Client ya hace de repository; una capa extra de indirección no compra nada y si
  agrega la superficie que hay que mantener. Si el día de mañana el volumen o el
  equipo crecen 10x, ahí sí vale reabrir esta conversación — hoy no.
- **TypeScript en `strict` completo, sin `declaration`** (`23f8acd`, 2026-08-20)
  — antes eran tres banderas sueltas de la familia `strict`; con `strict`
  entero, `useUnknownInCatchVariables` volvió regla de compilador lo que hasta
  entonces era solo convención escrita (`catch (e: unknown)`, nunca `any`).
  Sacar `declaration` —nadie importa este backend como librería, y generaba
  113 `.d.ts` de más— bajó el build de 3,0 a 2,7s y el `dist/` de 2,1 a 1,5 MB
  (mediana de 3 builds limpios, medido en el commit). 10% menos en la máquina
  en el que también corre el build (§2); no dimensionarlo como el VPS antiguo de un núcleo.
- **Cachear sin medir salió caro, y se revirtió** (`695d9d0`/`c9d2b72`,
  2026-08-19, revertidos en `69f80bc`, 2026-08-20) — caché en memoria para
  `dashboard`/`demografia`/`historialPaciente`/`perfilMedico` de `servicios`.
  Medido después: 1-3 ms de ahorro sobre un round-trip de ~190 ms (1,5%), y
  ninguna de las cuatro se invalidaba al reimportar la planilla o corregir una
  clasificación — de paso anulaba la invalidación del interceptor de caché del
  frontend, que sí funciona. Costo real, ganancia casi nula. Confirma la regla
  que el frontend ya fuerza con `check:skills` (`crm-rendimiento`: "un cambio
  de `perf` sin medición antes/después no se commitea") — **acá todavía es
  solo disciplina, no hay validador que la revise.** Antes de cachear algo en
  `servicios` o en cualquier módulo cuyos datos se reescriben al importar, mide
  el ahorro real y confirma cómo se invalida antes de usar el prefijo `perf`.
