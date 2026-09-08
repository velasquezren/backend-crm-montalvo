# CRM Clínica Montalvo — Memoria y Contexto del Proyecto

> **Entorno de producción:** Sistema centralizado para Clínica Montalvo (Bolivia).
> **Atención:** Lo utilizan agentes de venta y médicos en vivo sobre datos de pacientes reales. **No hay staging**. Todo cambio debe pasar `npm run build` sin errores.

---

## 🏛️ 1. Estructura del Espacio de Trabajo

El proyecto opera como dos repositorios hermanos bajo este directorio raíz:

```
CRM/
├── backend-crm-montalvo/     ← NestJS 10 + Prisma 7 + PostgreSQL (puerto local 5433)
│   ├── GEMINI.md             ← Memoria permanente y reglas invariantes (este archivo)
│   └── docs/ESTADO_ACTUAL.md ← Dónde va el trabajo y qué sigue. Léelo primero.
└── frontend-crm-montalvo/    ← Angular 21 (Signals, OnPush), Tailwind v4, PWA (Vercel)
    ├── CRM_MANIFESTO.md      ← Principios de arquitectura y diseño (estables; el detalle
    │                            verificado vive en los `.claude/skills/` de cada repo)
    └── docs/MANUAL_USUARIO.md ← Manual operativo y casos de uso por rol
```

El directorio padre que contiene ambos repos **no es un repositorio git**: nada
que viva solo ahí sobrevive a un cambio de máquina. Por eso estos archivos, que
antes estaban sueltos en la raíz, hoy están versionados dentro de un repo.

Este archivo es el resumen para sesiones que **no** leen `.claude/skills/` (ese
mecanismo es de Claude Code). Se mantiene a mano, sin build que lo verifique —
por eso solo debe listar lo que de verdad importa recordar, y hay que corregirlo
apenas se note un dato viejo, no esperar una revisión grande.

---

## 🛡️ 2. Invariantes Técnicas y Reglas de Oro

### Backend (`backend-crm-montalvo/`)
1. **Compuerta de build:** `npm run build` encadena `check:skills` + `nest build` + `check:build`. Es la autoridad absoluta. El último eslabón existe porque el build llegó a terminar con exit 0 **sin** reemitir `dist/main.js` (F01).
2. **Cero `any`:** Prohibido `any` y `catch (e: any)` — usar siempre `unknown` y narrowing. Desde que `tsconfig` activa `strict` completo, esto ya no es solo convención: el compilador lo rechaza (`useUnknownInCatchVariables`).
3. **Límites de Dominio:** Ningún módulo toca la tabla/modelo de otro dominio directamente; siempre se invoca a su `Service`.
4. **Paginación obligatoria:** Todo listado debe paginarse (`PaginationDto`). La base contiene más de 15.000 pacientes.
5. **Jerarquía de Roles:** Nunca comparar cadenas a mano (`rol === 'ADMIN'`). Usar `alcanceAgente()` o `cubreRol()` de `common/auth/roles.ts`. Jerarquía: `AGENTE < ADMIN < SUPER_ADMIN`. La regla del escopado aplica también a `findOne`/`update`, no solo a `findAll` — un registro sin ese chequeo se lee o edita por UUID sin importar el dueño.
6. **Validación de DTOs:** Todo campo lleva decorador de `class-validator`. `ValidationPipe` corre con `whitelist: true` — un DTO sin ningún decorador no llega incompleto al service, llega `{}`, siempre y sin avisar.
7. **Base de Datos:** Postgres local corre en el puerto **5433** (no 5432). Si se modifica `schema.prisma`, generar y commitear la migración (`npx prisma migrate dev --name <nombre> --create-only`).
8. **Notificaciones Push:** Solo `notificarEntrante()` dispara push VAPID al móvil (únicamente ante mensaje nuevo de una paciente). No generar llaves VAPID al vuelo.
9. **Caché:** Usar únicamente `common/cache/cache-memoria.ts` (TTL + tope de entradas + deduplicación). Es in-process, no distribuida — cachear algo que se reescribe al importar y no invalidarlo ya causó un bug real (se revirtió).
10. **Webhooks públicos (`@Public()` + sin rate-limit) se sostienen con la FIRMA, no con el rate-limit:** todo `@Post()` bajo `webhooks/` lleva `@UseGuards(MetaSignatureGuard)` — Meta firma el cuerpo crudo con HMAC-SHA256 (`X-Hub-Signature-256`); sin verificarlo, cualquiera que supiera la URL pública podía inyectar mensajes o leads falsos. `check:skills` lo obliga en cada build.
11. **Autenticación:** `access_token` corto (header `Authorization`) + `refresh_token` de 30 días absolutos en cookie `HttpOnly`. Cross-site (frontend en Vercel, API en otro dominio) exige `SameSite=None; Secure` en producción. Desde F05 la sesión **es revocable**: `POST /auth/logout` revoca ese login en PostgreSQL (tabla `SesionUsuario`) además de borrar la cookie, y cambiar contraseña, rol o `activo` incrementa `Usuario.versionSesion`, que invalida las credenciales anteriores. HTTP y WebSocket comprueban propósito del token, sesión vigente y versión. La migración `20260907180000_sesion_revocable` **debe aplicarse antes** de desplegar esa aplicación.
12. **Trabajo en segundo plano:** todo disparo sin `await` va por `enSegundoPlano(contexto, logger, () => …)` de `common/fiabilidad`. Una promesa rechazada fuera de una petición HTTP aborta el proceso, y systemd con `Restart=always` lo relevanta en bucle mostrando `active` (F06). `check:skills` lo obliga.
13. **Observabilidad:** toda petición lleva un `requestId` (`X-Request-Id`); ni logs ni errores registran cuerpo, cabeceras o query string (son datos de pacientes). `GET /health` verifica la base con `SELECT 1`.

### Frontend (`frontend-crm-montalvo/`)
1. **Compuerta de build:** `npm run build` corre `check:tipos` + `check:skills` + `ng build`.
2. **Detección de cambios:** `ChangeDetectionStrategy.OnPush` en **todos** los componentes sin excepción. Estado gobernado por `signal()`, `computed()` e `input()`.
3. **Cuatro estados obligatorios:** Toda vista con datos asíncronos implementa explícitamente: **Carga**, **Error**, **Vacío** y **Contenido**.
4. **Aislamiento HTTP:** Los componentes nunca inyectan `HttpClient` ni arman URLs; consumen los servicios del dominio.
5. **Diseño y Estilos:** Prohibidos colores hexadecimales fuera de la paleta institucional, animaciones pesadas (`@keyframes` de entrada) o elementos que peleen con el átomo `<app-table>`.
6. **Modales y Overlays:** Usar `DialogService` (CDK Overlay proyectado en `document.body`) en vez de `@if` flotantes.
7. **Sincronización de Enums:** La fuente de verdad es el backend. Tras modificar un enum en Prisma, correr `npm run sync:tipos` en el frontend.
8. **Sesión:** `token.interceptor.ts` reintenta un refresco silencioso ante un 401 ajeno a login/refresh/logout y reintenta la petición original una vez; solo desloguea si el refresco falla o si el reintento con el token nuevo **vuelve** a dar 401 (evita el bucle de "sesión inválida" reintentando para siempre).

---

## 💰 3. Módulo de Finanzas y Comisiones (`/finanzas`) — Cicatrices y Decisiones Recientes

Este módulo fue auditado y consolidado contra las liquidaciones reales (Diciembre 2025 y Enero 2026).

### A. La Regla de Oro del Cálculo: `Base = Precio × 0,87`
* **La base de cálculo es SIEMPRE el 87% del precio de catálogo:**
  $$\text{Base Comisión} = \text{Precio USD} \times 0.87$$
* **El 13% de IVA se descuenta multiplicando por `0.87`**, no dividiendo entre `1.13`.
* **El anticipo NO es la base de comisión:**
  * La vendedora comisiona por **vender** el plan completo, no al ritmo al que la paciente paga sus cuotas.
  * Contrastado contra `BDEjecutivas` de `CALCULO COMISION DICIEMBRE 2025.xlsx`: **356 de 356 filas** calculan `INGRESO NETO = precio × 0,87`.
  * La columna **«Pagado»** en la tabla muestra el anticipo y el `%` cubierto del plan (`$1,787.95 · 51%`), pero es **meramente informativo** para control de cobranza.

### B. El Estado del Plan es Informativo
* Se eliminó la regla que excluía planes que no estuvieran en `APROBADO` o `TERMINADO`.
* **La venta comisiona sin importar el estado del plan.**
* El estado (`estadoPlan`) solo informa en qué punto operativo va el plan; **NO indica cobranza** (hay planes TERMINADOS con 25% pagado y APROBADOS con 100%).

### C. Exclusión y Reinclusión de Ventas con Auditoría
* Para excluir una venta del cálculo (`comisionable = false`), el backend **exige obligatoriamente `motivoExclusion`** (3 a 200 caracteres).
* El motivo queda registrado en el log de auditoría (`AuditLog`) indicando quién, cuándo y por qué excluyó la venta.
* Al **reincluir** una venta (`comisionable = true`), el motivo se borra automáticamente.
* Las planillas en estado `CERRADO` son inmutables (no permiten exclusiones ni ajustes).
* En el frontend, el botón de exclusión/reinclusión está disponible solo para `SUPER_ADMIN` con periodo abierto mediante modal de confirmación.

### D. Jerarquía de Clasificación de Servicios
1. **Diccionario de Administración:** Sobrescribe cualquier valor manual.
2. **Columna FileMaker:** Exportada como `clasifiacion` (sin la segunda 'c'). Reconoce categorías nativas: `laboratorios`, `consultas`, `ecografías`, `cirugías`, `paquetes`, `planes`.
3. **Heurístico de Texto:** Se mantiene como red de seguridad para filas sin clasificar.

### E. Monedas y Conversión
* Los archivos Excel de importación vienen expresados en **Dólares Americanos (USD)**.
* Los cálculos internos y bases se procesan en USD.
* La interfaz muestra importes en **Bolivianos (Bs / es-BO)** y en USD en las columnas correspondientes de liquidación.
* El tipo de cambio que usa el resto del CRM (selector Bs/$us, KPIs, tabla de Ventas) **ya no es una constante fija**: módulo `tipo-cambio` (backend) trae el oficial de un espejo del BCB cada 6h, un ADMIN puede corregir un día a mano (siempre gana sobre lo automático de ese día), y el frontend lo lee de `GET /tipo-cambio/vigente`. Antes era `6,97` fijo en el código mientras el oficial subía a `11,54` sin que nada avisara. Esto es distinto del `tipoCambio` de un `PeriodoComision` ya cerrado, que sí queda fijo para siempre.
* **Un `%` puede ser puntos porcentuales o fracción — confundirlos ya rompió tres veces.** `pctEmpresa`/`pctPropio`/`PCT_TIPO_C_RA` nacen en puntos (`4.5` = 4,5%, así los consume el motor: `comisionUsd = base * porcentaje / 100`); `FACTOR_BONO_JEFATURA`/`FACTOR_BONO_TRIMESTRAL` son fracción (`0.002` = 0,2%) y sí llevan `×100` al mostrarse. La exportación a Excel del backend y un panel del frontend multiplicaron por 100 de más, mostrando 450% en vez de 4,5%. Antes de tocar un `%`, confirmar la unidad contra el motor o el sembrado — nunca contra el nombre del campo.

### F. Arquitectura Modular del Módulo (`PlanillaComisionesPage`)
* **`<app-tabla-liquidacion>`:** Matriz contable desglosada por vendedora (Tipo A, B, C, sueldo base, bonos, USD y Bs).
* **`<app-configuracion-comisiones>`:** Componente `OnPush` aislado con las 9 secciones de configuración maestra (parámetros, vendedoras, tarifas A, C, B, histórico RA, captación, metas y reglas).
* **`<app-seleccion-planes>`:** Componente para auditar franquicias de paquetes/planes (`vendidos − objetivo`) y selección manual vs. automática.

---

## 📱 4. WhatsApp Multiagente y Atención a Pacientes

1. **Canal Oficial Único:** Uso exclusivo de **WhatsApp Cloud API (Meta)** sobre el número oficial. Prohibido el uso de teléfonos personales de agentes.
2. **Escopado de Bandeja:**
   * `AGENTE`: Solo ve sus conversaciones asignadas en "Mis Chats" y puede tomar las de "Sin Asignar".
   * `ADMIN` / `SUPER_ADMIN`: Visibilidad total de todas las conversaciones y capacidad de reasignar agentes.
3. **Eventos y Push:**
   * `emitirActividad()`: Actualiza pestañas web abiertas en tiempo real.
   * `notificarEntrante()`: Solo dispara notificación push cuando escribe un paciente real en `procesarEntrante`.
4. **Ventana de 24h (CSW) vs. 72h (Free Entry Point de Meta Ads) — no confundirlas:**
   * **CSW, 24h:** se abre con cada mensaje ENTRANTE del paciente. Mientras está abierta se puede mandar texto libre. Backend (`enviarMensaje`) y frontend (composer) bloquean el envío de texto libre pasadas las 24h — antes lo dejaban intentar y Meta lo rechazaba en segundo plano (error `#131047`), quedando "No enviado" sin que el agente supiera por qué al toque.
   * **FEP, 72h:** se abre solo si el lead llegó por un anuncio Meta Ads "Click to WhatsApp" y la clínica respondió dentro de la primera hora. **Ya se confundió una vez:** estas 72h **no** habilitan texto libre — solo evitan que se COBRE una plantilla. El texto libre depende exclusivamente de si la CSW de 24h sigue abierta.

---

## 📅 5. Módulo de Actividades & Seguimiento Comercial (`/actividades`)

1. **Propósito:** Agendamiento y seguimiento de llamadas, WhatsApps, citas médicas/comerciales, seguimientos post-venta y tareas internas.
2. **Modelo y Persistencia (`ActividadSeguimiento`):**
   * Vinculable de forma opcional a un prospecto (`leadId`) o a un paciente (`clienteId`).
   * Estados canónicos: `PENDIENTE`, `EN_PROGRESO`, `COMPLETADA`, `CANCELADA`.
   * Parámetros temporales: `fechaProgramada`, `duracionMinutos` (duración real de la cita/llamada) y `recordatorioMinutos` (anticipación de alerta previa).
   * Repetición automática (`DIARIA`, `SEMANAL`, `MENSUAL`): Al marcar una actividad con repetición como `COMPLETADA`, el sistema agenda de forma automática la siguiente instancia calculada.
3. **Escopado por Rol:**
   * `AGENTE`: Solo ve y gestiona sus actividades asignadas (`usuarioId`).
   * `ADMIN` / `SUPER_ADMIN`: Visibilidad global de actividades de toda la clínica y filtro por agente comercial.
4. **Notificaciones y Recordatorios en Vivo (WebSocket + Push):**
   * Cron/chequeo periódico emite el evento `recordatorio_actividad` por WebSocket (`ConversacionesGateway`) directo al socket del agente.
   * El topbar del layout contiene `<app-notificaciones-bell>`: conteo en tiempo real de actividades vencidas y programadas para hoy, panel con acceso rápido y botón para completar con un clic.
5. **Experiencia en Frontend:**
   * Calendario interactivo potenciado por `@schedule-x/calendar` (vistas: Día, Semana, Mes y Lista de agenda).
   * Modal optimizado y accesible para crear/editar actividades con selector de prospecto o cliente.
   * Botón de **Actividad Rápida** en la barra lateral de WhatsApp (`Conversaciones`) para agendar un compromiso comercial sin salir del chat con la paciente.

---

## 🎯 6. Estandarización de Búsqueda y Experiencia de Usuario Multi-Dominio

1. **Búsqueda Reactiva Debounced (200 ms):**
   * En `Leads`, `Clientes`, `Ventas` y `Servicios`, las barras de búsqueda operan con un debounce de 200 ms y `linkedSignal` / `computed()` para no saturar el backend en cada pulsación.
   * Si la consulta no arroja coincidencias, se despliega un `<app-empty-state icon="search">` con botón directo para limpiar el filtro.
2. **Cruce Universal con FileMaker (`pac` y `ci`):**
   * El código único del paciente en FileMaker (`pac`, ej. `PAC-1897`) y la Cédula de Identidad (`ci`) forman parte de la búsqueda indexada en todos los módulos comerciales y clínicos.
   * `ServiciosService.pacientes` utiliza `COALESCE(max(c.nombre), max(v.paciente))` para reflejar siempre el nombre actualizado de la ficha maestra de `Cliente`.
3. **Invariante de Cero Parpadeos (Zero-Flicker):**
   * Los esqueletos de carga (`<app-loading-skeleton>`) **solo** se renderizan durante la carga inicial con datos vacíos (`isLoading() && datos.length === 0`). Durante recargas en segundo plano o cambios de filtro, la tabla o tablero existente se mantiene visible.
   * La animación global `fadeInScale` es una transición pura de opacidad (0.12s) sin deformación de escala (`scale(0.96)` eliminado).

---

## 🚀 7. Comandos de Trabajo Rápido

### Backend (`/backend-crm-montalvo`)
```bash
npm run build                                    # Verificación total (check:skills + nest build)
npm test                                         # Tests unitarios rápidos
npm run test:integracion:preparar && npm run test:integracion  # Tests de integración con Postgres
npx prisma migrate dev --name <nombre> --create-only          # Crear migración sin aplicar
```

### Frontend (`/frontend-crm-montalvo`)
```bash
npm start                                        # Iniciar servidor local (ng serve)
npm run build                                    # Verificación completa (check:tipos + check:skills + ng build)
npm run sync:tipos                               # Sincronizar enums desde schema.prisma
```

