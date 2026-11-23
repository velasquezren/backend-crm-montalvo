# 7. Dónde mirar para rendimiento y escalabilidad

> Parte de la skill `crm-backend-arquitectura`: lee antes su [índice](../SKILL.md).

Las mediciones de esta sección son de agosto/septiembre. El inbox ya recibió
SQL lateral con `LIMIT 1` el 1/10; ver [auditoría](../../../../docs/auditoria-2026-10-01.md).
No repetir propuestas resueltas ni usar los percentiles antiguos como baseline actual.

Lo que sigue es honesto sobre lo que **no** verifiqué a fondo — son pistas
concretas basadas en lo que sí encontré hoy, no un análisis de performance real
con profiling. Antes de optimizar cualquiera de estos, medí primero (ver el
cierre de esta sección).

- **El event loop es de un solo hilo en una sola CPU (§2)**. Buscar en el
  código el trabajo síncrono pesado: `excel-parser.ts` y `exportacion-comisiones.service.ts`
  (parseo/generación de Excel con `exceljs`), `bcryptjs` en el login. Si las
  planillas de comisiones crecen mucho, ese parseo bloquea a todo el mundo
  mientras corre — candidato a mover a un `worker_thread` o a una cola si se
  vuelve perceptible. Hoy con 1.287 filas en `VentaImportada` probablemente no
  se nota; no asumas que seguirá sin notarse.
- **55 índices ya existen en `schema.prisma`**, incluyendo GIN trigram para
  búsqueda difusa en `Cliente` y `VentaImportada` — no es un punto de partida
  típico, ya está bastante trabajado. **Ya verificado cuáles se usan de verdad**
  (2026-08-26, `pg_stat_user_indexes`; `stats_reset` es `NULL`, o sea que los
  contadores cubren toda la vida de la base, no una ventana corta):

  ```
  Cliente_nombre_idx      1264 kB   0 scans
  Cliente_email_idx        440 kB   0 scans
  Cliente_saldoTotal_idx   384 kB   0 scans
  Lead_agenteId_idx        224 kB   0 scans
  ```

  Son ~2,3 MB que solo pagan costo de escritura. `Cliente_nombre_idx` es el caso
  más claro: nunca se usa porque la búsqueda por nombre la resuelve el índice
  **GIN trigram**, no el B-tree — está duplicando trabajo con el que sí sirve.

  **Pero no los borres en bloque, y sobre todo no toques `Lead_agenteId_idx`.**
  Que tenga 0 scans no significa que sobre: significa que las consultas que lo
  usarían (`findAll` escopado por agente) hoy las hace casi siempre un ADMIN,
  que ve todo y por tanto no filtra por `agenteId`. En cuanto haya tráfico real
  de agentes, ese índice pasa a ser el que sostiene el escopado. Un índice sin
  uso es una pregunta ("¿quién debería estar usándolo?"), no una conclusión.

  Ignorá también los `_pkey` que aparecen con 0 scans en tablas de 5-20 filas:
  Postgres hace seq scan porque es más barato, y el índice sigue siendo
  obligatorio para la restricción de unicidad. Nunca son candidatos a borrar.

- **`pg_stat_statements` NO está instalada** (verificado 2026-08-26). Es la
  razón por la que este archivo no puede listar "las 5 queries más lentas": no
  hay histórico que consultar, solo `EXPLAIN ANALYZE` puntual sobre una query
  que ya sospechás. Si alguna vez hace falta diagnosticar lentitud de verdad y
  no de oído, habilitarla es el primer paso (`shared_preload_libraries`, exige
  reiniciar Postgres — que en este VPS es compartido, así que no es gratis).
- **`LIMITE_INBOX = 500` era el único problema de escala REAL del sistema.
  RESUELTO el 2026-08-27**, trece días antes de la fecha en que iba a estallar.

  Se deja escrito porque la FORMA del fallo se repite. El backend cortaba en las
  500 más recientes y **el frontend filtraba las pestañas y buscaba en memoria
  sobre ese corte**. Una conversación fuera del corte no estaba "más abajo": era
  invisible para las pestañas *y para el buscador*. La agente buscaba a una
  paciente con chat antiguo, leía "sin resultados" y concluía que no existía.
  No era degradación gradual sino un acantilado —a 499 todo bien, a 501 empiezan
  a desaparecer chats— y lo único que avisaba era un `logger.warn` que nadie
  mira. Ya había pasado una vez al cruzar las 100.

  ```
  Conversacion el 2026-08-26:           325
  Altas nuevas, 14 días (13→26 ago):    186  →  13,3/día
  (500 - 325) / 13,3  ≈  13 días        →  ~8 de septiembre de 2026
  ```

  **Qué se hizo, y por qué no fue subir el número**: las cuatro operaciones
  —ordenar, filtrar por pestaña, filtrar por agente y buscar— se movieron a
  Postgres, y el listado pasa `RespuestaPaginada` como el resto del CRM. La
  pestaña "Sin responder" necesitó una columna desnormalizada
  (`Conversacion.esperandoRespuesta`) porque "el último mensaje es ENTRANTE o
  automático" no se puede expresar en un `where` de Prisma; se escribe en las
  cuatro transacciones que crean un Mensaje, y hay tests que fijan las cuatro.

  Medido sobre 1.000 conversaciones sembradas:

  | | antes | después |
  |---|---|---|
  | Carga inicial | 500 filas · 277,7 kB · 47 ms | 50 filas · 27,8 kB · 18 ms |
  | Un mensaje nuevo (WebSocket) | recargaba las 500 · 277,7 kB | 1 fila · 0,6 kB |
  | Buscar a la paciente del puesto 1.000 | **0 resultados** | 1 resultado · 5,9 ms |

  Cubierto por `inbox-escala.integracion.spec.ts`: 499/500/501/1.000, búsqueda
  de la más antigua por nombre y por teléfono, permisos por agente y refresco de
  una sola fila.
- **N+1 en los services grandes** — auditado el 2026-08-21, línea por línea:
  `planilla-comisiones.service.ts` resuelve TODOS sus agregados en SQL dentro de
  una sola `$transaction` (`aggregate` + dos `groupBy` en `listarVentas`), y el N+1
  que sí tuvo `calculo-comisiones.service.ts` (dos queries por vendedora en el
  bucle de bonos) ya está resuelto con una sola consulta de equipo — el comentario
  del propio código lo documenta. El `findMany` sin `take` de `calcular()` es a
  propósito: el motor de liquidación necesita las filas del periodo en memoria
  (~500/mes; tabla entera: 1.287), no es un listado de API. `reporteConsolidado`
  suma en JS sobre las ~5 filas que ya devuelve: trivial, no vale moverlo.
  Cerrado: no re-auditar sin una razón nueva.
- **Exportación y parseo de Excel** — corregido al contrastar código el
  2026-10-01: `exportacion-comisiones.service.ts` lee PostgreSQL por lotes de
  1.000 filas, pero usa `new Workbook()` y materializa el libro completo.
  Eso **no es streaming de Excel**; las mediciones y el límite están en el
  skill frontend `crm-finanzas` §8e y en el comentario del service. Evaluar
  `WorkbookWriter` si crecen las exportaciones, preservando hojas, estilos y
  resultados. `worker_thread` solo si el parseo bloquea el event loop medido;
  no sustituye el control de memoria del libro.
- **Pool del adaptador `pg`**: diez conexiones configuradas en `PrismaService`.
  Cualquier cambio futuro exige medir contención real; ver §2. El antiguo
  `connection_limit=25` ya no describe la aplicación.
- **La carga real, medida** (2026-09-02, sobre 7 días de `LoggingInterceptor`
  en el journal). Antes de optimizar nada de este módulo, mirá estos números,
  porque cambian el diagnóstico:

  ```
  1.580 peticiones en 7 días  (~9 por hora)   ·   0 errores 4xx/5xx
  ```

  Los endpoints más lentos, por promedio:

  | endpoint | n | prom | máx |
  |---|---|---|---|
  | `GET /kpis/resumen` | 64 | 410 ms | 963 ms |
  | `GET /planilla-comisiones/periodos/:id/analitica` | 27 | 397 ms | 958 ms |
  | `POST /auth/login` | 21 | 336 ms | 498 ms |
  | `GET /conversaciones` | 242 | 108 ms | 910 ms |

  El login a 336 ms es bcrypt (medido en la máquina anterior): es su coste deliberado, no un bug.

  **Y del lado de la base, nada.** Postgres tiene `log_min_duration_statement =
  500` desde antes, o sea que viene registrando toda query lenta: en el último
  mes hay **exactamente tres**, y las tres son los `COPY` de los propios
  `pg_dump` de respaldo. **Ninguna consulta de la aplicación pasó de 500 ms.**
  Conclusión de aquella medición: no se observó un problema de rendimiento.
  Optimizar el código sería resolver lo que no duele.

- **Sigue sin haber profiling de CPU/event-loop**: lo de arriba es latencia
  extremo a extremo, que dice *cuánto* tarda pero no *dónde*. Si algún día hace
  falta saberlo, el paquete npm `clinic` (Clinic.js) o `0x` para CPU/event-loop y
  `autocannon` para carga HTTP. Optimizar sin medir es tan fácil de hacer para el
  lado equivocado como de hacerlo bien.
- **Swagger/OpenAPI sigue sin existir** — no es "velocidad", pero si algún día
  se conecta un tercero o cambia el equipo, ayuda. `kpis`, `usuarios` y `auth`
  **ya tienen suite unitaria** (2026-08-25), cerrando el hueco que este mismo
  punto señalaba: `kpis.integracion.spec.ts` (contra Postgres real desde
  2026-09-22, cuando el embudo pasó a SQL) fija el escopado por agente
  (`kpis.service.ts` es justo donde ya hubo una fuga real de datos entre
  agentes, ver `crm-backend-module`) y que la caché no sirva el resumen de un
  agente a otro; `usuarios.integracion.spec.ts` fija la protección del último
  `SUPER_ADMIN` activo y que nadie se toque sus propios privilegios —contra
  Postgres real desde 2026-09-29: el doble de Prisma que tenía antes se rompió
  entero con un refactor correcto, porque imitaba cada `select` del service—;
  `auth.service.spec.ts` fija que `refresh()` solo dé 401 por un problema real
  de credenciales, nunca por un fallo transitorio de la base. `leads` **ya
  tenía** `leads.integracion.spec.ts` (2026-08-21): la falta de tests ahí no
  era solo hipotética — escondía el bug de escopado que describe
  `crm-backend-module` §"La regla de findAll…", y las pruebas nuevas son
  justamente las que lo hubieran atrapado antes de producción. Mismo
  razonamiento detrás de las tres suites nuevas.
