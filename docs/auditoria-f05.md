# F05 — Contrato de sesión

2026-09-07. Continúa F04; checkpoint previo de ambos repositorios indicado en
`/tmp/crm-f05-baseline-path`. Sin cambios en reglas financieras, dependencias,
jobs, PWA o arquitectura de comisiones.

> **Nota del 2026-09-07.** Los parches, marcadores de checkpoint y logs en `/tmp`
> que cita este informe **ya no existen**: eran temporales de aquella sesión y
> `/tmp` se vacía al reiniciar. No hacen falta. El rollback real de esta entrega
> es `git revert` del commit que la introdujo, y el historial de Git es el
> checkpoint. Se conservan las referencias tal cual porque describen cómo se
> trabajó, no porque haya que ir a buscarlas.

## Diagnóstico y contrato elegido antes de implementar

La suite HTTP/WebSocket nueva reproduce 10 fallos de 11 casos: refresh aceptado
como access, payload firmado sin estructura suficiente, refresh expuesto en JSON,
credenciales anteriores utilizables después de desactivar, degradar, cambiar
contraseña o salir; el socket acepta refresh y sigue recibiendo eventos tras
desactivar al usuario. El control positivo de refresh válido pasa.

Angular convierte cualquier fallo de refresh en null, que el interceptor interpreta
como sesión inválida. También puede restaurar A tras logout/login B mediante una
respuesta antigua. Login omite withCredentials pese al uso de cookie entre dominios.

Se limita el cierre de sesión al login actual; no cierra otros dispositivos. Cambiar
contraseña, rol o activo invalida las credenciales anteriores de ese usuario.

Diseño mínimo para esas dos garantías distintas:

- Una tabla SesionUsuario: ID, usuario, creación y expiración absoluta. Los JWT
  citan el ID; logout elimina esa sesión. Expiradas se retiran al volver a iniciar
  sesión ese usuario. No se guardan tokens ni contraseñas en esa tabla.
- Usuario.versionSesion, incrementado en el mismo UPDATE que cambia contraseña,
  rol o activo. Access y refresh contienen esa versión. Evita que reactivar una
  cuenta reviva sus credenciales anteriores y que un login concurrente basado en
  la contraseña anterior produzca credenciales utilizables después del cambio.
- Access y refresh llevan propósitos y estructura explícitos. Firma, estructura
  y expiración se validan antes de consultar una sesión vigente y usuario activo.
- HTTP y socket comparten validación. El middleware de Socket.IO autoriza ANTES
  de conectar; antes de difundir eventos se comprueban las sesiones en una sola
  consulta. Expirar un access desconecta ese socket.
- Credencial inválida: 401. Error operativo: 5xx, sin disfrazarlo de 401. El cliente
  mantiene la sesión ante fallos transitorios, comparte refresh y descarta respuestas
  de una sesión anterior. El socket toma el token actual en cada handshake.

Se mantienen 8h de access y 30 días absolutos de refresh. El login devuelve access
y usuario; refresh solo sale por cookie HttpOnly. Se conserva la entrada de refresh
por body para compatibilidad, sin devolverlo en JSON.

Los JWT anteriores sin propósito/ID/versión dejan de ser aceptados: el despliegue
requiere iniciar sesión nuevamente. La migración debe preceder a la aplicación.
No se ejecuta despliegue en esta entrega.

## Verificación

Las pruebas nuevas se ejecutaron antes de modificar su comportamiento. La primera
reproducción HTTP/socket quedó en 10 fallos y un control positivo; en Angular los
casos de fallo transitorio, respuesta antigua y credenciales del login quedaron
en rojo. Se conservaron esas aserciones al implementar la corrección.

En la revisión final se añadieron dos casos con Bearer de A y cookie de B. Ambos
fallaron: logout borraba la cookie de B y refresh emitía acceso de B. Ahora logout
prioriza el Bearer y conserva una cookie válida de otro login; refresh, cuando
recibe Bearer, exige coincidencia de sesión, usuario y versión. Un access expirado
de la misma sesión sí permite refrescar. Los clientes que solo envían refresh
por cookie/body siguen admitidos.

| Verificación final | Resultado |
| --- | --- |
| Backend unitario completo | 29 suites, 465 tests pasan |
| Todas las integraciones PostgreSQL, con base limpia por suite | 18 suites, 346 tests pasan |
| Subconjunto financiero, incluido en el anterior | 7 suites, 97 tests pasan |
| Subconjunto F04, incluido en el anterior | 50 tests HTTP de autorización pasan |
| Subconjunto nuevo F05, incluido en el anterior | 20 tests HTTP/WebSocket pasan |
| Frontend completo | 8 suites, 69 tests pasan |
| Typecheck backend de producción y tests de sesión/autorización | Pasa |
| Typecheck frontend de aplicación y tests | Pasa |
| Backend build, check:skills y check:build | Pasa; dist/main.js presente |
| test:build | 9 tests pasan, incluidos builds limpio y consecutivo |
| Frontend build, check:tipos y check:skills | Pasa; el primer build se abortó dentro del sandbox y la repetición fuera pasó |
| Arranque del backend compilado | AppModule y providers reales, 23 registros de módulos; health 200, login vacío 400 y periodos sin token 401 |
| Migración desde schema anterior y base vacía | 41→42 y 0→42; usuario conservado, versión inicial 0 y FK con cascada verificadas |
| Revisión de diff | Sin errores de whitespace; parches de F05 verificables contra su checkpoint |

La ejecución conjunta anterior de integraciones tenía contaminación entre fixtures,
documentada en F04. Esta entrega ejecuta cada archivo existente por separado tras
recrear exclusivamente `crm_test` en 127.0.0.1:5433. No se presenta el comando conjunto
como verde ni se modifican fixtures financieros para ocultar ese límite.

Los tests HTTP usan Nest, JWT, guards, DTOs, ValidationPipe y PostgreSQL reales.
Los sockets del backend usan el protocolo real de Engine.IO/Socket.IO mediante
WebSocket. Solo se fuerza el rechazo de una consulta concreta para simular caída
de base; no se sustituye la persistencia de sesiones por un mock. Angular utiliza
HttpTestingController; el transporte Socket.IO del cliente tiene un doble, con
el servicio y el ciclo DestroyRef reales. No se utilizó navegador.

## Contrato HTTP y de socket

| Operación | Contrato nuevo |
| --- | --- |
| Login | Access + usuario en JSON; refresh exclusivamente en Set-Cookie HttpOnly |
| Acceso HTTP | 401 si propósito, estructura, expiración, sesión, usuario, rol o versión no son válidos; 500 si falla la consulta |
| Refresh | Emite access sin rotar ni prolongar la sesión de 30 días; no cambia otra sesión mediante una cookie cruzada |
| Logout | 204 tras revocar ese login; repetible incluso con access expirado; cookie de otro login preservada; error de base devuelve 500 |
| Cambio de contraseña, rol o activo | Incrementa la versión en el mismo UPDATE; access y refresh anteriores dejan de autorizar |
| Handshake | Rechazo antes de conectar con status 401 para credenciales y 503 para fallo operativo |
| Socket conectado | Desconexión al expirar access; revocación comprobada antes de cada difusión; fallo de base impide difundir |
| Angular | 0/5xx no borran sesión; 401 del refresh sí; respuestas de una generación anterior no sobrescriben ni desloguean el login actual |

`AuthService` se exporta desde AuthModule y se importa en ConversacionesModule
para compartir exactamente la validación del guard. Se conserva el resto del
grafo de módulos. El cliente mantiene un socket con conteo de consumidores y
refresco compartido, con espera de reconexión entre 1 y 30 segundos ante fallos
operativos. Los eventos y sus destinatarios funcionales no cambian en esta fase.

## Archivos de esta entrega

Backend (rutas relativas al repositorio):

- `prisma/schema.prisma` y `prisma/migrations/20260907180000_sesion_revocable/migration.sql`.
- `src/modules/auth/credencial.ts`, `auth.service.ts`, `auth.controller.ts` y `auth.module.ts`.
- `src/common/guards/jwt-auth.guard.ts` y `src/modules/usuarios/usuarios.service.ts`.
- `src/modules/conversaciones/conversaciones.gateway.ts` y `conversaciones.module.ts`.
- Test nuevo `src/modules/auth/sesion-http.integracion.spec.ts`.
- `src/modules/auth/auth.service.spec.ts`: adapta los fixtures al estado persistido.
- `src/common/auth/autorizacion-http.integracion.spec.ts`: obtiene credenciales mediante login real; conserva las 50 aserciones de F04.
- `CLAUDE.md`, `.claude/skills/crm-backend-module/SKILL.md` y este informe.

Frontend:

- `src/app/core/auth/auth.service.ts` y `token.interceptor.ts`.
- `src/app/core/realtime/realtime.service.ts`.
- Tests nuevos `src/app/core/auth/sesion.spec.ts` y `src/app/core/realtime/realtime.service.spec.ts`: 18 casos en total.
- `src/app/core/auth/token.interceptor.spec.ts`: adapta el doble al identificador de generación.
- `src/app/app.config.ts`: únicamente comentarios del arranque no bloqueante.
- `CLAUDE.md` y `.claude/skills/crm-feature-page/SKILL.md`: contrato de sesión actualizado.

## Comportamiento conservado y checkpoint

Sin cambios de dependencias, lockfiles, fórmulas, tarifas, clasificación,
PlanillaComisionesService ni otra implementación financiera. Las huellas SHA-256
del módulo de comisiones, configuración/scripts de build y manifests coinciden
con el checkpoint previo. F01–F04 conservan sus correcciones y pruebas.

Se conservan rememberMe, almacenamiento elegido, cookie cross-site en producción,
refresh de 30 días absolutos, access de 8 horas, primer pintado no bloqueante y
jerarquía/alcance de permisos de F04. Un rol insuficiente en una sesión válida
continúa dando 403; un token revocado da 401.

## Límites y riesgos restantes

- La validación añade una consulta de sesión/usuario por petición autenticada,
  sin cargar la foto, y una consulta por difusión. No se ha medido su coste en
  producción ni se añade caché que retrase la revocación.
- La revocación afecta a la siguiente comprobación. Una operación ya autorizada
  o una difusión cuya lectura precedió al cambio puede terminar; no se cancela
  trabajo en vuelo. Un socket ocioso revocado se desconecta en la siguiente
  difusión o expiración, sin recibir contenido nuevo después de comprobarla.
- Enviar campos rol/activo, incluso con el mismo valor, incrementa la versión.
  Es una revocación conservadora deliberada, sin depender de una lectura previa.
- Si logout falla por red/base, Angular limpia su estado local, pero eso no
  confirma revocación en servidor. No se introduce un trabajo de revocación diferida.
- No se añadieron sincronización general entre pestañas mediante storage events,
  aislamiento de todas las cachés/estados de funcionalidades, desuscripción push
  ni cambios de PWA. Tampoco se certifica aquí la política de cookies de cada
  navegador; se verificó el contrato de transporte.
- Las sesiones expiradas se purgan al volver a hacer login ese usuario. Las de
  usuarios que nunca regresan permanecen inertes; no se añade un job en F05.

## Migración y rollback

La migración es aditiva: `Usuario.versionSesion` con default 0, tabla de sesiones,
índice y FK. No altera comisiones ni reescribe sus resultados. Antes de desplegar
la aplicación nueva se necesita aplicar esta migración y generar Prisma. Los
tokens de F04 sin `type`, `sid` y versión requieren nuevo login. No se desplegó ni
se consultó producción en esta entrega.

Checkpoint íntegro previo: directorio indicado en `/tmp/crm-f05-baseline-path`,
con manifiestos por repositorio. `/tmp/crm-f05-backend.patch` y
`/tmp/crm-f05-frontend.patch` contienen exclusivamente esta entrega, sin mezclar
el diff previo de F01–F04; se comprobó `git apply --reverse --check`.

Para rollback de aplicación usar los artefactos del checkpoint de ambos repositorios
y conservar la migración, tabla y columna aditivas. El parche de backend sin
schema/migración está en `/tmp/crm-f05-backend-aplicacion.patch`. No borrar una
migración ya aplicada ni ejecutar un reset de base. Volver al código anterior
restaura también sus límites de revocación y validación de tokens; no revierte
transacciones financieras. No se ejecutó rollback, commit, push ni despliegue.

Logs de esta verificación local: `/tmp/crm-f05-integraciones-resumen.log`,
`/tmp/crm-f05-unitarios.log`, `/tmp/crm-f05-frontend-completo.log`,
`/tmp/crm-f05-build-backend.log`, `/tmp/crm-f05-build-frontend.log`,
`/tmp/crm-f05-test-build.log`, `/tmp/crm-f05-migracion.log` y
`/tmp/crm-f05-arranque.log`. Los archivos temporales no son un respaldo permanente.
