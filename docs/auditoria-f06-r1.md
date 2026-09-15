# F06-R1 — Recuperación durable de adjuntos entrantes

14 de septiembre de 2026. Entrega local; sin despliegue ni acceso a producción.
Alcance exclusivo: F06-R1. F06-R2 (lead de primer contacto) sigue abierto.

## Causa raíz

El mensaje conservaba tipo, MIME y nombre, pero el identificador de media de
Meta quedaba en memoria. La descarga se disparaba sin un trabajo persistente.
Un fallo o reinicio dejaba `mediaKey = null`; repetir el webhook retornaba por
`whatsappMsgId` antes de la descarga. Se conserva ese retorno: ahora la
recuperación tiene un recorrido independiente.

## Diseño elegido

Tabla pequeña `TrabajoMediaEntrante`, una fila por mensaje. Ampliar `Mensaje`
con los campos operativos también permitiría persistir el estado, pero añadiría
esos campos escalares a sus lecturas REST por defecto y mezclaría recepción con
los intentos salientes. La relación opcional no se incluye en esas respuestas.

La creación anidada del trabajo participa en la misma transacción que crea
`Mensaje` y actualiza `Conversacion`. Si falla, se revierte el mensaje y el
controlador conserva 503 y el aislamiento por elemento. Se crea incluso cuando
R2 o las credenciales de Meta faltan.

Se reutilizan Prisma, PostgreSQL, `enSegundoPlano`, los servicios de transporte
y el patrón de barridos acotados. No hay infraestructura ni dependencias nuevas.

## Modelo persistente

| Campo | Significado |
| --- | --- |
| `mensajeId` | PK y FK con cascada; impide un segundo trabajo para el mismo mensaje |
| `mediaId` | Identificador de origen de Meta, no una URL temporal |
| `estado` | Estado operativo, restringido por CHECK de PostgreSQL |
| `intentos` | Intentos consumidos del presupuesto; configuración ausente/rechazada no lo consume |
| `proximoIntento` | Próxima ejecución; nulo solo en estados terminales |
| `ultimoError` | Código propio sanitizado, máximo 80 caracteres |
| `reclamadoEn` | Inicio del último intento reclamado |
| `createdAt`, `updatedAt` | Antigüedad del trabajo y última escritura |

La relación al mensaje resuelve conversación/línea. MIME y nombre ya viven en
`Mensaje`. No se guardan credenciales, respuestas de terceros, URLs firmadas ni
el webhook completo. Las credenciales se resuelven de nuevo en cada intento.

## Estados del trabajo

| Estado | Significado y salida |
| --- | --- |
| PENDIENTE | Trabajo persistido y todavía sin intento |
| PROCESANDO | Reclamado; el bloqueo de PG decide si hay un dueño vivo |
| REINTENTABLE | Fallo transitorio o configuración incompleta; tiene fecha de retorno |
| COMPLETADO | R2 confirmado y `mediaKey` guardada; sin agenda |
| DESCARTADO | Error permanente, como tamaño excesivo u origen 404/410; sin agenda |
| AGOTADO | Ocho intentos consumidos o siete días de antigüedad; sin agenda |

PROCESANDO no es un cerrojo en memoria ni una lease que otro worker pueda robar
por tiempo: es estado observable. La exclusión la proporciona PostgreSQL.

## Errores y política de retry

- **Transitorios:** red, cancelación/timeout, HTTP 408/429/5xx y otros rechazos no
  clasificados como definitivos. Un 404 de la URL de descarga se reintenta
  obteniendo una URL nueva.
- **Configuración:** falta de R2, cuenta de la línea deshabilitada/sin
  credenciales, HTTP 401/403 de Meta o R2, o bucket R2 no encontrado (404).
  Espera una hora sin consumir presupuesto. No se confunde con archivo perdido.
- **Permanentes:** archivo mayor que 25 MiB, HTTP 413, media no disponible en
  el endpoint de origen (404/410).
- Un error sin clasificación segura conserva posibilidad de reintento acotado.
  Nunca se persiste ni se loguea su texto externo.

Máximo **8 intentos**. Esperas después de los siete primeros fallos transitorios:
**1, 5, 15, 60, 180, 360 y 720 minutos**. No se vuelve a ejecutar antes de
`proximoIntento`; el siguiente barrido puede añadir hasta un minuto de latencia.

Plazo máximo **7 días desde crear el trabajo**, también para configuración
incompleta. No se agenda más allá del plazo. AGOTADO conserva el origen para
diagnóstico; no existe reactivación automática ni endpoint nuevo de reintento.
Un intento interrumpido después de incrementar el contador consume presupuesto.

## Reclamación y concurrencia

Cada intento toma `pg_try_advisory_xact_lock(hashtextextended(mensajeId, 60061))`
dentro de una transacción Prisma. No espera si otro worker posee ese bloqueo.
Después de adquirirlo relee el trabajo y comprueba que siga vencido.

El bloqueo se mantiene durante todo el intento. No se libera entre reclamar y
subir. Una colisión del hash solo serializa dos trabajos distintos; nunca permite
dos dueños del mismo trabajo.

PROCESANDO e intentos se confirman mediante escrituras cortas independientes
para que sobrevivan al crash. **El resultado final y mediaKey se confirman dentro
de la transacción que mantiene el bloqueo.** Un dueño que pierde su conexión no
puede confirmar cambios finales por fuera del bloqueo. Se comprueba además la
conexión antes de iniciar el PUT.

El refresco WebSocket se emite después del commit. Su fallo no reabre la tarea y
no dispara push. PostgreSQL documenta la liberación de los bloqueos de
transacción al terminarla: [bloqueos consultivos](https://www.postgresql.org/docs/16/explicit-locking.html#ADVISORY-LOCKS).

Lote de **10**, concurrencia **2 por instancia**, barrido cada **60 segundos** y
despertar después de persistir media. Un guard local evita solapar despertares;
la exclusión entre instancias depende del bloqueo de PG. No se mantiene un
bloqueo de fila sobre Mensaje durante la espera de red.

Presupuesto de red **60 s**, propagado a Meta, lectura del stream y R2. La
transacción del bloqueo tiene máximo **90 s**, con 5 s de espera por conexión.
A lo sumo dos conexiones por instancia permanecen ocupadas durante la red;
las escrituras cortas comparten el pool existente. No usar este patrón con
concurrencia grande ni cambiar esos límites sin evaluar el pool.

## Idempotencia de R2

Clave conservada: `wa/<conversacionId>/<mensajeId>`.

El PUT de recepción utiliza `If-None-Match: *`, soportado por
[R2 PutObject](https://developers.cloudflare.com/r2/api/s3/api/).
Un 412 confirma que esa clave inmutable ya existe: converge sin sobrescribirla.
Esto cubre una subida aceptada cuya respuesta se perdió o cuyo registro en
PostgreSQL falló. La propiedad depende de reservar esa clave para ese mensaje,
sin escritores externos que la reutilicen.

Se usa firma + un solo `fetch`, evitando los reintentos internos de
`AwsClient.fetch`. El contrato de `R2Service.subir()` para otros consumidores
se conserva. No se cambian los reintentos salientes ni su estado INCIERTO.

## Comportamiento tras reinicio

El barrido de arranque/intervalo consulta pendientes, reintentables y reclamados
cuya fecha venció. La reclamación agenda una revisión a un minuto. Si el proceso
muere, PG libera el bloqueo; una instancia nueva retoma el trabajo sin nuevo
webhook y sin objetos, timers o señales del proceso anterior.

Si falla PostgreSQL durante la finalización, se revierte esa transacción.
Queda PROCESANDO con su revisión programada, en vez de afirmar COMPLETADO sin
`mediaKey`. El siguiente intento vuelve a la misma clave determinista.

## Migración

`20260914234808_media_entrante_durable`, generada con Prisma y revisada.
Solo crea tabla, FK, PK, índice de agenda y cinco CHECK:

- estado permitido;
- intentos entre 0 y 8;
- identificador de media no vacío;
- correspondencia entre estado terminal y agenda nula;
- PROCESANDO exige fecha de reclamación.

No modifica filas previas, enums públicos ni fórmulas. El cliente Prisma se
regenera. No requiere cambios del frontend.

Se comprobó en PostgreSQL 16 descartable:

1. Todas las migraciones desde base limpia (`crm_media_limpia`).
2. Esquema anterior con un mensaje ficticio y `mediaKey` existente; aplicar solo
   la nueva migración conserva ambos (`crm_test`).
3. Restricciones idénticas entre ambas rutas, índice presente y PK/FK/cascada
   ejercitados con SQL real.

No se inventan tareas para mensajes históricos: su `mediaId` no fue conservado.

## Observabilidad

El worker registra ID interno, resultado, intentos, código de fallo y próximo
intento, además del resumen por estado cuando procesa un lote. No registra
contenido de pacientes, teléfonos, URLs ni credenciales. Si PG falla antes de
guardar el error, queda el log y la tarea pendiente/reclamada.

Consultas operativas de solo lectura:

```sql
SELECT estado, count(*) FROM "TrabajoMediaEntrante" GROUP BY estado ORDER BY estado;

SELECT "mensajeId", estado, intentos, "ultimoError", "reclamadoEn",
       "proximoIntento", "createdAt", "updatedAt"
FROM "TrabajoMediaEntrante"
WHERE estado NOT IN ('COMPLETADO')
ORDER BY "proximoIntento" NULLS LAST, "mensajeId"
LIMIT 100;
```

`MediaEntranteService.resumen()` usa GROUP BY, sin cargar todas las filas.
No se añade UI, endpoint ni permiso.

## Pruebas

Validación definitiva: 545 unitarias (36 suites), 402 integraciones (21 suites),
incluidas 26 PostgreSQL de esta entrega; build, typecheck estricto, test:build
9/9, check:skills y git diff --check.

Comandos ejecutados desde la raíz del backend:

```bash
npm test -- --runInBand
npm run test:integracion
npm run build
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit --incremental false --rootDir .
npm run test:build
npm run check:skills
git diff --check
```

`--rootDir .` permite revisar también prisma.config.ts y las pruebas sin cambiar
tsconfig ni emitir artefactos. Para ejecutar solo la suite nueva:

```bash
npm run test:integracion -- --runTestsByPath src/modules/conversaciones/media-entrante.integracion.spec.ts
```

 La suite PostgreSQL
`media-entrante.integracion.spec.ts` utiliza dos PrismaService independientes
contra la base real; solo el límite externo está simulado.

- A: mensaje/trabajo pendiente, destruir instancia y recuperar con otra conexión.
- B: dos workers por el mismo ID; el primero pausado dentro de Meta y la fecha
  vencida; solo uno entra al transporte.
- C: error HTTP, red, timeout y descarga; backoff y recuperación.
- D: R2 temporalmente caído y recuperación con la misma clave.
- E: duplicados mientras está pendiente/procesando: una fila, una tarea, una
  subida y un aviso entrante.
- F: tamaño excesivo/origen inexistente: descarte sin retry infinito.
- Configuración ausente/rechazada, ocho intentos y plazo de siete días.
- PROCESANDO sobreviviente, pérdida real de la conexión del lock mediante
  `pg_terminate_backend` y rechazo de la finalización del dueño anterior.
- Apagado durante una tanda sin iniciar otra y recuperación desde nueva instancia.
- Lote/concurrencia, presupuesto de cancelación de 60 s, R2 aceptado sin
  respuesta, fallo de escritura tras el PUT y fallo de WebSocket tras commit.
- Fallo al crear el trabajo: rollback del mensaje, 503 y resto del lote procesado.
- Constraints, índice y cascada.

Las unitarias cubren política, sanitización, lectura acotada sin content-length,
cancelación de un read pendiente y transporte R2 condicional sin retries ocultos.
F06-R1 ya no depende del reproductor de auditoría: vive en regresiones normales.
El reproductor restante documenta únicamente F06-R2, todavía abierto.

## Comportamiento cambiado y conservado

**Cambia:** los adjuntos nuevos generan trabajo durable, reintentan sin otro
webhook, se descartan/agotan de forma observable y soportan recuperación tras
caída. El límite de 25 MiB se aplica durante la lectura, también sin cabecera.

**Se conserva:** HTTP 200 después de persistir, 503 por fallos de persistencia,
aislamiento por elemento, deduplicación por `whatsappMsgId`, clave de R2, una
notificación entrante, credenciales por línea, permisos, sesión, frontend y
lógica del lead. Ningún webhook duplicado se vuelve a procesar completo.

## Riesgos restantes

- No se probó contra Meta/R2 reales. Los transportes se simulan de forma
  controlada; una caída externa larga o media expirada puede acabar en AGOTADO
  o DESCARTADO. Siete días es política local, no promesa de retención de Meta.
- No recupera adjuntos antiguos cuyo identificador ya se perdió.
- Una caída de conexión puede dejar una petición remota ya enviada: no es
  posible retirarla del servidor remoto. El PUT condicional impide una segunda
  publicación efectiva; el bloqueo impide la concurrencia normal entre workers.
- Un crash entre commit y refresco puede perder ese evento WebSocket; la media
  sigue persistida y aparece en la próxima lectura.
- La tabla conserva estados terminales hasta borrar el mensaje (cascada); no
  se introduce purga ni reintento manual en esta entrega.
- La suite financiera histórica sigue avisando que omite asserts cuando faltan
  los Excel privados. No se modificó ese dominio.
- F06-R2 permanece abierto. No se inicia su corrección.

## Rollback

Restaurar el artefacto anterior de aplicación, deteniendo antes los workers
nuevos para no mezclar protocolos de recepción. **Conservar tabla, datos,
schema aditivo y carpeta de migración aplicada**; no ejecutar DROP ni borrar
migraciones para volver al binario anterior.

El código anterior ignora la tabla; los objetos y mediaKey completados siguen
siendo compatibles. Los pendientes quedan pausados y se retomarán al restaurar
esta versión. Volver al código anterior reabre F06-R1 para adjuntos nuevos.
No hay rollback de datos ni acción ejecutada en producción.
