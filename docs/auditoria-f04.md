# F04 — Autorización por operación

Fecha: 2026-09-07. Alcance: backend, autorización de comandos. Sin cambios de
sesión/JWT/WebSocket, frontend, dependencias, migraciones ni comisiones.

> **Nota del 2026-09-07.** Los parches, marcadores de checkpoint y logs en `/tmp`
> que cita este informe **ya no existen**: eran temporales de aquella sesión y
> `/tmp` se vacía al reiniciar. No hacen falta. El rollback real de esta entrega
> es `git revert` del commit que la introdujo, y el historial de Git es el
> checkpoint. Se conservan las referencias tal cual porque describen cómo se
> trabajó, no porque haya que ir a buscarlas.

## Checkpoint F01–F03 y última comprobación F03

F01 (build verificable), F02 (importación atómica) y F03 (consistencia financiera)
quedan cerrados. Antes de F04 se conservó una copia y un manifiesto SHA-256 de
los 246 archivos del backend versionados o nuevos, excluyendo secretos y
artefactos. El marcador local `/tmp/crm-f04-baseline-path` apunta a esa copia.
Es un checkpoint lógico del árbol de trabajo, no un commit ni un despliegue.

Se ejecutó nuevamente `consistencia-periodo.integracion.spec.ts`: **22/22**,
contra PostgreSQL descartable local, sin modificar F03.

Orden exacto de `conPeriodoBloqueado` / `transaccionFinanciera`:

1. Fuera de la transacción: resolver año/mes por ID (clave inmutable del lock).
2. Iniciar `$transaction` con `isolationLevel: RepeatableRead`.
3. Intentar `pg_try_advisory_xact_lock(202602, anio * 12 + mes)`.
4. Si está ocupado: abortar con 409. **No espera el advisory lock**.
5. Escritura de control `UPDATE "PeriodoComision" SET "estado" = "estado"`
   por año/mes. No modifica valores ni `updatedAt`, pero crea una versión MVCC.
6. Comprobar que sigue existiendo el ID esperado.
7. Callback: leer el periodo, validar estado/vigencia/firmas, ejecutar escrituras
   y auditoría financiera obligatoria, y confirmar todo junto.

La lectura de negocio sucede **después** de la escritura de control. El test de
snapshot obsoleta pausa una transacción con snapshot anterior; otra aprobación
confirma manteniendo EN_REVISION; la primera toma después el lock, pero su UPDATE
detecta la versión posterior y PostgreSQL aborta con SQLSTATE 40001. Se traduce
a 409 (P2034 o P2010 con causa original 40001). La prueba comprueba también
firmas y datos relacionados. El caso de lock ocupado responde 409 inmediatamente.
Por tanto, no existe una espera silenciosa seguida de trabajo sobre datos viejos.

## Diagnóstico previo a modificar implementación

Suite nueva: `src/common/auth/autorizacion-http.integracion.spec.ts`.
Usa Nest HTTP, JWT firmado real (incluye login real), JwtAuthGuard, RolesGuard,
DTOs y ValidationPipe con las opciones de `main.ts`; services y PostgreSQL reales.
Solo las salidas externas no usadas (R2, Meta, push/gateway) tienen dobles.
La conexión exige `crm_test` en loopback. Los fixtures son ficticios.

Los casos negativos esperan la política correcta y quedan rojos antes del cambio:

Ejecución previa: **16 fallan, 23 pasan (39 casos)**. Se conservaron el log
`/tmp/crm-f04-rojo.log` y la copia anterior a la implementación. Los fallos de
asignación y acceso recibían 200/201, y los de perfil comprobaban el código
alterado en PostgreSQL; no eran fallos de preparación de Nest ni de conexión.

- Perfil deja escribir `codigo` a AGENTE, ADMIN y SUPER_ADMIN, aunque Usuarios
  exige SUPER_ADMIN. `rol` y `activo` ya se eliminaban en el service.
- PATCH de cliente admite reasignar, desasignar y reclamar el pool como AGENTE;
  incluso reenviar el agente efectivo provoca una cascada sobre leads históricos.
- Alta/PATCH de cliente no valida destinatario activo ni privilegio de asignación.
- Actividades.create comprueba destino; update solo comprueba la actividad origen.
  Cambiar cliente sin leadId conserva un lead del cliente anterior.
- Intereses y recategorización admiten paciente ajeno; intereses admite atribuir
  la acción a otra agente.
- Ventas.create valida existencia, pero permite vender sobre paciente ajeno.
- Leads.presencial encuentra por teléfono un paciente ajeno, registra interés y
  crea un lead propio sobre él sin validar acceso al cliente existente.

## Política y matriz antes del cambio

AGENTE opera sobre paciente propio o pool según el agente efectivo de `findOne`
(Cliente.agenteId, con respaldo de Conversacion.agenteId). ADMIN y SUPER_ADMIN
tienen alcance global. Actividades conserva propiedad de agenda; al modificar
relaciones se valida además el cliente destino. La asignación explícita de un
paciente existente exige ADMIN. La gestión de identidad administrativa exige
SUPER_ADMIN. El alta de un paciente nuevo permite asignación inicial propia o pool.

| Operación | Endpoint | Roles permitidos | Recurso origen | Recurso destino | Validación actual | Validación correcta |
| --- | --- | --- | --- | --- | --- | --- |
| Editar perfil | PATCH /auth/perfil | Todos, perfil propio | Usuario JWT | Mismo usuario | DTO administrativo; elimina rol/activo, deja codigo | Lista cerrada nombre/email/password/foto; codigo no escribible |
| Gestionar codigo/rol/activo | PATCH /usuarios/:id | SUPER_ADMIN | Usuario | Usuario destino | RolesGuard SUPER_ADMIN; invariantes Usuarios | Conservar |
| Crear paciente | POST /clientes | Todos | Nuevo cliente | Agente opcional | Sin restricción de asignación/activo | AGENTE solo sí mismo o pool; ADMIN global; destinatario activo |
| Editar ficha | PATCH /clientes/:id | Todos con alcance | Cliente | Mismo cliente | Comprueba alcance | Conservar alcance |
| Reasignar/desasignar | PATCH /clientes/:id (agenteId) | ADMIN+ | Cliente, leads, chat | Usuario activo o pool | Hereda campo de DTO sin rol | Prohibir cambio a AGENTE; valor efectivo repetido se ignora sin cascada |
| Reasignar lead/chat | PATCH /leads/:id/agente; /conversaciones/:id/agente | ADMIN+ | Lead/chat y cliente | Usuario activo | Rol y destinatario activo | Conservar, misma política que ficha |
| Crear actividad | POST /actividades | Todos | Nueva actividad | Cliente y lead opcional | Cliente con alcance, lead del cliente; asignación a activo por ADMIN | Conservar |
| Editar actividad | PATCH /actividades/:id | AGENTE dueño; ADMIN+ global | Actividad | Cliente/lead final | Dueño de actividad; lead solo si llega en DTO | Validar destino con alcance y pertenencia del lead resultante al cliente resultante |
| Estado/eliminar actividad | PATCH /actividades/:id/estado; DELETE /actividades/:id | AGENTE dueño; ADMIN+ global | Actividad | Misma actividad | Propiedad de agenda | Conservar |
| Registrar interés | POST /clientes/:id/intereses | Todos con alcance | Cliente | Interés/agente atribuido | Solo existencia; agenteId libre | Alcance; AGENTE no atribuye a otro; destinatario activo si se especifica |
| Recategorizar | POST /clientes/:id/recalcular-categoria | Todos con alcance | Cliente | Categoría derivada del mismo cliente | Sin alcance | Igual alcance que ficha, fórmula intacta |
| Registrar venta | POST /ventas | Todos con alcance | Cliente | Venta/lead del cliente | Existencia; lead del cliente; comprobante propio | Añadir alcance antes de cualquier escritura; conservar otras validaciones |
| Cambiar venta persistida | PATCH /ventas/:id/estado | ADMIN+ | Venta | Misma venta | RolesGuard ADMIN | Conservar; elegir estado al alta sigue siendo otra operación permitida |
| Alta presencial | POST /leads/presencial | Todos con alcance | Cliente encontrado por teléfono o nuevo | Nuevo lead/interés | No valida alcance de cliente existente | Validar antes de interés/lead; paciente nuevo se asigna al creador |
| Estado de lead | PATCH /leads/:id/estado | AGENTE en alcance; ADMIN+ global | Lead | Mismo lead | Lead propio, sin agente o cliente propio | Conservar política específica existente |

No se agregan guards generales. Los controllers transmiten el alcance calculado
con `alcanceAgente`; los services validan cada operación y destino. Las llamadas
internas de confianza mantienen el parámetro opcional, pero un comando originado
en HTTP ya no pierde su alcance al delegar en otro service.

## Contrato y límites

- 404: recurso/destinatario inexistente, inactivo o fuera del alcance aplicable.
- 403: reasignación/atribución no autorizada o rol insuficiente.
- 400: DTO inválido (sin cambiar el ValidationPipe global).
- Perfil conserva whitelist: los campos administrativos se descartan; un cambio
  permitido en el mismo body sí se realiza. No se añade `forbidNonWhitelisted`.
- Login inactivo y asignación a destinatario inactivo se prueban. La revocación
  de un access token previamente emitido, su tipo y el rol antiguo son F05 y no
  quedan corregidos ni certificados por esta entrega.
- La reclamación automática al responder chats del pool y los efectos de negocio
  de una venta se conservan. No son reasignación administrativa manual.
- Memoria/Plantillas toman la identidad del JWT y comprueban propietario; Usuarios
  ya distingue SUPER_ADMIN. No se amplían sus permisos ni se cambian comisiones.

## Verificación posterior

La suite HTTP termina **50/50**. Se añadieron controles de JWT con firma ajena,
asignación/desasignación administrativa, destinatarios inactivos, propiedad
efectiva desde Conversación, relaciones cliente/lead, preservación de agenda
propia y atribución desde JWT. Cada denegación comprueba que clientes, leads,
chats, actividades, ventas, intereses y auditoría no cambian. Perfil comprueba
también directamente nombre, codigo, rol y activo en PostgreSQL.

La prueba unitaria de perfil ahora incluye `codigo` y verifica que el service
mantiene su lista cerrada incluso sin ValidationPipe. No se simula autorización
ni aislamiento PostgreSQL en la suite HTTP.

| Comprobación | Resultado |
| --- | --- |
| Caracterización antes de implementación | 16 fallan / 23 pasan; fallos funcionales reproducidos |
| HTTP F04 final | 50/50 |
| Unitarios backend completos | 29 suites, 465/465 |
| Todas las integraciones en una invocación | 16 suites pasan; 1 falla: 325/326 casos |
| Financieras en conjunto tras recrear crm_test | 94/97; tres expectativas afectadas por fixtures de otra suite |
| Cada financiera con crm_test recién preparada | 7 suites, 97/97 |
| Typecheck producción | `tsc -p tsconfig.build.json --noEmit --incremental false`: pasa |
| Typecheck suite HTTP y unidad de perfil | Config temporal que incluye ambos specs: pasa |
| Build + check:skills + check:build | Pasa; `dist/main.js` generado, no vacío |
| test:build | 9/9, incluye build limpio, consecutivo y compilador sin emisión |
| Diff y checkpoint | `git diff --check` pasa; F01–F03, manifests y lockfile intactos |

Detalle financiero con base preparada antes de **cada** suite: importación atómica
10; consistencia del periodo 22; foto de configuración 4; diciembre 23;
consolidado 26; tipo A RA 6; catálogo 6. Se aplicaron las 41 migraciones existentes
solo en `crm_test` local, sin cargar `.env`. No hay migraciones nuevas.

### Límite descubierto en la ejecución conjunta

Los tests existentes comparten tablas globales y no todos las limpian al terminar:

1. Servicios deja marzo de 2026 (TC 6,96); diciembre espera que diciembre de 2025
   (TC 6,97) sea el último periodo. Se reprodujo **el mismo fallo en la copia
   previa a F04**, ejecutando Servicios y después diciembre. Log:
   `/tmp/crm-f04-baseline-diciembre.log`.
2. Diciembre deja una vendedora activa que cobra sin vender. Si F03 corre después,
   tres casos que esperan un solo resultado encuentran dos. Las decisiones de
   estado/locks no fallan; falla el tamaño asumido del fixture. F03 pasa 22/22
   con su base limpia, al igual que las demás suites financieras.

No se corrigió esa preparación compartida ni se alteraron sus expectativas para
obtener verde. No se presenta el comando conjunto como exitoso. Logs conservados:
`/tmp/crm-f04-integraciones.log`, `/tmp/crm-f04-financieras.log` y
`/tmp/crm-f04-aislada-<suite>.log`. El ejecutor temporal
`/tmp/crm-f04-financieras-aisladas.py` prepara únicamente crm_test antes de cada suite.

## Archivos de esta entrega

- `src/modules/auth/auth.controller.ts`, `auth.service.ts`, `auth.service.spec.ts`
  y nuevo `dto/update-perfil.dto.ts`.
- `src/modules/clientes/clientes.controller.ts`, `clientes.service.ts`.
- `src/modules/actividades/actividades.service.ts`, `dto/update-actividad.dto.ts`.
- `src/modules/ventas/ventas.controller.ts`, `ventas.service.ts`.
- `src/modules/leads/leads.controller.ts`, `leads.service.ts`.
- Nueva `src/common/auth/autorizacion-http.integracion.spec.ts`.
- `.claude/skills/crm-backend-module/SKILL.md`: se corrige únicamente la excepción
  que recomendaba omitir alcance al delegar de Ventas a Clientes.
- Este informe.

## Cambios deliberados y comportamiento conservado

Se deniegan las operaciones reproducidas que exceden el alcance o el privilegio
del actor. Al cambiar relaciones de una actividad se valida el estado resultante
de cliente y lead; `leadId: null` continúa retirando explícitamente el vínculo.
Reenviar el mismo agente efectivo en la ficha como AGENTE deja de ejecutar una
cascada; editar otros campos sigue permitido. Atribución omitida de un interés
sigue guardándose sin agente, y ADMIN puede atribuirlo a otro usuario activo.

Se conservan roles jerárquicos, pool, alta inicial propia, asignación ADMIN,
propiedad de agenda, comprobantes propios, estado inicial de venta, fórmulas de
categoría, conversión de leads por venta y reclamación automática del chat.
El frontend ya presenta estos errores mediante su manejo de errores HTTP; no se
modificó. Tampoco cambian guard JWT, sesión, WebSocket, arquitectura o dependencias.

La validación de alcance y la escritura siguen siendo pasos separados: no se
introdujo aislamiento ante una reasignación concurrente del cliente o una
desactivación concurrente del destinatario. F04 verifica las rutas indicadas y
sus destinos, no revocación de sesión ni una serialización general de propiedad.

## Rollback

Parche exclusivo F04 guardado en `/tmp/crm-f04.patch`, relativo al backend. Se
verifica `git apply --reverse --check /tmp/crm-f04.patch`; para revertir, ejecutar
después `git apply --reverse /tmp/crm-f04.patch` desde la raíz del backend.
Si el árbol ha cambiado, repetir primero la comprobación. No usar un reset global:
F01–F03 tenían cambios previos sin commit y deben conservarse.

No hay rollback de datos ni migraciones. La reversión reabre los defectos de
autorización de F04. No se desplegó esta entrega ni se consultó producción.
