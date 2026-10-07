# Agenda ScriptCase: auditoría de lectura y contraste del borrador CRM

Fecha: 6 de octubre de 2026, zona America/La_Paz.

**Estado: implementación pausada. Código, tablas, índices y vistas verificados.
La revisión posterior de MySQL resolvió el bloqueo SQL; FileMaker/caja continúa
pendiente. No activar el adaptador ni presentar la landing como conectada.**

La [ampliación SQL](auditoria-agenda-sql-2026-10-06.md) contiene la evidencia
posterior a la primera inspección: horizonte de 30 días; cupos que descuentan
`agenda_med` y no `para_agendar`; inexistencia de `horarios_medico`; cero
triggers/rutinas/eventos; conteos agregados y conexiones externas observadas.

## 1. Alcance y método

El propietario pidió detener la construcción basada en suposiciones y comprobar
el sistema de producción. Esta revisión conserva los cambios locales previos;
no modifica código remoto, configuración, usuarios, servicios ni registros.
Tampoco ejecuta formularios, reservas, pagos, notificaciones, migraciones o despliegues.

- SSH: `montalvo-vps`, servidor `23.95.128.187`. La clave autorizada por el
  propietario fue aceptada desde el entorno del agente con `BatchMode=yes`.
  No se buscó ni utilizó la contraseña de root del sistema operativo.
- Aplicación desplegada: `/var/www/html/clinicaw`.
- Entrada pública conocida: `http://23.95.128.187/clinicaw/medicos/`.
- PHP CLI informa 8.1.32; binario MySQL informa 8.0.44. Se observaron `httpd`,
  `php-fpm` y `mysqld` activos. No se ejecutó el PHP de la aplicación.
- La conexión SQL inicial por socket sin contraseña fue rechazada. Más tarde
  el propietario proporcionó acceso MySQL y se completó la consulta SQL en
  modo READ ONLY por SSH, sin guardar credenciales. Véase la ampliación.
- Se inspeccionaron exclusivamente los metadatos SDI de las siete tablas
  `clinica/*.ibd` usando `ibd2sdi --type=1`, sin archivos de salida en el servidor.
  Se proyectaron nombres/tipos de columnas, índices y claves foráneas; no se
  extrajeron filas, imágenes ni comprobantes.
- SDI es una lectura no confirmada de metadatos, utilizable con el servidor en
  ejecución; no sustituye la comprobación SQL de vistas, triggers y rutinas.
  Referencia: [manual oficial MySQL 8.0 de ibd2sdi](https://docs.oracle.com/cd/E17952_01/mysql-8.0-en/ibd2sdi.html).
- De los registros PHP solo se obtuvieron conteos de un error concreto, sin
  copiar líneas completas, URLs de pacientes, sesiones ni cuerpos de peticiones.

Las conclusiones distinguen **comprobado**, **riesgo derivado del código** y
**pendiente**. No hay pruebas de escritura o concurrencia en producción.

## 2. Aplicaciones y responsabilidades comprobadas

Las rutas de esta tabla son relativas a `/var/www/html/clinicaw/`.

| Aplicación | Responsabilidad / datos usados |
| --- | --- |
| `medicos` | Búsqueda pública por especialidad; grid de médicos, fotos y horario informativo. Lee `medicos`. |
| `Reserva` | Aplicación interna ScriptCase `form_para_agendar`. Consulta horas y registra en `para_agendar`. |
| `Pagos` | Aplicación interna `form_agendar_pagos`. Recupera la reserva mediante `P_AGE`, muestra cobro y actualiza el mismo registro con comprobante y datos fiscales. |
| `form_medicos` | Administración de `medicos`, incluido precio de consulta y referencia bancaria. |
| `form_horarios` | Administración de `horarios`: hora, día, estado, orden y referencias al médico. |
| `form_pagos_qr` | Administración de `pagos_qr`: banco, referencia al archivo QR y vencimiento. |
| `ver_para_agendar` | Consulta administrativa de reservas en `para_agendar`. |
| `ver_qr` | Consulta de comprobantes asociados a registros de `para_agendar`. |
| `grid_agenda_med` | Lee `agenda_med`, con filtro base `estado = 'CREADO'`. |
| `control` → `grid_agenda_medico` | Acceso del profesional; usa la sesión `v_medico`. La agenda filtra `cod_med` por esa sesión y `estado = 'CREADO'`. No se ensayaron accesos ni permisos. |
| `promociones`, `grid_promociones`, `form_promociones` | Publicación/listado/administración de promociones. |
| `form_resgitro_promos`, `grid_resgitros_promos` | Registro y consulta de interés en promociones, separado de las reservas. El nombre contiene ese error ortográfico en el sistema. |
| `form_para_agendar_copy`, `grid_medicos_copy`, `grid_medicos_1` | Copias/variantes desplegadas. Su uso operativo actual no está demostrado. No eliminarlas. |

Existe también `menu`. La presencia de formularios administrativos no demuestra
por sí sola qué persona o rol tiene acceso a cada uno.

No se encontró en las consultas examinadas una selección independiente de
servicio. No hay una tabla física `servicios`, `especialidades` o `pacientes`
entre las siete tablas revisadas. SQL confirmó que las otras dos estructuras
de `clinica` son vistas de agenda. Esto no describe otras bases o FileMaker.

## 3. Modelo real encontrado

Todas las tablas examinadas usan InnoDB. Los identificadores no son intercambiables.

| Tabla | Identidad y columnas relevantes | Integridad observada en SDI |
| --- | --- | --- |
| `medicos` | `medico_pk INT`; `codigo VARCHAR(50)`; nombre y especialidad `VARCHAR(200)`; estado; fotos; `horario_html TEXT`; `agendar TEXT`; orden; `precio_con DECIMAL(10,2)`; `banco INT` | PK `medico_pk`, sin auto_increment; sin otras claves/índices ni FK observadas. Contiene también campos de acceso y teléfono que no pertenecen al catálogo público. |
| `horarios` | `id_hora INT`; `hora TIME NOT NULL`; `dia VARCHAR(20) NOT NULL`; estado; orden; `medico_pk INT NOT NULL`; `cod_med VARCHAR(20)` | PK auto_increment; FK `medico_pk → medicos.medico_pk`; índice `fk_medico_horario`; otro índice llamado `hora` sobre **id_hora**, no sobre la hora. |
| `para_agendar` | `para_age INT`; médico; fecha DATE; hora TIME; nombre/teléfono/CI/observaciones; estado; nombre médico; fechas de registro; NIT/razón social; precio DECIMAL; banco; `comprobante MEDIUMBLOB`; sucursal | Solo PK `para_age`, sin auto_increment ni FK observadas. No aparece índice único por médico/fecha/hora. Muchos campos de negocio permiten NULL. |
| `agenda_med` | `agendam_pk INT`; `cod_med VARCHAR(20)`; nombre médico; fecha/hora; PAC; paciente/teléfono; seguro; actividad; pago; estado; `relacion_pk VARCHAR(100)`; sucursal | PK auto_increment; sin otras claves/índices ni FK observadas. No hay relación FK declarada con `para_agendar`. |
| `pagos_qr` | `qr_pk INT`; banco; `Qr VARCHAR(200)`; `fecha_vence DATE` | Solo PK, sin auto_increment ni FK observadas. |
| `promociones` | `promo_id INT`; título; fechas; imagen; estado | Solo PK, sin auto_increment ni FK observadas. |
| `resgitros_promos` | `regpro_pk BIGINT`; referencia promoción; fecha/hora; datos de contacto; estado/observaciones | Solo PK, sin auto_increment ni FK observadas. |

No se observaron CHECK en esos metadatos. La comprobación SQL posterior confirmó
los índices y la FK, y encontró **0 triggers, rutinas y eventos** en `clinica`.
La ampliación incluye conteos agregados de calidad y grupos repetidos, sin
extraer registros individuales.

### Objetos SQL comprobados posteriormente

- `vista_horas_libres`: la reserva la consulta por `medico_pk`, `fecha`,
  `estado = 'ACTIVO'`, ordenando `hora_disponible`. Se comprobó que genera
  hoy..hoy+29 y excluye coincidencias en `agenda_med` por código/fecha/hora,
  sin filtrar el estado de esa agenda y sin consultar `para_agendar`.
- `horarios_medico`: el evento de cambio de fecha la consulta como respaldo,
  usando `dia_semana = DAYOFWEEK(fecha)`. La administración escribe en
  **horarios**, no en ese nombre. SQL confirmó que `horarios_medico` **no existe**
  como tabla o vista en `clinica`.
- `v_agenda_web`: calendario interno derivado de `agenda_med`, con nombre y
  teléfono del paciente y duración gráfica fija de 15 minutos. Se inspeccionó
  su definición, no sus datos; no es una vista para exponer al público.

No reconstruir la vista inventando un `horarios menos reservas`: ya conocemos
su SQL, pero falta verificar el escritor externo y las transiciones operativas
de FileMaker. Cambiar el tratamiento de ocupados, anulados o pagos alteraría el
comportamiento existente y requiere una decisión explícita y pruebas aisladas.

## 4. Flujo de reserva y pago comprobado en código

```text
medicos.especialidad (texto de médicos ACTIVO)
  → listado público de médicos
  → Reserva, con P_MEDICO
  → fecha + vista_horas_libres.hora_disponible
  → nombre, teléfono, CI y observaciones
  → precio y banco leídos de medicos
  → INSERT para_agendar, estado inicial PENDIENTE
  → COMMIT
  → aviso de nueva cita por Telegram
  → Pagos, con P_AGE = para_age
  → comprobante + NIT / razón social
  → actualización de para_agendar + estado PAGADO
  → COMMIT
  → aviso por Telegram para verificar el pago
  → pantalla «¡Verificando el Pago! / Nos comunicaremos muy pronto»
  → redirección a clinicamontalvo.net

Validación de caja / reflejo en FileMaker
  → informado por el propietario; mecanismo técnico pendiente de verificar
```

El registro inicial de `PENDIENTE` está en el código de inicialización. El
conteo SQL posterior encontró 35 reservas ATENDIDO y 3 PAGADO en ese momento;
no se consultaron datos identificativos ni el historial de cada transición.

### Especialidad, médico y horario

- El selector usa `SELECT DISTINCT(especialidad) ... WHERE estado = 'ACTIVO'`.
  No se encontró una identidad numérica separada de especialidad.
- `horario_html` es HTML almacenado, no una estructura semanal. La pantalla
  muestra ese contenido y, cuando está vacío, muestra «Disponibilidad a solicitud»
  con enlace a WhatsApp. No existe una columna `modalidad = ONLINE/A_SOLICITUD`
  en los metadatos revisados.
- Esa ausencia de HTML no demuestra por sí sola ausencia de horarios en la BD.
  No debe usarse automáticamente como regla para habilitar o negar cupos.
- `medico_pk` identifica al médico dentro de estas reservas. Las agendas del
  profesional usan `cod_med`/`codigo`. No enlazar ambos sistemas por nombre.
- La hora visible proviene de `hora_disponible`. La consulta devuelve la hora
  como valor y etiqueta; no demuestra un `slotId` independiente y estable.
- La fecha y la hora SQL no llevan zona horaria incorporada. SQL confirmó
  zona SYSTEM con desplazamiento -04 y el horizonte hoy..hoy+29. La vista usa
  CURDATE() del servidor; no convertir fechas civiles mediante UTC por defecto.

### Precio y cobro

- Antes del guardado se leen `medicos.precio_con` y `medicos.banco`, copiándolos
  a la reserva. Por tanto, hay un precio de catálogo y un importe guardado en
  cada reserva: no reemplazar retrospectivamente el segundo por el precio actual.
- El listado público examinado no selecciona `precio_con`, lo que explica por
  qué su presencia en la BD no significa que el paciente lo vea en ese paso.
- `pagos_qr` es un catálogo bancario/QR. No se encontró un proveedor bancario
  ni un webhook de confirmación en el recorrido PHP examinado.
- El comprobante se almacena como BLOB en `para_agendar`, no como un objeto de
  R2 del CRM. El código generado también construye archivos temporales al
  representar documentos; no se abrieron ni copiaron esos archivos.
- El evento posterior a actualizar exige comprobante y asigna **PAGADO**.
  La UI dice que se está verificando y el aviso pide verificar. Traducir ese
  estado a `PAGO_CONFIRMADO` en el CRM sería incorrecto sin validar caja.
- Telegram es un efecto externo existente de reserva y pago. Su función recibe
  nombre y CI, entre otros textos del evento. No se ejecutó ni se copiaron sus
  credenciales, destinatarios o mensajes reales. Una futura integración debe
  contar estos efectos para no duplicar avisos al repetir una operación.

## 5. Hallazgos concretos y límites

| Hallazgo | Evidencia | Consecuencia para integrar |
| --- | --- | --- |
| Error en actualización de horas | `Reserva/form_para_agendar_apl.php:5873,5916,5959` llama a `sc_ajax_combo`; no se encontró definición en el árbol PHP inspeccionado. Logs rotados de PHP registran `Call to undefined function sc_ajax_combo()`. | Existe evidencia histórica del fallo, además del código actual. No convertir un fallo de consulta en «sin cupos». No se provocó un error nuevo en producción. |
| Respaldo de disponibilidad inexistente | Evento de fecha, líneas 5920–5924: consulta `horarios_medico.dia_semana`. El formulario de administración y SDI muestran `horarios.dia`. SQL confirmó que `horarios_medico` no existe en `clinica`. | No copiar ese respaldo al adaptador. Su ausencia es otro fallo de código, no evidencia de falta de cupos. |
| Identificador calculado con MAX+1 | `Reserva/form_para_agendar_apl.php:5209–5222`; SDI confirma `para_age` sin auto_increment. | Riesgo de colisión con escritores concurrentes. La PK impide IDs repetidos, pero no hace seguro el cálculo ni garantiza un reintento correcto. No se simuló concurrencia contra producción. |
| Sin unicidad de cupo | `para_agendar` y `agenda_med` solo tienen sus PK, confirmado por SQL. No hay triggers en `clinica`. No se localizaron bloqueos SQL explícitos en los PHP de negocio escaneados. | No hay evidencia suficiente para garantizar reserva atómica. Falta inspeccionar el escritor externo antes de habilitar web/WhatsApp como escritores adicionales. La ampliación documenta grupos repetidos sin atribuirlos automáticamente a errores. |
| Estado de pago ambiguo | `Pagos/form_agendar_pagos_apl.php:5520–5524`; UI `form_agendar_pagos_form0.php:407–408`. | PAGADO del legado no prueba validación bancaria/caja. |
| Dos representaciones de agenda | Reserva escribe `para_agendar`; grids clínicos leen `agenda_med`. | No son aliases de una misma tabla ni se ha demostrado cómo se sincronizan. |
| Identificadores médicos distintos | `medico_pk`, `codigo`, `cod_med`; solo `horarios.medico_pk` tiene FK observada. | Falta validar correspondencia, unicidad y escritores antes de sincronizar. |
| Campos de sucursal existentes | SDI de `para_agendar` y `agenda_med`; la inserción pública examinada no incluye `sucursal`. | No asumir sede única ni añadir selección pública sin saber quién la completa. |
| Catálogo con HTML y campos privados | `medicos.horario_html`, `agendar`, campos de acceso y teléfono. | La futura lectura pública debe proyectar campos explícitos. Nunca transmitir la fila completa o ejecutar HTML heredado en la landing. |

No se corrigieron estos hallazgos en el VPS. La falta de normalización observada
no autoriza migrar ni fusionar tablas que pueden ser consumidas por FileMaker.

## 6. FileMaker: lo sabido y lo desconocido

**Información aportada por el propietario:** la reserva/pago se refleja en
FileMaker y pasa a caja para confirmar. Se conserva como requisito operativo,
no como un mecanismo técnico demostrado por esta revisión.

**Comprobado en el VPS:**

- `agenda_med` contiene PAC, actividad, seguro, pago, `relacion_pk` y sucursal.
- Los grids leen esa tabla y filtran registros CREADO.
- La reserva pública escribe `para_agendar`.
- La búsqueda en PHP de negocio inspeccionado no encontró referencias a
  FileMaker/Data API, llamadas ODBC ni escrituras SQL explícitas a `agenda_med`.
  Se excluyeron librerías genéricas de proveedores para no confundir soporte
  instalado con una integración utilizada.
- No se encontraron referencias a clínica/agenda/FileMaker/MySQL/PHP en las
  entradas cron examinadas. Esto no excluye procesos externos ni otras tareas.
- SQL confirmó cero triggers/rutinas/eventos en `clinica`, patrones normalizados
  de INSERT/UPDATE de agenda y tres conexiones remotas `libmariadb`. No identifica
  todavía el programa externo. `relacion_pk` no coincide textualmente con
  `para_age`; no son IDs intercambiables.

**No comprobado:** si FileMaker lee MySQL mediante ESS/ODBC, usa un script de
importación, un proceso intermedio u otro mecanismo; quién escribe `agenda_med`;
qué significa `relacion_pk`; dirección, frecuencia e idempotencia; quién
confirma en caja; y qué estados devuelve al VPS.

No afirmar «FileMaker recibe por ODBC» ni «para_age = relacion_pk» sin la
configuración/script real o un contrato verificado. No se accedió a FileMaker.

## 7. Fuentes y copias: límites actuales

| Dominio | Fuente comprobada para este recorrido | Copias / consumidores / límite |
| --- | --- | --- |
| Especialidades públicas de agenda | Texto en `clinica.medicos.especialidad`, filtrado por activo | ScriptCase público. El directorio editorial CRM tiene su propia entidad y no es un reemplazo demostrado. |
| Identidad y precio del médico en reserva | `clinica.medicos` | La reserva copia precio, banco y nombre. Origen externo de los códigos aún no comprobado. |
| Horario editable | `clinica.horarios`, administrado por ScriptCase | La vista cruza el día semanal con hoy..hoy+29. El consumidor filtra estado ACTIVO. |
| Cupos consultables | Resultado de `vista_horas_libres` usado por ScriptCase | SQL verificado: descuenta ocupación de `agenda_med`, no reservas de `para_agendar`. Escritor externo aún pendiente; no reconstruir en PostgreSQL. |
| Reserva pública | `clinica.para_agendar` | ScriptCase Reserva/Pagos, listados y comprobantes. |
| Agenda clínica mostrada al médico | `clinica.agenda_med` | Grids clínicos. Fuente que escribe la tabla aún desconocida. |
| Comprobante y estado de carga | `para_agendar.comprobante` y estado | PAGADO en este evento significa carga para verificación; confirmación de caja pendiente de mapear. |
| QR bancario | `clinica.pagos_qr`; referencia `medicos.banco` copiada a reserva | Distinto de los QR y pagos de promociones del CRM. |
| Interés en promociones | `resgitros_promos` | Flujo ScriptCase separado; no equivale automáticamente a Lead/Venta CRM. |
| Paciente/PAC | PAC aparece en `agenda_med`; la reserva pública pide CI y contacto | No se ha demostrado una identidad común ni autorización para fusionar fichas. |

El CRM puede actuar como frontera de integración sin convertirse en otro dueño
de los catálogos operativos. No se implementó sincronización bidireccional.

## 8. Contraste de las siete piezas locales NestJS

Son seis archivos nuevos y una modificación de `src/app.module.ts`. Se conservan
íntegros como borrador. Esta tabla corrige el diseño documental; no activa código.

| Pieza | Qué presupone hoy | Contraste y decisión respaldada |
| --- | --- | --- |
| `agenda.contrato.ts` | Especialidad con ID propio; médico con modalidad; slot con ID; horario textual; estados normalizados, ventana de 90 días y timestamps recientes. | SQL confirmó hoy..hoy+29: el horizonte de 90 días es incompatible. Especialidad es texto; médico tiene PK INT y código separado; horario informativo es HTML; disponibilidad devuelve horas sin slotId. Modalidad, timestamps y versión siguen siendo propuestas. Los máximos de 160 caracteres son inferiores a VARCHAR(200). Conservar proyección pública y conversión exacta de DECIMAL, sin activar el contrato como traducción validada. |
| `dto/query-agenda.dto.ts` | `especialidadId`/`medicoId` con patrón alfanumérico; fecha ISO. | La validación de fecha es reutilizable; no acepta directamente nombres de especialidad con espacios/acentos. Hace falta una traducción estable y reversible que no cree otro catálogo maestro. `medico_pk` y `codigo` no pueden confundirse. |
| `agenda-vps.client.ts` | Servidor HTTPS con GET JSON, Bearer y endpoints especialidades/medicos/disponibilidad. | No se ha verificado un servicio con ese contrato en el VPS. Lo encontrado es PHP ScriptCase con sesiones y SQL. Conservar límites de tiempo/tamaño, destino fijo y ausencia de reintentos ciegos como requisitos; el transporte concreto queda bloqueado. No sustituirlo por scraping de sesiones ni conectar el navegador a MySQL. |
| `agenda.service.ts` | Listados paginados remotos, caché de catálogo 30 s, consulta de disponibilidad sin caché. | Son decisiones de integración, no capacidades verificadas de ScriptCase. La fuente debe seguir siendo VPS/vista real; no usar como respaldo cupos del directorio CRM ni presentar error como catálogo vacío. El servicio no registra reservas y no demuestra consistencia de escritura. |
| `agenda-publica.controller.ts` | Tres rutas GET públicas en el CRM. | La lectura pública con campos permitidos es compatible con el objetivo, pero esas rutas locales no prueban una conexión real. No añadir pagos, pacientes o comprobantes públicos a este contrato. |
| `agenda.module.ts` | Módulo de lectura exportable al resto del CRM. | El límite de módulo es compatible con centralizar acceso. No demuestra que servicios existentes ya consuman la agenda ni autoriza nuevas escrituras. |
| `src/app.module.ts` | Importa/registra `AgendaModule`. | El borrador está incorporado al árbol local, pero la lectura depende de `AGENDA_VPS_LECTURA=on` y configuración adicional. No se cambió esa configuración ni se desplegó. No confundir «registrado localmente» con «integrado». |

Los límites de concurrencia, tamaño, caché y frescura del borrador no fueron
dimensionados contra la carga real; tampoco constituyen garantías de escala.
No se prometen «cero deuda» ni disponibilidad transaccional con esta evidencia.

## 9. Corrección del plan, sin implementación

1. Mantener ScriptCase/MySQL como sistema operativo actual. No normalizar ni
   replicar sus tablas mientras FileMaker y sus escritores estén sin mapear.
2. **Completado:** lectura de las dos vistas, índices/FK por SQL y ausencia de
   `horarios_medico`, triggers y eventos/rutinas en `clinica`. Resultados en la
   ampliación SQL; preservar los hashes de las vistas para futuras verificaciones.
3. Verificar el componente externo de FileMaker y el recorrido hasta caja.
4. Definir la traducción de IDs, precios, estados y disponibilidad a partir de
   esas reglas. Los esquemas SQL no deben convertirse sin filtro en API pública.
5. Solo después seleccionar e implementar el acceso de solo lectura desde el
   CRM. La API GET/Bearer propuesta no se considera existente.
6. Comprobar equivalencia con ScriptCase usando fixtures sintéticos y consultas
   seguras. Tratar error, ausencia de atención y ausencia de cupos como estados
   distintos únicamente cuando la fuente permita distinguirlos.
7. La escritura futura de reservas/pagos requiere además demostrar concurrencia,
   idempotencia, confirmación de caja y efectos externos. No forma parte de esta
   auditoría ni está autorizada por el simple acceso SSH.

La landing queda tal como estaba localmente: accesos al VPS y WhatsApp,
prototipos y consumidor de agenda preparados pero sin una integración real
verificada. No reanudar su implementación por detectar datos en esta auditoría.

## 10. Pendientes concretos

1. **Resuelto:** acceso SQL y verificación de vistas, triggers, eventos e índices,
   mediante sesión de solo lectura por SSH. Credenciales no guardadas en archivos.
2. Código/configuración del enlace FileMaker y de caja: propietario de cada
   escritura, equivalencias de IDs y estados, comportamiento ante reintentos.
3. Significado y cálculo de `agendar`, `relacion_pk`, sucursal, estados de
   cancelación y liberación de horas. No hay evidencia suficiente para definirlos.
4. Horizonte y exclusión por ocupación ya comprobados: 30 días y lectura de
   `agenda_med` sin filtrar sus estados. PENDIENTE/PAGADO de `para_agendar` no
   intervienen directamente. Sigue pendiente la lógica externa de bloqueos,
   cambios/cancelaciones y creación de ocupación a partir de una reserva.
5. Validación de los accesos administrativos y del enlace de pago. La presencia
   de `P_AGE` no basta para afirmar autorización por reserva; no se ensayó acceso
   a datos ajenos.

## 11. Evidencias para retomar

Todas estas referencias pertenecen al **VPS**, no a archivos versionados aquí:

| Referencia | Evidencia |
| --- | --- |
| `medicos/grid_medicos_pesq.class.php:1810` | Especialidades DISTINCT de médicos ACTIVO. |
| `medicos/grid_medicos_grid.class.php:536` | Columnas del grid público, sin precio. |
| `Reserva/form_para_agendar_apl.php:3980` | Consulta de `vista_horas_libres`. |
| `Reserva/form_para_agendar_apl.php:4453` | Lectura de horario HTML y nombre. |
| `Reserva/form_para_agendar_apl.php:4742` | Precio y banco antes de persistir. |
| `Reserva/form_para_agendar_apl.php:5209` | Identificador MAX+1. |
| `Reserva/form_para_agendar_apl.php:5270` | Inserción de la reserva. |
| `Reserva/form_para_agendar_apl.php:5471` | Commit, aviso Telegram y navegación a pagos. |
| `Reserva/form_para_agendar_apl.php:5786` | Estado inicial PENDIENTE. |
| `Reserva/form_para_agendar_apl.php:5865` | Evento de cambio de fecha y respaldo de horarios. |
| `Pagos/form_agendar_pagos_apl.php:5482` | Validación de comprobante posterior a actualizar. |
| `Pagos/form_agendar_pagos_apl.php:5520` | Asignación PAGADO. |
| `Pagos/form_agendar_pagos_apl.php:5558` | Aviso para verificación humana. |
| `Pagos/form_agendar_pagos_form0.php:401` | Mensaje de verificación y redirección. |
| `grid_agenda_med/index.php:3276` | Filtro CREADO. |
| `grid_agenda_medico/index.php:3314` | Filtro por código del profesional y CREADO. |

SHA-256 de fuentes leídas para detectar cambios antes de retomar:

```text
Reserva/form_para_agendar_apl.php
045960117f4772c87c6f43dd5cfd905fbdf046844bdd20bc2e8d40265ff4e0ce
Pagos/form_agendar_pagos_apl.php
c820f1a518ecffc954edda1e5597070a9f5dfa283469a5cca985a31775e537a4
medicos/grid_medicos_pesq.class.php
1cc4e377c3a235b6164e0ce7528ea8595856bc97e5606c3aff4cea8ae26c152d
form_horarios/form_horarios_apl.php
bd2dfb7c438d94bcf74b173e9427bad8afcfa059eda794f12069008c870c9223
```

Errores históricos: se encontraron 14 coincidencias de función indefinida
`sc_ajax_combo()` en los últimos 512 KiB de cuatro logs rotados de PHP
(20260913, 20260920, 20260927, 20261004). No es el total histórico del sistema
ni una medición de fallos actuales.

Esta fase solo añade documentación local. No ejecuta los borradores, pruebas
de integración, build o cambios de código: esos artefactos siguen sin una
validación final y no son una entrega lista para desplegar.
