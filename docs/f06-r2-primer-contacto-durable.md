# F06-R2 — primer contacto durable

**F06-R2: CERRADO**, commit `b6ec462` publicado. F06-R1 está CERRADO en
`8faa263`. F06 completo está CERRADO; límites aceptados en
[ESTADO_ACTUAL](ESTADO_ACTUAL.md). Sin despliegue de producción.

## Reconstrucción antes del cambio
Webhook espera ingesta por elemento → buscar mensaje por whatsappMsgId → obtener/crear
paciente → obtener/crear conversación por (clienteId, lineaId), devolviendo esNueva
→ contexto de anuncio → transacción mensaje + trabajo media + actualización del chat
→ si esNueva y línea comercial, INSERT Lead fuera de transacción con catch
→ notificación/realtime y acuse existentes.

esNueva solo identifica qué petición ganó el INSERT de conversación. No sobrevive
al fallo del mensaje ni al INSERT del lead. El duplicado retorna antes del alta.
La identidad comercial inicial corresponde a la conversación de paciente + línea;
un paciente puede tener otras oportunidades, incluso otras conversaciones por línea.

## Decisión previa a implementación
B: registro pequeño PrimerContactoWhatsapp, PK conversacionId. Nace junto con la
conversación comercial. Se arma con el primer mensaje confirmado dentro de la
transacción que ya persiste mensaje y adjunto. No se migran conversaciones antiguas:
no existe evidencia suficiente para atribuirles un lead inicial sin duplicar historia.
A (transacción conversación + mensaje + lead) haría que fallar el lead impidiera
confirmar y notificar un mensaje; B conserva el aislamiento comercial existente.

Estados derivados: reservado (mensajeId null), pendiente/reintentable (mensajeId
presente, leadId null, proximoIntento presente), completado (leadId presente).
Procesando es un bloqueo transaccional PostgreSQL, sin lease ni estado huérfano.
Origen y anuncio se congelan al confirmar el primer mensaje. No se guardan tokens,
URLs ni payloads. PK de conversación y UNIQUE mensajeId/leadId evitan identidades
ambiguas. Lead conserva su cardinalidad por paciente y anuncio no único.

Bloqueo FOR UPDATE SKIP LOCKED; INSERT Lead y enlace al registro en una transacción.
Savepoint permite registrar el error y backoff aun si falla una sentencia SQL.
La dueña se consulta bajo bloqueo de Cliente coordinado con sus reasignaciones.
Sin red externa: transacción máxima 5 segundos, espera pool 2 segundos; lote 10
secuencial, barrido al arranque y 60 segundos después de finalizar el anterior.
Backoff 1, 5, 15, 60 minutos, luego 60 minutos; no se descarta automáticamente un
alta válida por una indisponibilidad de PostgreSQL. Se detiene al completar o al
borrar explícitamente su contexto. Error SQL estructural persistente requiere
corrección operativa; el registro sigue visible y los intentos quedan espaciados.
Una caída de conexión que impide guardar el error deja el trabajo previamente
confirmado pendiente para el siguiente barrido.

La nueva instancia barre únicamente PostgreSQL. Ningún duplicado reejecuta todo
el webhook ni emite notificaciones por recuperar el lead. F06-R1 conserva su trabajo
anidado en la misma transacción; solo cambia la composición de esa transacción y
la inyección de la nueva dependencia en sus fixtures.

## Invariante garantizado

Para una conversación comercial creada por esta versión, el primer mensaje entrante
confirmado activa una única obligación de alta inicial. Bajo disponibilidad eventual
de PostgreSQL y sin borrar explícitamente su contexto, converge a exactamente un
Lead. La identidad es conversación (paciente + línea), no paciente, anuncio,
`whatsappMsgId` ni orden de llegada de las peticiones HTTP.

El primer mensaje es el que confirma la activación de la reserva. Con webhooks
concurrentes puede diferir del orden temporal declarado por Meta. Su origen y
anuncio quedan congelados; mensajes posteriores no cambian esa atribución.

## Flujo normal y recuperación

1. Cliente conserva su get-or-create por teléfono.
2. La creación de conversación comercial incluye la reserva; ambos INSERT son
   atómicos. Una carrera de creación la resuelve el UNIQUE paciente/línea.
3. Mensaje, trabajo de adjunto F06-R1, actualización del chat y activación del alta
   comparten transacción. Si activar el trabajo falla, se revierte el mensaje.
4. Se intenta el alta inmediatamente. Bloqueo exclusivo del trabajo y del paciente,
   INSERT de Lead + enlace/completado en una transacción corta.
5. Fallar el alta comercial conserva el mensaje y su aviso. Un savepoint revierte
   también el lead si falla el enlace posterior y guarda el próximo intento.
6. Al iniciar una instancia se barre la agenda persistida. Cada barrido toma hasta
   10 candidatos, secuencialmente, y se programa el siguiente 60 segundos después.
   Otra instancia salta las filas bloqueadas mediante SKIP LOCKED.
7. Un duplicado retorna el mensaje existente, incluso si compitió por el índice
   después del precheck. No repite notificaciones ni modifica la agenda del alta.

No hay lease que expire mientras sigue trabajando otra instancia. Al cerrar una
conexión PostgreSQL revierte su transacción y libera los bloqueos. Si se perdió la
respuesta de COMMIT, la siguiente consulta ve el lead enlazado o el trabajo pendiente;
no puede quedar un lead confirmado sin el enlace de esa misma transacción.

Una reserva sin mensaje no genera lead. Si falla el mensaje, Meta no recibe una
confirmación de persistencia y su reintento puede activar esa misma reserva.
Una línea que dejó de ser comercial antes de activar la reserva no la activa.
Una obligación ya activada conserva la elegibilidad comercial del contacto.

## Ownership y comportamiento conservado

`ClientesService.agenteParaAltaInicial` bloquea la fila de Cliente para leer su
dueña actual. Las reasignaciones F04 ya actualizan esa fila antes de la cascada
a leads: si gana el alta, la reasignación incluye el nuevo lead; si gana la
reasignación, el alta lee la nueva dueña. Ningún cambio en permisos, roles o endpoints.

Se conservan múltiples oportunidades históricas por paciente, leads de formulario
Meta con `metaLeadId` único, anuncio no único, una conversación por paciente/línea,
líneas no comerciales sin autoalta, reglas de notificación y acuse.
No hay notificación adicional al recuperar un lead. El hueco previo entre confirmar
el mensaje y emitir su aviso ante una caída del proceso no se convierte en outbox
de notificaciones en esta entrega.

F06-R1 conserva modelo, migración, worker, transportes, clave R2 y todas sus
aserciones. La dependencia indispensable se limita a componer la transacción del
mensaje con el alta y añadir el proveedor requerido a su constructor de prueba.

## Migración

`20260915002934_primer_contacto_durable` es aditiva: solo crea la nueva tabla,
sus índices y FKs hacia Conversacion/Mensaje/Lead. No actualiza ni elimina leads.

Verificado en PostgreSQL 16 desechable, loopback :5433:

- Base `crm_test`: todas las migraciones anteriores a F06-R2, paciente ficticio,
  conversación y lead CONVERTIDO; aplicar la nueva migración conserva el lead,
  su origen y estado, y crea **cero** reservas retrospectivas.
- Base `crm_f06r2_limpia`: todas las migraciones desde cero.
- Comparación de `pg_constraint`, `pg_get_constraintdef` y `pg_indexes`:
  resultado idéntico en ambas bases.
- PK conversacionId, únicos mensajeId y leadId; tres FKs con CASCADE hacia la
  reserva, CHECK de los tres estados validado, índice (proximoIntento, conversacionId).
- Las regresiones prueban rechazo real de estado incoherente y reserva duplicada.

Comandos utilizados, con DATABASE_URL explícita para cada base local:

```sh
node node_modules/prisma/build/index.js migrate deploy
npm run prisma:generate
npm run test:integracion:preparar
npm run test:integracion
```

Los dos primeros requieren configurar DATABASE_URL a la base local elegida.
`test:integracion:preparar` **recrea crm_test**: usar únicamente el servidor
descartable descrito en el skill de arquitectura; nunca apuntarlo a producción.

Evidencia local de esta ejecución en `/tmp/crm-f06-r2/`:
`migracion-sobre-anterior.log`, `migracion-limpia.log`,
`schema-sobre-anterior.log`, `schema-limpio.log`,
`datos-anteriores-conservados.log`. La regresión de constraints queda versionada.

## Observabilidad y retry

`intentos` cuenta intentos registrados, incluido el exitoso; `ultimoError`
contiene solo código Prisma o ALTA_NO_COMPLETADA. No contiene error.message,
SQL, teléfono, credenciales o datos de campaña completos. `proximoIntento`
permite inspeccionar y ordenar la agenda; `updatedAt` indica su última transición.

Backoff: 1, 5, 15, 60 minutos, después 60 minutos. No hay límite automático de
intentos para una obligación comercial válida. Una caída de base es transitoria;
un error persistente de esquema o integridad necesita intervención y queda visible.
No se consulta configuración externa ni se llama a Meta/R2 para crear el lead.

```sql
SELECT c."lineaId",
  count(*) FILTER (WHERE p."mensajeId" IS NULL) AS reservados,
  count(*) FILTER (WHERE p."mensajeId" IS NOT NULL AND p."leadId" IS NULL) AS pendientes,
  count(*) FILTER (WHERE p."leadId" IS NOT NULL) AS completados
FROM "PrimerContactoWhatsapp" p
JOIN "Conversacion" c ON c.id = p."conversacionId"
GROUP BY c."lineaId";

SELECT "conversacionId", intentos, "ultimoError", "proximoIntento", "updatedAt"
FROM "PrimerContactoWhatsapp"
WHERE "leadId" IS NULL AND "mensajeId" IS NOT NULL
ORDER BY "proximoIntento"
LIMIT 100;
```

## Pruebas PostgreSQL y suite completa

`src/modules/leads/primer-contacto.integracion.spec.ts`: **23 pruebas**.

| Caso | Evidencia |
| --- | --- |
| A | Primer mensaje comercial: conversación + mensaje + exactamente un lead |
| B | Trigger falla INSERT Lead; persiste retry, conserva aviso, barrido completa |
| C | Trigger falla Mensaje después de conversación; reserva sobrevive y retry completa |
| D | Duplicado pendiente/concluido no repite mensaje, trabajo, intento ni aviso |
| E | Dos conexiones, mismo ID y mensajes distintos; una sola alta inicial |
| F | Cierre de servicio y desconexión; nuevo Prisma y nuevo servicio recuperan sin webhook |
| G | Leads PERDIDO/CONVERTIDO anteriores conservados íntegramente |
| H | Línea clínica sin reserva ni lead |
| Adicionales | Tres números por paciente, atribución, reservas y enlaces fallidos, constraints, borrado explícito, lote 10, cambio de línea comercial, ownership vigente y concurrente |

La prueba exclusiva bloquea el INSERT dentro de PostgreSQL, comprueba en
`pg_stat_activity` que espera y ejecuta el segundo worker con otro Prisma:
devuelve false mientras el primero mantiene la reclamación. La de ownership
verifica la espera real de la reasignación mediante un bloqueo transactionid.

El antiguo reproductor ahora ejecuta estas regresiones; ya no mantiene una
simulación que esperaba fallar.

Resultados finales:

- Integraciones: **425 tests / 22 suites**, incluidas las 26 pruebas F06-R1.
- Unitarios: **547 tests / 37 suites**, con retry y sanitización de F06-R2.
- `npm run build`, typecheck de todas las fuentes con `--rootDir .`: correctos.
- `npm run test:build`: **9/9**.
- `npm run check:skills` y `git diff --check`: correctos.
- Advertencia preexistente: los asserts de verificacion-diciembre que requieren
  Excel privados no se ejecutaron por ausencia de CRM_EXCELS_2025_DIR. No afecta
  a las 23 regresiones F06-R2 y no se modificó Finanzas.

## Archivos

- Modelo Prisma y migración aditiva.
- `leads/primer-contacto.service.ts` y sus suites unitaria/PostgreSQL.
- `leads.module.ts`, `conversaciones.module.ts`: proveedor e importación.
- `ingesta-whatsapp.service.ts`: reserva, activación y dedup concurrente.
- `clientes.service.ts`: lectura de dueña dentro de la transacción del alta.
- Fixtures de conversaciones, líneas y media: inyección del nuevo proveedor.
- Este informe, ESTADO_ACTUAL y entrada histórica del reproductor.

## Riesgos restantes

- La garantía requiere PostgreSQL disponible eventualmente y corregir un error
  estructural persistente. No se descarta silenciosamente el alta.
- No se infieren ni reparan leads faltantes de conversaciones anteriores: no hay
  identidad histórica suficiente para distinguirlos de oportunidades legítimas.
- Borrar explícitamente mensaje, conversación, paciente o lead elimina su reserva
  mediante FK; borrar un lead no debe resucitarlo al siguiente mensaje.
- No se modificó ni hizo durable la entrega de notificaciones ante caída del proceso.
- Validado localmente; sin despliegue ni pruebas con datos de producción.

## Rollback conservador

1. Antes de volver al binario anterior, detener la ingesta y el worker y conservar
   un respaldo de la base y de PrimerContactoWhatsapp; inventariar pendientes.
2. Revertir el commit de aplicación, regenerar el cliente y reconstruir el backend.
   **Conservar la tabla, índices, constraints y registro de migración**: el esquema
   es aditivo y el código anterior tolera la tabla extra.
3. El código anterior no recupera estas altas. Mantener pausada la ingesta si se
   necesita conservar la garantía; reaplicar la versión corregida y reanudar.
   Las reservas existentes y los leads completados siguen identificados.
4. No ejecutar DROP TABLE, borrar reservas ni eliminar leads como rollback.
   Eliminar el modelo exigiría una entrega separada tras resolver pendientes.

No se ejecutó rollback ni migración en producción. F06-R2 está CERRADO con
`b6ec462` publicado; el cierre requiere Git sincronizado y limpio y no autoriza
continuar con F08/F09/F10.
