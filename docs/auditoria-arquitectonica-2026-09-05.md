# Auditoría arquitectónica y de coherencia — CRM Clínica Montalvo

> Diagnóstico histórico anterior a las correcciones F01–F06. Para el estado
> verificado actual, leer [ESTADO_ACTUAL.md](ESTADO_ACTUAL.md). Los identificadores
> F01–F10 de §3 son hallazgos; las entregas 0–9 de §19 usan otra numeración.

Fecha: 5 de septiembre de 2026. Primera fase: diagnóstico; **sin modificaciones de código, dependencias, migraciones ni producción**.

Convenciones de rutas: `B/` = `backend-crm-montalvo/`; `F/` = `frontend-crm-montalvo/`. Las líneas corresponden al árbol de trabajo examinado, no necesariamente al último commit. Había cambios locales previos en [B/package.json](<B/package.json>), [B/package-lock.json](<B/package-lock.json>), [B/src/main.ts](<B/src/main.ts>), [F/package.json](<F/package.json>) y [F/package-lock.json](<F/package-lock.json>).

## 1. Veredicto general

**Aceptable, con deriva localizada y riesgos importantes de consistencia.**

La organización general sigue siendo comprensible: monolito Nest, Prisma directo y Angular por funcionalidades.
No encontré una proliferación de repositories, capas ceremoniales ni ciclos entre módulos Nest.
Existen buenas decisiones de dominio y pruebas sustanciales del cálculo de comisiones.
La principal deuda está en las fronteras: autorización, atomicidad, trabajos asíncronos y sincronización de UI.
Algunas garantías escritas en comentarios no se cumplen de extremo a extremo.
Hay operaciones que funcionan secuencialmente pero pueden fallar bajo concurrencia o interrupción.
La suite protege mucho mejor reglas y servicios que transporte HTTP, sesión, PWA y páginas Angular.
Los síntomas de desarrollo incremental aparecen más como soluciones incompletamente conectadas que como exceso de archivos.
No recomiendo una reescritura ni imponer Clean Architecture o Repository Pattern.
Recomiendo corregir primero integridad, permisos y verificabilidad; después simplificar el estado y las responsabilidades compartidas.

### Alcance y grado de certeza

Se inventariaron ambos árboles fuente, configuraciones, dependencias resueltas, 29 modelos y 41 migraciones; se revisaron reglas del repositorio, documentación operativa y técnica, infraestructura compartida, tests y los flujos descritos abajo. La lectura detallada se concentró en los caminos críticos y en contrastar implementaciones equivalentes. **No es una certificación de cada línea del repositorio ni de ausencia de otros defectos.**

Se distinguen:

- **Reproducido:** observado al ejecutar código local, con dobles en memoria cuando procede.
- **Demostrado por código:** existe una secuencia concreta que conduce al problema; no se provocó sobre datos reales.
- **Condicionado:** la implementación tiene el límite o riesgo indicado, pero su frecuencia o coste requiere medir producción.

No se consultó producción, no se ejecutó `EXPLAIN ANALYZE` ni se verificó el estado efectivo de sus índices, backups o servidor. Las cifras operativas del skill de infraestructura son evidencia documental fechada, no mediciones nuevas. No se usó navegador, conforme a las reglas locales; accesibilidad y PWA se revisaron estáticamente.

## 2. Mapa arquitectónico real

### Frontend

Angular 21.2, standalone, OnPush, zoneless, TypeScript estricto, Tailwind 4. Hay 15 carpetas de funcionalidades y 67 componentes, contando páginas y componentes compartidos.

```text
app.config / router / autenticación
  → layout compartido
  → ruta de funcionalidad cargada dinámicamente
  → página: filtros, formularios, recursos y orquestación
  → servicio de funcionalidad: URLs y operaciones
  → ApiService.request → httpResource → interceptores → HTTP
    o ApiService.post/patch/get → HttpClient → Promise
```

Las lecturas reactivas suelen vivir en `httpResource`; los comandos devuelven promesas. RxJS se usa para HTTP, interceptores y adaptación de rutas, lo que tiene sentido. No hay una necesidad general de sustituirlo.

`core` agrupa autenticación, API, moneda, notificaciones, PWA, toast y tiempo real. `shared` contiene controles y composición visual. El estado de Conversaciones es una excepción: vive en un servicio **root** con recursos remotos, formularios y decisiones visuales. Finanzas combina páginas en pestañas que se conservan montadas.

El API client es útil, aunque su comentario de «única puerta HTTP» es más amplio que la realidad: `httpResource` ejecuta peticiones construidas por él y Auth usa `HttpClient` directamente. Esto no justifica añadir otra capa.

La precarga es global (`PreloadAllModules`) y el service worker incluye `/*.js` en `prefetch`. Hay separación de chunks, pero no una garantía de descargar exclusivamente lo visitado. Se registran dos scripts de service worker para el mismo alcance raíz; ver F09.

### Backend

NestJS 10.4.22, Prisma 7.10 con adaptador PostgreSQL, CommonJS, un único proceso según la documentación operativa.

```text
Apache/TLS (documentado)
  → Nest/Express
  → ThrottlerGuard → JwtAuthGuard → RolesGuard
  → ValidationPipe / DTO
  → controller → service → PrismaService → PostgreSQL
  → LoggingInterceptor o AllExceptionsFilter
```

Los 13 dominios son: actividades, auth, clientes, conversaciones, kpis, leads, memoria-agente, planilla-comisiones, plantillas-agente, servicios, tipo-cambio, usuarios y ventas. Son 19 módulos Nest contando raíz e infraestructura.

No existe una capa repository general. Los services consultan Prisma directamente, con selectores y agregaciones locales. Prisma, auditoría y push son globales; JWT también se registra globalmente. `ClientesService` actúa, además, como coordinador de propiedad de clientes, leads y conversaciones. Los módulos de analítica consultan varios modelos directamente.

WhatsApp se divide en controlador de webhook, ingesta, acuses, media entrante, despacho saliente y cliente Cloud API. Es una separación razonable de responsabilidades. El gateway de Conversaciones ya es infraestructura de tiempo real compartida con Actividades.

Los trabajos periódicos usan `setInterval`; las tareas de webhook y envío usan promesas en segundo plano. **No hay una cola persistente que garantice recuperación tras reinicios.**

### Base de datos

- `Cliente` es la identidad comercial/paciente; `Lead` representa una oportunidad y puede haber varias por cliente.
- `Conversacion` es única por cliente; `Mensaje.whatsappMsgId` es único para deduplicación.
- `Venta` representa la operación comercial del CRM. `VentaImportada` representa filas de FileMaker para liquidación e historial. Son dominios distintos, no tablas duplicadas a eliminar.
- `Usuario.codigo` y `VendedoraComision.codigo` vinculan identidad de acceso y nómina sin FK directa entre esas entidades.
- `PeriodoComision`, `AprobacionPeriodo`, configuración y `ResultadoComision` conservan liquidaciones, estados y datos explicativos.
- `Actividad` pertenece obligatoriamente a cliente y agente; el lead es opcional.
- Hay índices B-tree, GIN trigram e índices/constraints específicos en migraciones, incluido el único parcial de objetivos por defecto.

### Flujos end-to-end

Los saltos son transiciones entre responsabilidades principales hasta persistencia, no cada getter, DTO o import. El retorno añade serialización, interceptores y actualización de UI. Contarlos de otra forma produciría cifras diferentes.

| Flujo | Camino real y saltos aproximados | Evaluación |
| --- | --- | --- |
| Buscar pacientes | Página → ClientesService frontend → request/API → HTTP y guards/DTO → controller → ClientesService backend → Prisma → PostgreSQL: 7 | Claro. Paginación y búsqueda están en servidor. El formulario vuelve a implementar transformaciones de ficha presentes en el chat. |
| Enviar WhatsApp | Composer/estado → servicio frontend → API/HTTP → controller → ConversacionesService → Prisma → PostgreSQL: 6–7; rama adicional despacho → Cloud API → Meta | La rama externa es necesaria. La claridad se pierde en reclamación de propiedad fuera de la transacción y tareas `void`. La confirmación de Meta vuelve por otro webhook y el comparador Angular puede ignorarla. |
| Recibir WhatsApp | Meta → guard de firma/controller → ingesta → ClientesService → Prisma/PostgreSQL; después Mensaje/transacción → gateway/push → cliente realtime → recurso → UI: aproximadamente 10 | La mayoría de saltos están justificados. El ACK HTTP precede al almacenamiento durable. El aviso genérico acaba interpretado como mensaje entrante en frontend. |
| Reasignar chat/lead | UI → servicio/API → controller → servicio de Conversaciones o Leads → ClientesService.update → Prisma → PostgreSQL: 7 | El salto a Clientes evita duplicar escrituras, pero el nombre `update` oculta que cambia tres dominios. Los services de origen validan agente por separado. |
| Registrar venta | Página → servicio/API → controller → VentasService → Prisma → PostgreSQL; después categoría y leads vía otros services: 6 + dos ramas | Las ramas son negocio real. Su ejecución fuera de una unidad atómica permite ventas guardadas con efectos incompletos y respuesta de error. |
| Importar/calcular/cerrar comisiones | Página → servicio/API → controller → planilla/parser/configuración o cálculo → Prisma → PostgreSQL: 6–8 según acción | Parser y motor tienen valor. La responsabilidad del service de planilla es demasiado amplia. El reemplazo y la máquina de estados no tienen protección suficiente frente a fallos/concurrencia. |
| Crear/recordar actividad | Página o sidebar → servicio/API → controller → ActividadesService → validación Cliente → Prisma → PostgreSQL: 7; temporizador → Push/Gateway → campana | Es razonable reutilizar el canal realtime. Hay diferencias de autorización entre crear y editar, y el calendario no consume todas las actividades. |
| Login/refresco | Página → AuthService frontend → interceptor/HTTP → AuthController → AuthService → UsuariosService → Prisma/PostgreSQL → JWT/cookie → storage/UI: 7–8 | No sobran capas. El contrato de credenciales, errores y revocación diverge entre HTTP, socket y documentación. |

## 3. Top 10 problemas encontrados

P0: puede comprometer integridad, acceso o disponibilidad. P1: problema importante de escala o funcionamiento operativo. P2: deuda de mantenimiento. P3: mejora menor. La prioridad expresa consecuencia potencial, **no prueba de que haya ocurrido un incidente**.

| Prioridad | Problema | Evidencia | Impacto | Riesgo de cambiarlo | Acción |
| --- | --- | --- | --- | --- | --- |
| P0 · F01 | Build exitoso sin artefacto ejecutable | [B/nest-cli.json:6](<B/nest-cli.json:6>), [B/tsconfig.json:24](<B/tsconfig.json:24>); dos ejecuciones terminan 0 sin `dist/main.js` | Un despliegue puede borrar la salida y reiniciar sin aplicación | Bajo–medio | Corregir interacción de limpieza/incremental y exigir existencia del entrypoint en cada build |
| P0 · F02 | Reimportación no atómica | [B/src/modules/planilla-comisiones/planilla-comisiones.service.ts:201](<B/src/modules/planilla-comisiones/planilla-comisiones.service.ts:201>), `:227`, `:283` | Fallo después del borrado deja el periodo vacío o parcialmente importado | Alto | Preparar y validar antes; publicar el reemplazo completo en una unidad transaccional |
| P0 · F03 | Cierre, pago y recálculo usan estado leído previamente | [B/src/modules/planilla-comisiones/planilla-comisiones.service.ts:692](<B/src/modules/planilla-comisiones/planilla-comisiones.service.ts:692>), `:767`, `:795`; [B/src/modules/planilla-comisiones/calculo-comisiones.service.ts:217](<B/src/modules/planilla-comisiones/calculo-comisiones.service.ts:217>) | Reapertura concurrente con pago, cifras cambiadas durante revisión o cierre sobre datos distintos | Alto | Serializar por periodo o usar versión/condición de estado con manejo de conflicto |
| P0 · F04 | Autorización distinta según puerta de entrada | [B/src/modules/auth/auth.service.ts:140](<B/src/modules/auth/auth.service.ts:140>); [B/src/modules/actividades/actividades.service.ts:275](<B/src/modules/actividades/actividades.service.ts:275>); [B/src/modules/clientes/clientes.controller.ts:42](<B/src/modules/clientes/clientes.controller.ts:42>) | Campo administrativo editable en perfil; relaciones hacia pacientes ajenos; mutaciones sin alcance | Medio | DTO de perfil explícito y comprobación de destino/alcance en todos los comandos |
| P0 · F05 | Contrato de sesión incompleto | [B/src/common/guards/jwt-auth.guard.ts:38](<B/src/common/guards/jwt-auth.guard.ts:38>); [B/src/modules/auth/auth.controller.ts:87](<B/src/modules/auth/auth.controller.ts:87>); [F/src/app/core/auth/auth.service.ts:167](<F/src/app/core/auth/auth.service.ts:167>) | Refresh aceptado como access; token de refresco expuesto en JSON; logout por fallos transitorios; permisos antiguos siguen válidos | Medio–alto | Separar tipos de token y errores; definir revocación; cubrir REST y socket |
| P0 · F06 | Trabajo en segundo plano sin garantía de recuperación y rechazos sin capturar | [B/src/modules/conversaciones/conversaciones.service.ts:755](<B/src/modules/conversaciones/conversaciones.service.ts:755>); [B/src/modules/conversaciones/despachador-saliente.service.ts:160](<B/src/modules/conversaciones/despachador-saliente.service.ts:160>); [B/src/modules/actividades/actividades.service.ts:120](<B/src/modules/actividades/actividades.service.ts:120>) | Reinicio, mensaje pendiente perdido o caída del proceso si Prisma rechaza fuera de HTTP | Medio–alto | Primero capturar fallos; luego recepción/despacho durable con estado y reintento controlado |
| P1 · F07 | El estado Angular puede ignorar entregas, media y cambios de ficha | [F/src/app/features/conversaciones/services/conversaciones-state.service.ts:175](<F/src/app/features/conversaciones/services/conversaciones-state.service.ts:175>); [B/src/modules/conversaciones/conversaciones.service.ts:784](<B/src/modules/conversaciones/conversaciones.service.ts:784>) | La red trae cambios que no llegan al hilo visible | Medio | Revisar igualdad semántica y probar respuesta con mismo chat/fecha/cantidad y distinto mensaje |
| P1 · F08 | Respuestas antiguas sobrescriben selección/filtros nuevos | [F/src/app/features/planilla-comisiones/planilla-comisiones.page.ts:1206](<F/src/app/features/planilla-comisiones/planilla-comisiones.page.ts:1206>); [F/src/app/features/conversaciones/services/conversaciones-state.service.ts:413](<F/src/app/features/conversaciones/services/conversaciones-state.service.ts:413>) | Consolidado de otro mes, páginas ajenas al filtro; error presentado como falta de cálculo | Medio | Recursos ligados a claves o descarte por generación; estado explícito de error |
| P1 · F09 | Dos implementaciones de PWA compiten por el mismo scope | [F/src/app/app.config.ts:42](<F/src/app/app.config.ts:42>); [F/src/app/core/notification/notificacion-nativa.service.ts:66](<F/src/app/core/notification/notificacion-nativa.service.ts:66>); [F/public/sw.js:1](<F/public/sw.js:1>) | Push y caché/actualizaciones pueden sustituirse mutuamente | Medio–alto | Un único registro/script que integre las responsabilidades |
| P1 · F10 | Calendario e historiales cortados como si fueran completos | [F/src/app/features/actividades/actividades.page.ts:263](<F/src/app/features/actividades/actividades.page.ts:263>); [B/src/modules/servicios/servicios.service.ts:317](<B/src/modules/servicios/servicios.service.ts:317>) | Actividades o servicios desaparecen del resultado; totales calculados sobre un corte | Medio | Consulta por rango visible, paginación real y agregados separados del detalle |

### F01 — Build: evidencia y límite

`npm run build` se ejecutó dos veces en backend. Ambas devolvieron 0; después de ambas no existían `dist` ni `dist/main.js`. `deleteOutDir: true` convive con `incremental: true` y `tsconfig.build.tsbuildinfo` fuera de `dist`. La compilación con `tsc -p tsconfig.build.json --outDir /tmp/crm-audit-backend-dist --tsBuildInfoFile /tmp/crm-audit-backend.tsbuildinfo` sí generó `main.js` y pasó.

El resultado es reproducible **en este checkout** y compatible con una caché incremental que sobrevive a la limpieza. No atribuyo el mismo estado al servidor. El control correcto es probar dos builds consecutivos y verificar el artefacto, no solo el exit code. La prueba inicial de reproducción sobre `dist` falló por su ausencia; las reproducciones de negocio posteriores usaron el build aislado.

### F02/F03 — Integridad financiera

En importar, el `upsert` del periodo se confirma antes de borrar las ventas y resultados. La transacción cubre los dos borrados, pero no los `createMany` posteriores. Basta un fallo en un lote para perder la versión anterior sin haber publicado una nueva completa. Además, los ajustes se leen antes del reemplazo y pueden competir con otra edición.

En cerrar/pagar/reabrir, validar una transición en un SELECT no protege un UPDATE posterior cuyo `where` solo contiene `id`. Ejemplo: pago y reapertura leen ambos CERRADO; el último UPDATE gana, aunque PAGADO debería ser terminal. El cálculo también valida editabilidad al inicio y escribe CALCULADO después de múltiples lecturas y cómputos.

Hay otro caso secuencial: `ajustarVenta` cambia las entradas pero no invalida el estado CALCULADO ni elimina resultados previos. Posteriormente `enviarARevision` comprueba alertas y cantidad de resultados, no que correspondan a la última edición. Una exclusión con motivo puede dejar una liquidación anterior aprobable. **Hace falta representar que cambió la base del cálculo**, además de proteger la concurrencia.

Protección existente: `cierre-periodo.spec.ts`, `estados-periodo.spec.ts`, `ajustar-venta.spec.ts`, `foto-configuracion.integracion.spec.ts`, `verificacion-diciembre.integracion.spec.ts`. Faltan fallos entre lotes, edición después de calcular y transiciones concurrentes contra PostgreSQL.

### F04 — Tres ejemplos verificables de autorización

1. `AuthService.updatePerfil` elimina `rol` y `activo`, pero propaga `codigo` de `UpdateUsuarioDto`. La gestión de códigos exige SUPER_ADMIN en Usuarios y la UI, pero `/auth/perfil` no. La reproducción pasó `{codigo: 'audit-payroll-code'}` al servicio de usuarios. La unicidad evita robar un código ya ocupado; no impide elegir uno libre o romper la vinculación propia.
2. `ActividadesService.create` valida el alcance del cliente, pero `update` comprueba solo la propiedad de la actividad. Cambiar `clienteId` sin `leadId` evita toda validación del cliente destino. La respuesta incluye datos básicos de ese cliente. También puede quedar un lead anterior vinculado a un cliente distinto. Reproducido con un doble que habría rechazado consultar el cliente ajeno: nunca fue llamado.
3. Clientes valida alcance en GET/PATCH, pero `registrarInteres` y `recalcularCategoria` no reciben usuario/alcance. `UpdateClienteDto` hereda además `agenteId`; un agente con acceso a una ficha puede activar la cascada de reasignación por esa puerta, mientras los endpoints específicos de reasignación exigen ADMIN. `VentasService.create` verifica existencia del cliente sin alcance, otra divergencia frente a Actividades.

No se explotaron endpoints reales. Las pruebas actuales cubren partes distintas: perfil protege rol/activo; Actividades protege edición de una actividad ajena, no el cambio de destino de una propia; Clientes cubre lecturas/edición de ficha. Primero ampliar esos casos y añadir pruebas del transporte con guards/pipes reales.

### F05 — Sesión

La reproducción firmó un token ficticio `{sub, type:'refresh'}` con `JwtService` y lo entregó al guard real: fue aceptado. REST verifica firma/expiración, pero no tipo ni estructura de payload. Los endpoints con `@Roles` rechazan un rol ausente; **esto no supone acceso automático de administrador**, pero sí permite usar el refresh en endpoints autenticados sin requisito de rol. El gateway repite la aceptación por firma.

El controller de login establece cookie HttpOnly y después devuelve el objeto completo, incluido `refresh_token`. Por tanto, la credencial también aparece en JSON accesible al JavaScript que recibe el login. El beneficio de transportarla exclusivamente por cookie no se cumple.

Los access tokens duran 8 horas. Ni guard ni gateway comprueban usuario activo/rol actual contra la base; desactivar o degradar una cuenta no revoca inmediatamente su token. Los comentarios que aseguran que el backend rechazará el rol antiguo con 403 no describen esa implementación.

Por otra parte, el backend distingue un fallo de base durante refresh de credenciales inválidas; el frontend atrapa **cualquier** fallo de refresh y devuelve `null`, y el interceptor desloguea. El cuidado del backend se pierde en el siguiente salto.

## 4. Deriva arquitectónica

| Problema equivalente | Patrón A y dónde | Patrón B y dónde | Qué conservar |
| --- | --- | --- | --- |
| Lecturas ligadas a filtros | `httpResource` en Clientes, Leads, Ventas, Actividades y parte de Planilla | Promesas que escriben signals sin comprobar la clave en consolidado/alertas de Planilla y cargas adicionales de chat | `httpResource` para recursos de selección; promesas para comandos y paginación con clave capturada |
| Autorización de relaciones | Actividades.create valida Cliente con alcance | Actividades.update y Ventas.create validan menos; perfil reutiliza DTO administrativo | Autorización por operación y destino; no herencia automática de todos los campos |
| Propiedad comercial | Clientes.update coordina tres tablas | Leads/Conversaciones validan agente y releen; ingesta accede a Lead directamente | Un comando de asignación explícito, con sus invariantes y transacción; permitir lecturas analíticas documentadas |
| Paginación | Sobre común en Clientes, Leads, Ventas, Actividades y listados de Planilla/Servicios | Mensajes usa array/cursor temporal y búsqueda `{total,items}`; historiales usan topes 200/500 | Diferencias de cursor justificadas, pero contrato explícito de continuidad y totales; eliminar cortes silenciosos |
| Notificaciones | Backend diferencia `emitirActividad` de `notificarEntrante` | Página de Conversaciones notifica ante cualquier `conversacion:actividad` | Evento de actualización para refrescar; evento entrante explícito para avisar |
| Archivos | Ventas/Memoria limitan bytes dentro de Multer | Planilla comprueba tamaño después de recibir el buffer | Límites en transporte, luego validación de contenido y dominio |
| Errores | `mensajeDeError`, HttpException y filtro global | `catch → null`, auditoría silenciosa y promesas `void` que pueden rechazar | Mantener error HTTP uniforme; distinguir fallos transitorios, ausencias y tareas pendientes |
| Caché | Backend comparte `CacheMemoria` con tope y deduplicación | Frontend usa Map de respuestas y otro Map de detalles de chat | Conservar implementaciones adecuadas a cada entorno, pero añadir generación/invalidation y eliminar caché sin lector |
| Formulario | Inputs con `label` enlazada en Clientes | Labels externos sin asociación al input interno en Actividades; Perfil usa Reactive Forms | Reutilizar semántica del control. Reactive Forms puede quedarse: su existencia no es deuda por sí misma |
| Fechas | Horario WhatsApp usa zona explícita; TC opera por fecha UTC | Resumen Actividades usa medianoche local del proceso; formulario usa zona del navegador | Definir instante, fecha civil y zona del negocio; probar con procesos/navegadores en zonas distintas |

La regla documental «ningún módulo toca tablas de otro dominio» no describe el sistema. Auth sí delega en Usuarios, pero Clientes escribe Lead/Conversación y agrega Venta; Servicios consulta Cliente/VentaImportada/Periodo/Medico; Planilla consulta Usuario y actualiza Medico; Actividades consulta Lead/Usuario; la ingesta escribe Lead. No solucionaría esto añadiendo services que solo reenvíen Prisma. Es mejor documentar propiedad de escrituras e invariantes, y permitir consultas de lectura entre dominios donde aportan valor.

## 5. Duplicaciones conceptuales

1. **Ficha de paciente en dos lugares.** [F/src/app/features/clientes/clientes.page.ts:348](<F/src/app/features/clientes/clientes.page.ts:348>) y [F/src/app/features/conversaciones/services/conversaciones-state.service.ts:589](<F/src/app/features/conversaciones/services/conversaciones-state.service.ts:589>) transforman nombre, PAC, CI, etiquetas y `datosExtra`. El chat sigue escribiendo empresa/fecha/lugar tanto en JSON como en campos dedicados, pese a que el backend explica que las columnas son la fuente actual. Al vaciar empresa/fecha/lugar, el chat manda `undefined` a la columna y `null` al JSON: puede quedar la columna anterior visible después de «borrarla».
2. **Persistencia y presentación de datos extra.** El cliente mezcla la traducción del legado FileMaker y la edición actual. Conviene un único mapeo de ficha, no un «mapper genérico» para todo el CRM.
3. **Propiedad de agente.** Cliente, Lead y Conversación guardan agente y además usan fallbacks de «agente efectivo». Esa redundancia afecta permisos y atribución, no solo representación. Debe existir una definición explícita de cuándo pueden diferir.
4. **Notificación nativa y push.** Dos canales legítimos, pero no comparten la decisión de qué merece aviso. Hoy pueden avisar dos veces o por eventos sin mensaje nuevo.
5. **Historial clínico.** Servicios.historialPaciente obtiene hasta 500 y calcula resumen; historialPorPac obtiene 200 y Clientes calcula otro resumen. La misma persona puede tener dos «totales» diferentes cuando crece su historial.
6. **Tres declaraciones de archivo subido.** Interfaces equivalentes en Ventas, Memoria y controller de Planilla. Es un tipo de transporte compartible; no requiere una jerarquía de almacenamiento.
7. **Filtros del inbox.** `listarRequest` y `listarPagina` construyen casi los mismos parámetros en [F/src/app/features/conversaciones/conversaciones.service.ts:32](<F/src/app/features/conversaciones/conversaciones.service.ts:32>). Extraer únicamente ese constructor evita divergencia.
8. **Estado de servidor duplicado.** Chat mantiene resource, páginas adicionales y caché de detalles. Los dos primeros tienen motivo; el tercero tiene escrituras y ningún lector activo.

No considero duplicaciones a corregir: los enums generados frontend, la validación frontend para UX junto a validación backend, las dos escalas de comisión RA/cirugía ni Venta frente a VentaImportada.

## 6. Sobreingeniería y complejidad prescindible

**Caché de detalles sin consumidor.** En [F/src/app/features/conversaciones/conversaciones.service.ts:74](<F/src/app/features/conversaciones/conversaciones.service.ts:74>), `getCachedDetalle` y `actualizarCachePorRealtime` no tienen llamadas en el código ni templates examinados. `setCachedDetalle` sí recibe escrituras desde historial/envío. Mantiene hasta 50 detalles y administra LRU, pero la lectura visible usa `detalleRequest/httpResource`. Es el mejor candidato de simplificación comprobable: eliminar la cadena completa de almacenamiento, después de una prueba que confirme el comportamiento actual de selección/historial. No eliminar el servicio de dominio.

**Conversión innecesaria de tipos.** [B/src/modules/planilla-comisiones/exportacion-word.service.ts:192](<B/src/modules/planilla-comisiones/exportacion-word.service.ts:192>) convierte `Packer.toBuffer` con `as unknown as Promise<Buffer>`; otros casts de JSON de comisiones afirman estructuras sin validarlas. Algunos son adaptaciones necesarias de Prisma JSON, otros deberían desaparecer o concentrarse en la frontera tipada. No reemplazar todos por un framework de serialización.

**Ceremonia documental excesiva.** Hay comentarios históricos útiles junto a afirmaciones categóricas que envejecieron. `strict: true` no prohíbe `any` explícito, aunque CLAUDE/GEMINI lo afirman. Los validadores de skills hacen comprobaciones textuales útiles, no demuestran toda la semántica del programa. No eliminar esos validadores; reducir lo que prometen.

No hay evidencia suficiente para una limpieza general de «helpers de un uso». Un helper de una sola llamada puede separar una regla de negocio testeable. `debeRefrescar`, `fechasDeRepeticion` o la firma de comprobantes tienen un motivo entendible. Tampoco conviene fusionar pequeños componentes visuales solo para reducir archivos.

## 7. Subingeniería

### Unidad de trabajo por operación financiera

Faltan una frontera transaccional de importación y una coordinación por periodo para edición/cálculo/revisión/pago. Puede resolverse dentro del monolito con un comando explícito y PostgreSQL. No hace falta un repositorio universal ni un bus de comandos.

### Asignación comercial explícita

`ClientesService.update` oculta una operación que cambia tres dominios. Extraer un método específico de asignación permite centralizar validación del agente, comportamiento sobre leads históricos/abiertos, auditoría y atomicidad. Mantener la edición de nombre/notas separada de esa preocupación.

### Estado de ficha y estado de conversación

`ConversacionesStateService` mezcla paginación, recursos, edición de paciente, composer, notas y detalles de pantalla. Extraer primero el editor de ficha reutilizado por Clientes; después decidir el alcance del estado de conversación. Actualmente es root y no existe reset de sesión equivalente al de la caché API. Tras logout/login en la misma SPA puede conservar recursos y datos de la sesión anterior hasta una recarga: la identidad del usuario no forma parte de todas sus claves de petición.

### Entrega durable y reconciliación

Persistir el trabajo pendiente de webhook/envío y recuperarlo tras reiniciar tiene valor real. Empezar con PostgreSQL y un procesador acotado evita infraestructura nueva. Debe distinguir «pendiente», «aceptado por Meta» y «resultado desconocido»; reintentar a ciegas después de un timeout puede duplicar mensajes externos.

### Modelo de informe compartido

Excel, Word y PDF pueden compartir datos de informe y cálculos explicativos, conservando renderizadores separados. `informe-liquidacion.ts` ya es una dirección útil. Antes de extraer más, comparar salidas de los tres formatos contra fixtures; no unificar estilos/documentos que tienen propósitos distintos.

## 8. Performance y fiabilidad operativa

Ordenados por consecuencia, sin atribuir latencias no medidas:

1. **P0 — Upload de planilla sin límite durante recepción.** `FileInterceptor('archivo')` no tiene `limits`; el límite de 15 MB se comprueba después de materializar el archivo. Ventas y Memoria ya resuelven este problema correctamente con 8 MB en Multer. El riesgo existe aun cuando solo SUPER_ADMIN puede importar. No se ensayó agotamiento de memoria.
2. **P0 — Rechazos fuera de la petición.** `DespachadorSalienteService.registrarResultadoEnvio` usa `updateMany` para evitar un error por fila borrada, pero sigue pudiendo rechazar por caída de base. Su caller es `void` sin catch. El barrido de Actividades tampoco captura el rechazo de su SELECT inicial. Cambiar `update` por `updateMany` no hace que una función «nunca lance».
3. **P1 — Lectura y parseo completo de Excel.** `excel-parser.ts:125` usa `XLSX.read`; después `sheet_to_json` y normalización materializan varias representaciones. Los lotes de INSERT no limitan la memoria del parseo. En el VPS documentado, con un núcleo y techo de 400 MB para Node, medir RSS y bloqueo del event loop es prioritario antes de crecer. No propongo workers por costumbre, sino si esa medición lo requiere.
4. **P1 — Reclasificación O(n) con escrituras seriales.** [B/src/modules/planilla-comisiones/planilla-comisiones.service.ts:1091](<B/src/modules/planilla-comisiones/planilla-comisiones.service.ts:1091>) carga todas las candidatas y hace un `await update` por coincidencia. Son aproximadamente 1 + n consultas, con posibilidad de progreso parcial. Agrupar por resultado y escribir por lotes aporta valor; mantener la condición de editabilidad en la escritura.
5. **P1 — Avisos globales y debounce que descarta otros chats.** [F/src/app/features/conversaciones/conversaciones.page.ts:102](<F/src/app/features/conversaciones/conversaciones.page.ts:102>) usa un único timer para todos los IDs. Dos conversaciones notificadas en menos de 100 ms dejan solo la última recarga. El evento también se emite por ticks de entrega/media y el frontend muestra «nuevo mensaje entrante». Acumular IDs y distinguir tipo de evento; los rooms por usuario pueden reducir después el fan-out.
6. **P1/P2 — Invalidación con cargas en vuelo.** Reproducido en CacheMemoria: iniciar carga, invalidar, resolver carga antigua deja otra vez el valor viejo cacheado. En frontend, invalidar solo antes de una mutación tampoco impide una respuesta antigua posterior; el comentario que sostiene lo contrario es incorrecto. Usar generaciones y no reutilizar una promesa anterior a la invalidación. La duración y coste actuales están acotados por TTL, pero pueden mostrar datos equivocados tras recalcular/importar.
7. **P2 — Precarga más amplia que la navegación lazy.** Bundle inicial medido: 428,30 kB brutos / 109,54 kB estimados transferidos. Hay 87 archivos JS de salida, unos 1,78 MB brutos en total, incluidos workers. `ngsw-config.json` prefetchea JS y el router precarga rutas. El chunk diferido de calendario es 265,01 kB / 63,36 kB; diferirlo sigue ahorrando ejecución/carga del componente, pero el SW puede descargarlo en segundo plano. Medir instalación/actualización PWA antes de cambiar política offline.

No encontré fundamento para sustituir los agregados SQL del dashboard ni eliminar índices trigram. Las consultas conocidas sobre decenas de miles de pacientes no se convierten automáticamente en un problema de escala.

## 9. Base de datos: queries, schema y transacciones

### Integridad antes que índices

- Importar/recalcular/cerrar: F02/F03.
- `VentasService.create` guarda venta y luego actualiza categoría/leads; un fallo posterior devuelve error con venta ya creada. Sin idempotencia, reintentar puede duplicarla. `cambiarEstado` recalcula categoría solo al entrar en GANADA, no al salir. [B/src/modules/ventas/ventas.service.ts:68](<B/src/modules/ventas/ventas.service.ts:68>), `:268`.
- La categoría depende de una ventana móvil de 90 días, pero se actualiza por comandos. Sin nueva operación puede quedarse SILVER/GOLD después de que la venta salga de la ventana. Definir si debe ser clasificación histórica o derivación vigente, antes de introducir un job.
- `Usuario` protege al último superadministrador con count seguido de update, no de forma atómica. Dos desactivaciones/degradaciones concurrentes pueden saltar la protección. [B/src/modules/usuarios/usuarios.service.ts:169](<B/src/modules/usuarios/usuarios.service.ts:169>).
- Auditoría guarda el snapshot del periodo reabierto fuera de la transacción y `AuditService.registrar` silencia cualquier error. Ese snapshot es la única explicación histórica que el comentario promete conservar. [B/src/common/audit/audit.service.ts:19](<B/src/common/audit/audit.service.ts:19>). Para hechos financieros indispensables, la escritura de auditoría debe compartir la transacción; la telemetría no crítica puede seguir siendo best effort.

### Paginación y búsquedas

- Calendario: pide la primera página de 100 actividades, sin `desde/hasta`; el backend ordena ascendente. Con suficiente historial, las actividades del mes visible pueden ni siquiera entrar en esa primera página. Es un fallo de completitud, no una petición lenta.
- Historial clínico: topes distintos de 200/500 con sumas sobre el array recortado. El límite está probado por código; no se midió cuántos pacientes lo alcanzan hoy.
- Mensajes antiguos: `createdAt < antesDe`, ordenando solo por fecha. Si una frontera de página corta mensajes con el mismo timestamp, los restantes de ese timestamp quedan fuera. Usar fecha + ID como cursor estable. [B/src/modules/conversaciones/conversaciones.service.ts:540](<B/src/modules/conversaciones/conversaciones.service.ts:540>).
- Buscar mensajes tiene endpoint backend paginado, pero el frontend calcula coincidencias sobre el hilo cargado y no llama al método remoto. [F/src/app/features/conversaciones/services/conversaciones-state.service.ts:355](<F/src/app/features/conversaciones/services/conversaciones-state.service.ts:355>), [F/src/app/features/conversaciones/conversaciones.service.ts:124](<F/src/app/features/conversaciones/conversaciones.service.ts:124>). El endpoint no sobra: parece una integración incompleta.
- `Clientes.findOne` incluye todos los leads, intereses y ventas asociados; hay crecimiento potencial por paciente, aunque no se demostró transferencia excesiva con datos actuales. Además se usa como validación de acceso desde Actividades.create, cargando más información de la necesaria.
- No imponer keyset a todos los listados. `skip/take` con topes actuales es razonable; añadir desempate por ID donde el orden no sea único y medir páginas profundas si llegan a usarse.

### Índices y constraints

Hay duplicación estructural exacta entre `@@unique([anio,mes])` y `@@index([anio,mes])` en [B/prisma/schema.prisma:562](<B/prisma/schema.prisma:562>). El único B-tree ya atiende la búsqueda por año/mes. Es candidato a retirar el índice no único tras verificar catálogo de producción; no un P1 por sí solo.

Índices simples que son prefijos de compuestos pueden ser redundantes, pero no los marco como eliminables sin tamaños y uso reales. Tampoco recomiendo nuevos índices por cada campo de un `where`. Las búsquedas por PAC/CI con contains merecen un plan real si aparecen en slow queries; un índice único B-tree no garantiza acelerar contains.

Conservar `pg_trgm`, únicos de idempotencia, el índice de pendientes de Actividades, el índice parcial de objetivos con periodo NULL y la constraint de configuración única. El schema no cuenta toda la historia de PostgreSQL: hay decisiones en SQL de migraciones.

Las consultas raw revisadas usan plantillas parametrizadas/Prisma.sql y listas cerradas para orden. No encontré evidencia de inyección SQL en esos caminos. No se auditó la configuración efectiva de PostgreSQL ni se aplicó la cadena de migraciones en una base nueva durante esta fase.

## 10. Frontend: problemas importantes

### Igualdad que descarta cambios reales — F07

El recurso de detalle compara solo ID de conversación, `updatedAt` y cantidad de mensajes. Entrega/lectura cambia `Mensaje`, no `Conversacion.updatedAt`; media entrante también modifica solo Mensaje. Una nueva URL firmada o edición de ficha puede llegar con la misma triple clave. La respuesta se trata como igual aunque su contenido visible cambió. El comparador de filas tampoco incluye estado de envío del último mensaje o nombre del cliente.

No hay que añadir más timestamps por defecto: primero retirar o corregir el comparador con una prueba del comportamiento. La ausencia de repintado no es una optimización si impide mostrar el estado real.

### Carreras de selección — F08

En Planilla, solicitar mes A, cambiar a B y recibir A al final sobrescribe `alertas`/`consolidado` sin comprobar `periodoId`. El recurso principal de ventas sí está asociado a filtros. Además `catch → null` termina en el texto «Todavía no hay liquidación calculada» ([F/src/app/features/planilla-comisiones/planilla-comisiones.page.html:1024](<F/src/app/features/planilla-comisiones/planilla-comisiones.page.html:1024>)) aunque falló la red.

`cargarMas` del inbox captura filtros al enviar, pero añade el resultado a las páginas actuales al recibir. Cambiar búsqueda durante la petición contamina el nuevo listado. `refrescarFilaPorRealtime` tiene la misma necesidad de descartar respuestas de filtros anteriores.

### Estado y responsabilidades

Los componentes grandes no son malos solo por sus líneas. Aquí Planilla gestiona importación, clasificación, selección de planes, revisión, configuración, reportes y exportación; Ventas mezcla catálogo, cliente, upload y formulario; Actividades mezcla calendario/lista, creación express y seguimiento. Hay fronteras naturales para extraer comportamiento probado. La prioridad es el comportamiento duplicado o con carreras, no partir cada método en un archivo.

`AuthService ↔ roles.ts` es un ciclo de imports real: Auth necesita `cubreRol`, y roles importa Auth para crear el guard. Separar funciones puras del guard elimina el ciclo sin cambiar arquitectura. No se observó un fallo runtime por ese ciclo.

`RealtimeService` captura el token al crear el socket y no lo actualiza en refresh. Tras expirar el token original, una reconexión puede ser rechazada aunque HTTP tenga token nuevo; no hay manejo explícito de `connect_error` para renovar credencial/reconectar. El servidor tampoco impone expiración a sockets ya conectados. Definir ambas partes del contrato.

`DialogService` añade un callback `DestroyRef.onDestroy` por apertura y no lo retira cuando el overlay se dispone; puede retener referencias hasta destruir la página. Es deuda menor frente a los problemas anteriores, no una fuga masiva demostrada. Las subscriptions a eventos de Overlay se completan al disponerlo: no marcarlas indiscriminadamente como leaks.

## 11. Backend: problemas importantes

La mayoría de controllers delega correctamente. El controller de Planilla tiene 533 líneas porque expone muchas operaciones y exportaciones; su tamaño no demuestra por sí solo lógica de negocio.

La excepción concreta es `crearRegla` ([B/src/modules/planilla-comisiones/planilla-comisiones.controller.ts:516](<B/src/modules/planilla-comisiones/planilla-comisiones.controller.ts:516>)): decide crear configuración y aplicarla a periodos. Si la segunda parte falla, existe la regla pero la respuesta HTTP falla con aplicación parcial. Llevar esa intención a un comando de servicio con un resultado explícito.

`PlanillaComisionesService` tiene 1.410 líneas y responsabilidades de importación, médicos, vendedoras, moneda, ajustes, alertas y ciclo del periodo. Cálculo y exportación también son grandes, pero están mejor delimitados por propósito. Extraer primero ciclo del periodo o importación, sin introducir una cadena de fachadas que solo reenvíe llamadas.

`ConversacionesGateway` ya sirve Actividades, no solo Conversaciones. Su dependencia desde Actividades fuerza importar infraestructura del chat. Una infraestructura realtime compartida tendría sentido cuando se toque el contrato de eventos; mover solo la carpeta no arregla autorización ni semántica.

No se encontraron `forwardRef()` ni ciclos de imports en el backend fuente analizado. `MetaSignatureGuard` aparece como provider en dos módulos; al ser un guard sin estado propio de negocio, no lo considero un problema de coherencia que justifique refactor.

### Errores y logging

La forma HTTP normal es razonable y el filtro oculta mensajes internos en 500. Sin embargo, el filtro solo registra HttpException explícitas si son 5xx; el interceptor registra únicamente respuestas exitosas. Los 4xx no dejan la línea de aplicación que promete CLAUDE. [B/src/common/filters/all-exceptions.filter.ts:58](<B/src/common/filters/all-exceptions.filter.ts:58>), [B/src/common/logging/logging.interceptor.ts:36](<B/src/common/logging/logging.interceptor.ts:36>).

Clientes traduce colisiones de unicidad; Usuarios hace SELECT previo y puede recibir un P2002 concurrente que termina como 500. No se necesita traducir todo Prisma globalmente, pero las colisiones esperables deben tener semántica uniforme.

Los logs externos pueden contener detalles sensibles: Push registra el endpoint completo de suscripción ([B/src/common/push/push.service.ts:176](<B/src/common/push/push.service.ts:176>)) y otras rutas registran errores completos. La política de no loguear body/query en HTTP no cubre todos los logs. Redactar los identificadores que actúan como credenciales de notificación.

## 12. Seguridad: findings concretos

Además de F04/F05 y del límite de upload:

- **Push después de logout/desactivación.** Logout limpia storage/cookie pero no llama a `/push/desuscribir`. `enviarAUsuario` y `enviarATodosLosAgentes` no filtran `usuario.activo`, a diferencia de `enviarAAdmins`. Puede seguir llegando al dispositivo información del paciente después de salir o desactivar una cuenta. El backend incluye nombre y resumen de mensaje en el push. Es especialmente relevante en el uso compartido documentado.
- **MIME declarado, no contenido verificado.** Ventas/Memoria aceptan según `file.mimetype`, controlado por multipart; no se identifica el contenido binario. No afirmo ejecución arbitraria ni XSS confirmado: la conclusión demostrable es que la whitelist de MIME puede eludirse enviando otro contenido con ese valor. Validar firmas reales para formatos admitidos y conservar claves/propietario.
- **Credenciales WebSocket.** Validación solo en handshake, sin tipo de token, usuario activo ni renovación de sesión. El broadcast entrega IDs globales; las lecturas REST sí pueden aplicar alcance. No equivale a difusión del contenido completo del chat, pero la distribución debería corresponder al destinatario cuando se rediseñen eventos.
- **Dependencias de parsing alcanzables.** Multer 2.0.2 y xlsx 0.18.5 están en caminos de subida reales; detalles en §14. Los guards reducen la exposición a usuarios autenticados o administradores, no eliminan la vulnerabilidad de la librería.

Elementos positivos comprobados: JWT secret requerido en configuración, bcrypt, guards globales, firma HMAC del cuerpo crudo en webhooks, whitelist DTO, CORS por lista, trust proxy limitado a loopback, claves R2 por propietario en comprobantes/memoria, límites tempranos de 8 MB en esos dos uploads y errores 500 sanitizados.

No se inspeccionaron valores secretos de `.env` ni se buscaron credenciales en el historial Git. No se certifica ausencia de secretos filtrados. Las credenciales de ejemplo/test no se tratan como prueba de exposición de una credencial de producción.

## 13. Accesibilidad: findings concretos

| Evidencia | Problema | Cambio mínimo |
| --- | --- | --- |
| [F/src/app/features/actividades/actividades.page.html:596](<F/src/app/features/actividades/actividades.page.html:596>), `:684`, `:718` | Labels externos sin `for`; el input real está dentro de `app-input` y tiene un ID generado. Fecha/hora carece de asociación accesible | Pasar `label` al control o exponer una asociación explícita, conservando la etiqueta visible |
| [F/src/app/shared/components/input/input.component.ts:68](<F/src/app/shared/components/input/input.component.ts:68>) | El texto `error()` no está enlazado con `aria-describedby` y el campo no expone `aria-invalid` | Asociar error al campo y anunciar validación cuando corresponda |
| [F/src/app/core/toast/toast-container.component.ts:20](<F/src/app/core/toast/toast-container.component.ts:20>) | Mensajes dinámicos sin `role=status`, `alert` ni región live | Región persistente de estado; reservar alerta para fallos urgentes |
| [F/src/app/features/actividades/actividades.page.html:332](<F/src/app/features/actividades/actividades.page.html:332>) | Tarjeta móvil `div` abre detalle solo con click | Añadir un enlace/botón de detalle accesible por teclado; no convertir el div con botones hijos en un botón anidado |

No marco como inaccesible toda fila con click: algunas tienen un botón equivalente dentro. `DrawerComponent` sí usa `cdkTrapFocus`, captura automática y nombre de diálogo; conservarlo. Los icon buttons compartidos pueden recibir `ariaLabel`, por lo que la presencia de un icono no demuestra ausencia de nombre. No emito diagnóstico de contraste sin medir colores efectivos y contexto de renderizado.

## 14. Dependencias

Versiones resueltas del lockfile, no solo rangos: Angular 21.2.22; CDK 21.2.14; Nest principal 10.4.22; Prisma/adapter/client 7.10.0; RxJS 7.8.2; Socket.IO cliente/servidor 4.8.3; Express 4.22.1; Multer 2.0.2; xlsx 0.18.5. Node local observado: 22.23.2.

`npm audit --omit=dev --json`: frontend 0 avisos; backend 19 entradas de paquetes afectados (1 low, 10 moderate, 8 high, 0 critical). **No son 19 vulnerabilidades independientes explotables.** Varias entradas son propagación por dependencias y algunas aparecen por peers del tooling Prisma. No se ejecutó `audit fix`.

### Actualizar ahora, en cambios independientes

- **Multer:** minor corregida dentro de 2.x que cubra los avisos vigentes, con tests multipart. La versión instalada entra en el rango de DoS por recursión documentado por el mantenedor. `@nestjs/platform-express` fija exactamente 2.0.2: no basta un `npm update` ordinario. Evaluar un override acotado y probado, separado de la migración de Nest. No declarar un override «seguro» sin probar abortos, archivos múltiples y límites. [Aviso oficial Multer](https://github.com/expressjs/multer/security/advisories/GHSA-5528-5vmv-3xc2).
- **Dependencias transitivas con patch/minor compatible:** revisar lodash, qs, ajv, file-type y body-parser según la ruta usada y el aviso concreto. El audit marca posibilidades de arreglo, pero algunas ramas están fijadas por Nest. El defecto body-parser citado depende de un límite inválido; no se observó esa configuración en este código. Los avisos de `qs.stringify` no demuestran por sí mismos una vulnerabilidad en el parser de query de esta API.
- **Declarar `temporal-polyfill` como dependencia directa** si se mantiene el import de [F/src/app/features/actividades/components/actividades-calendario/actividades-calendario.component.ts:14](<F/src/app/features/actividades/components/actividades-calendario/actividades-calendario.component.ts:14>). Hoy depende de que otra librería lo instale. Es corrección de manifest, no modernización.
- **Ajustar `engines.node` a un rango realmente soportado.** `>=22` admite versiones iniciales de 22 y majors impares que no corresponden a la matriz declarada. El Node local sí es compatible. Angular 21 admite TS 5.9 y RxJS 7.8; no hay motivo para migrarlos aquí. [Matriz oficial Angular](https://angular.dev/reference/versions).

### Migrar después, con trabajo específico

- **xlsx:** el parser real usa `XLSX.read`, no solo escritura, y el script histórico también lo importa. 0.18.5 está afectado por ReDoS y prototype pollution. No existe solución simplemente elevando el rango dentro del paquete npm viejo. Evaluar distribución mantenida de SheetJS o migrar lector a ExcelJS, usando fixtures FileMaker de fechas, decimales, cabeceras y clasificación. Es prioritario, pero **no es una actualización mecánica**. [ReDoS del proveedor](https://cdn.sheetjs.com/advisories/CVE-2024-22363), [prototype pollution del proveedor](https://cdn.sheetjs.com/advisories/CVE-2023-30533).
- **NestJS major:** proyecto separado. Debe probar routing, Express, query parsing, multipart, cookies, filtros, metadata/DI y WebSocket. Nest 11 introduce Express 5; versiones posteriores añaden otras condiciones de módulos/runtime. No seguir ciegamente el major que propone audit ni mezclarlo con F02/F03. [Cambio oficial de Express en Nest](https://nestjs.io/tutorials/what-s-new-in-express-5-eeb51579), [guía oficial de migración](https://docs.nestjs.com/migration-guide).

### No tocar por ahora

- Angular 21, TypeScript 5.9, RxJS, Tailwind y Schedule-X por modernización. El calendario ya tiene separación diferida útil.
- Prisma 7.10: conservar cliente/CLI/adapter alineados. Los avisos de MySQL2 en tooling no prueban una ruta explotable por la API PostgreSQL. No degradar Prisma siguiendo la sugerencia automática de audit.
- `@nestjs/jwt` 11 con Nest 10: su peer declara compatibilidad con Nest 10. El número major distinto no es por sí solo incompatibilidad.
- ExcelJS, docx y pdfkit: generan formatos distintos realmente usados. El aviso transitivo de uuid no prueba explotación desde esta generación de reportes. No eliminar ni degradar ExcelJS por ese contador.
- Socket.IO 4.8.3 cliente/servidor, bcryptjs, aws4fetch y web-push: hay consumidores claros.

No encontré una dependencia runtime directa demostrablemente innecesaria. `@types/bcryptjs` es candidato de devDependency porque bcryptjs moderno aporta tipos; verificar resolución antes de retirarlo. No se detectaron imports de aplicación desde devDependencies en el barrido realizado.

## 15. Código que NO debemos tocar sin comprenderlo

- **Prisma directo desde services:** mantiene el flujo corto; no añadir repositories que dupliquen su API.
- **`reglas-calculo.ts`, clasificador y tablas de tarifas:** conservar unidades, IVA multiplicado por 0,87, base por precio y reglas de marketing. Los tests de fixtures/reglas tienen valor.
- **`NivelCirugia` frente a `NivelTipoARA`:** son parámetros de negocio independientes aunque sus valores coincidan en un mes.
- **`Venta` frente a `VentaImportada`:** modelan operaciones distintas y las pruebas comprueban su separación.
- **Resultados y configuración fotografiada:** son evidencia de liquidación; no reemplazarlos por cálculo al vuelo que cambie el pasado.
- **`oculta` frente a `activa`:** visibilidad histórica no equivale a dejar de liquidar.
- **`Conversacion.esperandoRespuesta`:** permite filtrar/paginar según respuesta humana; un acuse automático no significa que alguien atendió.
- **Cliente generado Prisma, CommonJS y `rootDir`:** decisiones operativas válidas. Corregir el build incremental sin deshacer estas garantías.
- **Índices trigram e índices parciales de migraciones:** no eliminarlos porque no se vean completos en un inventario superficial.
- **R2 guarda keys, no URLs firmadas:** las firmas se regeneran al leer. La firma es trabajo local, no un N+1 de red.
- **Una sola conexión realtime por sesión con conteo de consumidores:** conservar la idea; corregir credenciales, destinatarios y eventos.
- **Acuse/media/despachador separados:** no fusionarlos en ConversacionesService para reducir archivos.
- **Drawer + CDK Overlay, marco/scroll de Table:** resuelven foco, z-index, proyección y sticky; un wrapper puede aportar valor aunque tenga poco código.
- **`untracked` de Planilla y limpieza del debounce:** conservar mientras exista esa estructura; evitan el bucle documentado.
- **Arranque Angular sin esperar a `/auth/perfil`:** conservar el primer pintado no bloqueante. Corregir la garantía de autorización en servidor.
- **Retención de pestañas de Finanzas y diferimiento del calendario:** decisiones justificadas por interacción y carga. No cambiar por estética.

## 16. Tests: qué protegen y qué falta

### Ejecutados en esta auditoría

| Verificación | Resultado |
| --- | --- |
| Backend `npm test -- --runInBand` | 29 suites, 465 tests pasan |
| Frontend `npm test -- --watch=false` | 6 suites, 51 tests pasan |
| Frontend build + check:tipos + check:skills | Pasa; 428,30 kB inicial / 109,54 kB transferencia estimada |
| Backend build + check:skills | Exit 0 dos veces, pero sin artefacto ejecutable: F01 |
| Backend compilación con salida/caché aisladas en `/tmp` | Pasa y genera `main.js` |
| Reproducciones con servicios/guard reales y dobles ficticios | Confirman refresh como access, código editable en perfil, retarget de actividad e invalidación con carga en vuelo |

No se ejecutaron las 14 suites de integración PostgreSQL: borran tablas de `crm_test`, y el comando de preparación elimina/recrea esa base. No se tocó esa base durante esta auditoría. Sus archivos se revisaron para entender las garantías existentes; no se presentan como pruebas que pasaron hoy. No se calculó cobertura porcentual.

### Protección útil

Las pruebas de clasificación, reglas, marketing, comisiones ocultas, unidades y configuración histórica cubren comportamiento relevante. Las integraciones de inbox ejercitan 1.000 conversaciones, búsqueda profunda y alcance: una prueba valiosa de completitud. Los tests de firma Meta y tratamiento de elementos del webhook también protegen errores reales.

### Falsa confianza concreta

- [B/src/modules/planilla-comisiones/cierre-periodo.spec.ts:225](<B/src/modules/planilla-comisiones/cierre-periodo.spec.ts:225>) titula un caso «aprobar dos veces no duplica la firma», pero llama una vez y comprueba la forma del upsert. No prueba dos llamadas ni concurrencia.
- Las pruebas de cierre construyen Prisma a mano; su `upsert` no incorpora una firma real y las aprobaciones ya vienen precargadas. Sirven para decisiones, no para aislamiento transaccional.
- Auth prueba servicios con dobles, no el guard real recibiendo un token refresh ni el JSON/cookie del controller. Por eso F05 convive con una suite verde.
- Las integraciones instancian services manualmente. No prueban el grafo de DI ni el arranque real de Nest; el comentario de `PrismaService` ya documenta un fallo de ese tipo.
- Frontend no tiene specs de páginas, stores del inbox, PWA, calendario o accesibilidad de controles. `debe-refrescar.spec.ts` prueba una función pura, no el flujo de notificación/reconciliación.
- Los casts `as never` de doubles reducen la capacidad del compilador para advertir cambios de contrato. No prohibir todos los doubles; tipar sus superficies y reservar pruebas integradas para comportamiento dependiente de infraestructura.

### Characterization tests antes de refactorizar

| Zona | Protección actual | Primer test adicional |
| --- | --- | --- |
| Importación | Integraciones financieras y fixtures | Fallo del segundo lote conserva íntegra la importación anterior |
| Cierre/cálculo | estados-periodo, cierre-periodo, ajustar-venta | Editar después de calcular impide revisar sin nuevo cálculo; pagar/reabrir concurrentes |
| Ventas | ventas.integracion | Fallo al actualizar lead no duplica ni deja respuesta ambigua; salida de GANADA |
| Permisos | auth.service, usuarios.service, integraciones de dominios | HTTP con JWT real, DTO real y destino ajeno; cambio de codigo desde perfil |
| Inbox | inbox-escala, conversaciones.integracion, debe-refrescar | Entrega/media con mismo timestamp del chat; dos IDs realtime; cambio de filtro con petición pendiente |
| Planilla frontend | Sin spec de página | Resolver A después de B y simular error de consolidado |
| PWA/sesión | Interceptor token aislado | Registro único, refresh transitorio, logout y suscripción push |
| Calendario | Integración de actividades | Más de 100 registros con eventos dentro/fuera del mes visible |

## 17. Código muerto, compatibilidad y nomenclatura

### Candidatos con evidencia

- Caché de detalles: dos métodos lectores/refrescadores sin llamada y escrituras desde el store. Eliminar solo esa subestructura, no `ConversacionesService`.
- `buscarMensajes` del servicio frontend no tiene consumidor; existe endpoint y tests backend y una búsqueda local distinta. **Conectar la funcionalidad o decidir su alcance antes de eliminar.**
- `/push/desuscribir` no tiene consumidor frontend; es un hueco de cierre de sesión, no un endpoint inútil.
- `/clientes/:id/recalcular-categoria` no tiene consumidor frontend identificado; puede usarse operativamente. Verificar logs/scripts externos antes de retirarlo.
- `X-Api-Version: 1.0.0` se emite, pero el interceptor mira `x-force-reload`; esta cabecera no se emite ni se expone en CORS en el código revisado. El protocolo de actualización por cabecera no está conectado. La actualización normal de Angular SW es otra ruta.
- [B/scripts/seed-admin.js:6](<B/scripts/seed-admin.js:6>) y [B/scripts/import-pacientes.js:18](<B/scripts/import-pacientes.js:18>) siguen importando `@prisma/client` e instanciando `new PrismaClient()` sin el adaptador actual. Quedan fuera del build de `src`; son compatibilidad pendiente, no archivos muertos demostrados. El seed crea ADMIN, aunque administrar usuarios ahora exige SUPER_ADMIN.

El grafo estático no encontró componentes/helpers fuente totalmente aislados, salvo entrypoints y declaraciones de tipos legítimas. Se consideraron rutas dinámicas, imports y consumidores de templates. **Cero archivos fuente completos demostrados como eliminables**; hay código parcialmente sin consumidor y dos scripts que requieren revisión de vigencia.

### Nombres que sí generan confusión

- `ConversacionesGateway` es el canal general de la sesión; `ClientesService.update` también es reasignación de leads/chats.
- `lugarNacimiento` de la API acaba en `Cliente.ciLugar`, mientras Servicios interpreta ese campo como lugar de emisión del documento (`departamentoDesdeCi`). No son el mismo dato. [B/src/modules/clientes/clientes.service.ts:355](<B/src/modules/clientes/clientes.service.ts:355>), [B/src/modules/servicios/normalizacion.ts:56](<B/src/modules/servicios/normalizacion.ts:56>), [F/src/app/features/clientes/clientes.page.html:313](<F/src/app/features/clientes/clientes.page.html:313>). Decidir la semántica y conservar compatibilidad, sin renombrar masivamente a ciegas.
- Usuario/agente/vendedora tienen diferencias válidas: acceso, función comercial e identidad de liquidación. Documentar el cruce por código; no convertirlos en una sola entidad.
- Paciente/cliente es representación del mismo registro en distintos contextos; lead sí es otra entidad. Conviene un glosario corto que exprese esa diferencia.

## 18. Documentación frente a realidad

| Documento/afirmación | Contraste |
| --- | --- |
| CLAUDE/GEMINI: strict prohíbe any | TypeScript strict no prohíbe any explícito; los casts también pueden eludir contratos |
| Manifiesto: aislamiento completo de persistencia | Múltiples services consultan/escriben otros dominios; describir las excepciones reales |
| Skill backend: no quedan topes fijos | Historial usa 200/500; calendario consume 100 sin continuidad |
| CLAUDE: cada petición deja exactamente una línea | El filtro no registra HttpException 4xx; el interceptor solo éxito |
| Auth/comentarios Angular: backend rechaza rol revocado | Guard confía en rol del token durante hasta 8h |
| GEMINI: ActividadSeguimiento, EN_PROGRESO, cliente opcional | Schema real: Actividad, tres estados, cliente obligatorio |
| `MANUAL_USUARIO_CRM.md:87`: completar genera siguiente repetición | La repetición crea varias filas al alta; completar solo cambia estado. La UI puede abrir una nueva creación manual |
| Manual comisiones: TC global del último periodo importado | Hay configuración FIJO/AUTOMATICO y serie diaria, distinta del periodo |
| Comentarios de R2: caducidad descrita con distintos valores | Hay referencias a 15 minutos y a 1h; documentar el valor efectivo de la función central, no copiarlo en cada consumidor |
| README frontend | Sigue siendo scaffold; no sustituye instrucciones de build, backend hermano y tests del CRM |
| Skill rendimiento: cero await en loops | Importación por lotes, reclasificación y recordatorios tienen awaits; la frase global quedó obsoleta |

El problema no es tener documentación extensa, sino usar «el build verifica los skills» como garantía total. Los validadores prueban un subconjunto textual; no detectan atomicidad, que un token sea del tipo correcto, que un label esté conectado ni que la UI descarte una respuesta válida.

Conservar comentarios que expliquen unidades, null/undefined, propiedad del cliente, historial, límites medidos y fallos de despliegue. Mover mediciones variables a un registro fechado y ligar las garantías importantes a tests ejecutables. No «corregir» código para obedecer un comentario equivocado.

## 19. Plan incremental de refactorización y corrección

Diez fases como máximo. Cada fase contiene entregas pequeñas; **cada entrega se despliega por separado**. Las correcciones funcionales se etiquetan como tales y no se mezclan con extracciones mecánicas. Las migraciones de framework quedan fuera de esta secuencia arquitectónica.

| Fase | Objetivo y archivos | Riesgo | Tests necesarios | Beneficio | Rollback |
| --- | --- | --- | --- | --- | --- |
| 0 | Baseline verificable: [B/nest-cli.json](<B/nest-cli.json>), `B/tsconfig*.json`, scripts de build/test; añadir arranque/entrypoint y characterization de cada zona antes de tocarla | Bajo–medio | Dos builds consecutivos producen main.js; arranque con DI; fixtures existentes | Evita desplegar verde sin aplicación | Revertir configuración y restaurar artefacto conocido; sin cambios de datos |
| 1 | Autorización de comandos: DTO propio de perfil; Actividades.update; comandos de Clientes/Ventas. Un endpoint/familia por entrega | Medio | Guards/pipes HTTP y destinos ajenos; codigo/rol/activo; reasignación por PATCH | Cierra puertas laterales sin rehacer módulos | Revertir entrega concreta; conservar pruebas; revertir implica reabrir el defecto |
| 2 | Contrato de sesión: Auth, guard, gateway, interceptor. Separar tipo de token, errores transitorios y luego revocación | Medio–alto | Token refresh como bearer; 500/401 refresh; usuario desactivado; reconexión con token renovado | Sesión coherente entre HTTP/socket | Primero cambios compatibles; si se añade estado de sesión, migración aditiva y rollback de aplicación |
| 3 | Importación atómica: PlanillaComisionesService y parser. Preparar fuera de la transacción y publicar reemplazo completo | Alto | Fallo de lote, importación simultánea, preservación de ajustes y fixture mensual | No perder periodo previo ante fallo | Backup del periodo; mantener schema compatible y ruta previa durante validación |
| 4 | Consistencia del periodo: estados-periodo, cálculo, ajustes, aprobaciones y auditoría crítica | Alto | Edición después de cálculo; pagar/reabrir/recalcular concurrentes; auditoría falla | Cifras revisadas corresponden a las pagadas | Versión/columnas aditivas si hacen falta; rollback de app con evaluación de periodos afectados |
| 5 | Fiabilidad de mensajes/jobs: primero captura de rechazos; después recepción/despacho persistentes, en entregas distintas | Medio–alto | Caída de Prisma, reinicio entre guardar/enviar, resultado externo desconocido, idempotencia | Evita caídas y mensajes perdidos silenciosamente | Detener nuevo worker y drenar pendientes antes de volver; conservar tabla/estado aditivo |
| 6 | Estado remoto Angular: primero igualdad del hilo; luego aislamiento de respuestas por clave y errores financieros. Conservar UI | Medio | Mismo chat distinto estado/media; A→B→respuesta A; filtros durante cargar más | Pantallas reflejan la respuesta correcta | Revertir por feature; endpoints existentes no cambian |
| 7 | Notificación y PWA coherentes: primero evento entrante explícito; luego registro único SW y ciclo push/logout, por entregas | Medio–alto | Evento de entrega no avisa; dos chats; un scope; login/logout; update de SW | Menos avisos falsos y privacidad de sesión | Eventos nuevos aditivos; conservar script compatible para instalaciones existentes |
| 8 | Completitud de consultas: calendario por ventana/páginas, después historial paginado con agregados y cursor estable de mensajes | Medio | >100 actividades; >200/500 servicios; timestamps empatados | Datos completos con carga acotada | Endpoints/parámetros aditivos y mantener contrato anterior mientras migran consumidores |
| 9 | Simplificación respaldada: ficha compartida, asignación explícita, retirar caché sin lector, separar guard de funciones de rol; accesibilidad en controles; documentación ligada a cada entrega | Bajo–medio | Characterization de formularios/asignación; teclado/foco; ausencia de consumidores; suite relevante | Menor coste de evolución y onboarding | Cada extracción sin cambio funcional tiene revert independiente |

La fase 9 es una cola de entregas independientes, no un refactor masivo. No fusionar ficha, roles, accesibilidad y asignación en un mismo PR.

**Carril de dependencias separado:** parche de Multer/otros transitivos; migración del lector xlsx con fixtures; migración major de Nest con pruebas de transporte y despliegue. Cada una tiene su propio baseline y rollback de lockfile/artefacto. El límite temprano de upload se puede corregir de inmediato como entrega autónoma antes de migrar el parser. No esperar a terminar todo el plan para atender P0.

**Pendientes fuera de los primeros cambios:** afinar fechas civiles, revisar categoría móvil, optimizar reclasificación por lotes, limpiar candidatos de índices con medición y actualizar scripts operativos. No crear diez abstracciones para resolverlos; añadirlos a la fase del dominio correspondiente solo como entregas separadas.

Para cualquier implementación posterior: tests relevantes antes, cambio de una preocupación, tests después, typecheck, build, revisión de diff y comprobación de comportamiento. Cuando se corrige un bug de este informe, documentar el cambio funcional deliberado; cuando se extrae código, exigir equivalencia. No borrar caminos anteriores sin probar que han dejado de usarse.

## 20. Métricas

Se excluyen dependencias instaladas, código Prisma generado, `.git`, cobertura y artefactos. Los conteos por decoradores son una aproximación estática, no rutas observadas del servidor.

| Métrica | Resultado |
| --- | --- |
| Archivos fuente frontend (`src`, TS/HTML/CSS/declaraciones) | 209; 133 TS incluyendo tests |
| Archivos fuente backend (`src`, sin generado) | 182 TS incluyendo tests |
| Archivos en repos frontend/backend, incluyendo docs/config/skills/scripts | 289 / 242 según inventario; no usarlo como medida de complejidad |
| Features frontend / dominios backend | 15 / 13 |
| Módulos Nest | 19 incluyendo raíz e infraestructura |
| Componentes Angular | 67 incluyendo páginas y compartidos |
| Servicios Angular / Nest | 23 / 32 por archivos `.service.ts` |
| Endpoints HTTP | Aproximadamente 122 decoradores de método; incluye health y webhooks |
| Gateways | 1; no se encontraron handlers `SubscribeMessage` en el gateway revisado |
| Modelos Prisma / enums sincronizados / migraciones SQL | 29 / 22 / 41 |
| Archivos de tests frontend/backend | 6 / 43; backend: 29 unitarios + 14 integración |
| Tests ejecutados | 51 frontend + 465 backend = 516, todos pasan |
| Declaraciones estáticas de casos | Aproximadamente 49 frontend / 620 backend; parametrización hace que no equivalgan a casos ejecutados |
| Dependencias runtime directas | 16 frontend + 25 backend = 41 entradas; 40 nombres distintos; RxJS aparece en ambos proyectos |
| Runtime directas demostrablemente innecesarias | 0; 1 candidato dev (`@types/bcryptjs`) |
| Dependencias usadas sin declaración directa | 1 clara: `temporal-polyfill` |
| Archivos fuente completos demostrados muertos | 0; 2 scripts operativos con compatibilidad pendiente; métodos/caché sin consumidor en §17 |
| Duplicaciones conceptuales relevantes | 8 grupos descritos en §5 |
| TS de producción de más de 500 líneas | 9 frontend / 10 backend; incluye modelos/helpers/controllers |
| Componentes/services dentro de ese grupo | Frontend: 7 componentes y 1 service; backend: 8 services |
| Ciclos de imports estáticos | 1 frontend (AuthService/roles); 0 backend encontrados |
| Ciclos DI Nest confirmados / forwardRef encontrados | 0 / 0; no equivale a un arranque integrado probado |

### Veinte archivos de mayor riesgo o complejidad

Selección por efecto en permisos, dinero, persistencia, eventos, número de responsabilidades y cobertura; no ranking por líneas.

| Archivo | Motivo |
| --- | --- |
| [B/src/modules/planilla-comisiones/planilla-comisiones.service.ts](<B/src/modules/planilla-comisiones/planilla-comisiones.service.ts>) | Reemplazo financiero, transiciones, maestros, ajustes y auditoría |
| [B/src/modules/planilla-comisiones/calculo-comisiones.service.ts](<B/src/modules/planilla-comisiones/calculo-comisiones.service.ts>) | Dinero, configuración histórica, escritura de resultados y concurrencia |
| [B/src/modules/planilla-comisiones/exportacion-comisiones.service.ts](<B/src/modules/planilla-comisiones/exportacion-comisiones.service.ts>) | Unidades y consistencia del documento que se usa para liquidar |
| [B/src/modules/planilla-comisiones/configuracion-comisiones.service.ts](<B/src/modules/planilla-comisiones/configuracion-comisiones.service.ts>) | Tarifas, objetivos y reglas que afectan muchos periodos |
| [B/src/modules/planilla-comisiones/excel-parser.ts](<B/src/modules/planilla-comisiones/excel-parser.ts>) | Datos externos, fechas, memoria y parser vulnerable |
| [B/src/modules/conversaciones/conversaciones.service.ts](<B/src/modules/conversaciones/conversaciones.service.ts>) | Acceso, envío, ownership, historial y estado de entrega |
| [B/src/modules/conversaciones/ingesta-whatsapp.service.ts](<B/src/modules/conversaciones/ingesta-whatsapp.service.ts>) | Deduplicación, clientes/leads, media y acuses concurrentes |
| [B/src/modules/conversaciones/despachador-saliente.service.ts](<B/src/modules/conversaciones/despachador-saliente.service.ts>) | Resultado externo ambiguo y promesas fuera de HTTP |
| [B/src/modules/conversaciones/conversaciones.gateway.ts](<B/src/modules/conversaciones/conversaciones.gateway.ts>) | Autenticación y contrato realtime de varias funcionalidades |
| [B/src/modules/clientes/clientes.service.ts](<B/src/modules/clientes/clientes.service.ts>) | Ficha, ownership de tres entidades y categoría derivada |
| [B/src/modules/ventas/ventas.service.ts](<B/src/modules/ventas/ventas.service.ts>) | Venta confirmada antes de sus efectos de negocio |
| [B/src/modules/actividades/actividades.service.ts](<B/src/modules/actividades/actividades.service.ts>) | Autorización del destino, repetición y barrido de notificaciones |
| [B/src/modules/auth/auth.service.ts](<B/src/modules/auth/auth.service.ts>) | Payloads, perfil, permisos y sesión |
| [B/src/common/guards/jwt-auth.guard.ts](<B/src/common/guards/jwt-auth.guard.ts>) | Pocas líneas pero frontera global de credenciales |
| [F/src/app/features/planilla-comisiones/planilla-comisiones.page.ts](<F/src/app/features/planilla-comisiones/planilla-comisiones.page.ts>) | Muchas acciones financieras y carreras entre recursos/promesas |
| [F/src/app/features/conversaciones/services/conversaciones-state.service.ts](<F/src/app/features/conversaciones/services/conversaciones-state.service.ts>) | Estado root, igualdad, paginación, ficha y reconciliación |
| [F/src/app/features/conversaciones/conversaciones.page.ts](<F/src/app/features/conversaciones/conversaciones.page.ts>) | Debounce global, avisos falsos, polling y sincronización de ruta |
| [F/src/app/features/actividades/actividades.page.ts](<F/src/app/features/actividades/actividades.page.ts>) | Calendario incompleto, formularios y creación de cliente |
| [F/src/app/core/auth/auth.service.ts](<F/src/app/core/auth/auth.service.ts>) | Errores de refresh, persistencia y limpieza de sesión |
| [F/src/app/core/notification/notificacion-nativa.service.ts](<F/src/app/core/notification/notificacion-nativa.service.ts>) | Registro SW, push y convivencia con sesión compartida |

Otros archivos sensibles aunque no entren en los veinte: `schema.prisma`, `nest-cli.json`, `tsconfig.json`, `AuditService`, `CacheMemoria`, `ventas.page.ts`, `ServiciosService` y los renderizadores Word/PDF.

## 21. Respuesta a la pregunta de los próximos cinco años

El mayor problema para otro equipo sería **tener que descubrir qué garantías son reales y cuáles viven solo en comentarios o en una de las capas**. Hoy «periodo cerrado», «sesión revocada», «mensaje entregado», «lista completa» y «build exitoso» tienen casos en los que el sistema puede afirmar más de lo que asegura.

La corrección con mejor retorno consiste en hacer explícitas y ejecutables esas cinco garantías: transacciones y versión del periodo; permisos y tipo de credencial; estado durable del mensaje; contratos de paginación; y artefacto de build comprobado. Después, extraer la ficha repetida y la asignación comercial reduce el coste de cambio sin alterar el motor financiero.

Este CRM puede mantenerse como monolito Angular + Nest + Prisma. La ruta de menor riesgo es reforzar esas fronteras y retirar soluciones parcialmente conectadas, conservando las reglas de negocio que ya están contrastadas. La cantidad de archivos y la modernidad de las APIs son cuestiones secundarias frente a esa coherencia.
