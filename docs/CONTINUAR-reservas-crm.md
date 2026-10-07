# Continuar: pantalla «Reservas» del CRM (traspaso del 7/10/2026)

Documento para retomar en otra máquina. Trabajo **a medias en la rama
`reservas-crm`** del backend (no en `main`). El frontend y la landing no tienen
cambios pendientes. Al terminar, borrar este archivo y llevar lo que importe a
`ESTADO_ACTUAL.md`.

```bash
cd backend-crm-montalvo && git fetch && git switch reservas-crm   # el trabajo a medias
cd ../frontend-crm-montalvo && git pull                            # main, sin cambios pendientes
cd ../montalvo && git pull                                         # landing, sin cambios pendientes
ssh-add ~/Escritorio/clave-casa                                    # en una terminal normal (pide passphrase)
```

Antes de tocar nada, leer en este orden: `docs/PANORAMA.md`, `docs/ESTADO_ACTUAL.md`
(secciones «Reserva real desde la landing» y «Agenda ScriptCase»),
`docs/auditoria-agenda-vps-2026-10-06.md`, y los skills `crm-backend-module`
(backend) y `crm-feature-page`, `crm-design-system`, `crm-ui-desde-codigo` (frontend).
René **no quiere validación en navegador**: la UI se valida leyendo el código.

---

## 1. Qué está en producción (y funciona)

**La agenda real es ScriptCase + MySQL `clinica` en `montalvo-vps` (23.95.128.187)**,
que alimenta FileMaker por ODBC. René: «el MySQL lo usa FileMaker, no lo toques» →
el CRM solo lee, y escribe reservas **exactamente** como el formulario de ScriptCase.

| Pieza | Estado | Dónde |
| --- | --- | --- |
| Lectura pública (landing): especialidades, médicos, días con cupo, horas libres, fotos, QR | Desplegado, `AGENDA_VPS_LECTURA=on` | `src/modules/agenda` · `GET /publico/agenda/*` |
| Reserva web real: INSERT en `para_agendar` (PENDIENTE) + pago con comprobante (PAGADO = a verificar por caja) + Telegram | Desplegado, `AGENDA_VPS_RESERVAS=on` | `POST /publico/agenda/reservas`, `/reservas/pago` |
| Landing `/reservar` → «Reservar en línea» (7 pasos con datos reales) | Desplegado (Vercel) | repo `montalvo`, `booking/web/` |
| Backend en producción | `5a6b653` (main) | `/opt/crm-backend` |

Usuarios MySQL ya creados en `montalvo-vps` (todos `@'107.175.132.15'`, `REQUIRE SSL`):

| Usuario | Para qué | Permisos |
| --- | --- | --- |
| `crm_agenda_lectura` | Rutas públicas | SELECT columnas públicas de `medicos` (incl. `foto`), `horarios`, `vista_horas_libres`, `para_agendar(medico_pk,fecha,hora,estado)`, `pagos_qr(qr_pk,Qr,fecha_vence)` |
| `crm_agenda_reserva` | Reservar | SELECT mínimo + INSERT de las 17 columnas de ScriptCase + UPDATE `comprobante,nit,razon_social,estado` en `para_agendar` |
| `crm_agenda_consulta` | **Pantalla Reservas (pendiente de crear)** | Ver §3 |

Contraseñas y secretos **solo** en `/opt/crm-backend/.env` del servidor (nunca en el
chat ni en git). Variables `AGENDA_*` documentadas en `.env.example`.

## 2. Lo que René pidió y decidió (no reabrir)

1. «Mi CRM no ve las reservas»: hace falta una **pantalla Reservas** en el CRM con
   todas las reservas de la agenda (web y ScriptCase: no se distinguen, escriben igual)
   y, **desde el chat**, ver las reservas de esa paciente. Lo pidió «de la manera
   correcta, siguiendo buenas prácticas y mis skills».
2. **Quién ve la pantalla completa** (decidido): recepción, asistente y administración
   (`puedeVerAgendaClinica`, ya en `src/common/auth/roles.ts`). Una agente de ventas
   ve las reservas de una paciente **solo desde su chat**, si puede ver ese chat
   (`whereAccesoConversacion` de `modules/conversaciones/acceso-conversacion.ts`).
3. Después (fase aparte, ya ofrecida): importar al **Directorio médico del CRM** los
   53 médicos / 25 especialidades / fotos de la agenda, enlazando por código de FileMaker.

## 3. Lo hecho en la rama `reservas-crm` (compila, 891 pruebas en verde)

- `agenda-lector.ts`: base `LectorAgenda` (pool TLS, transacción READ ONLY, tiempo
  máximo). `agenda-vps.client.ts` ahora la extiende (cuenta pública); sin cambio de
  comportamiento, sus pruebas pasan.
- `agenda-consulta.client.ts`: cuenta interna `crm_agenda_consulta`, bandera
  `AGENDA_VPS_CONSULTA`.
- `agenda-consulta.sql.ts`: `listarReservasAgenda` (rango, estado, búsqueda por
  nombre/CI/teléfono/número, página + total + cuenta por estado), `reservasPorTelefono`
  (compara dígitos con y sin 591), `comprobanteDeReserva` (BLOB bajo demanda).
- `dto/reservas-crm.dto.ts`: `QueryReservasAgendaDto` (desde, hasta, estado con `@IsIn`, buscar).
- `common/auth/roles.ts`: `puedeVerAgendaClinica(rol)`.
- `scripts/agenda/crear-usuario-consulta.sh`: crea `crm_agenda_consulta` (lo ejecuta
  René; pide la clave root de MySQL; guarda la contraseña en el `.env`). Al final
  imprime los estados reales de `para_agendar`: si aparece uno que no sea
  PENDIENTE/PAGADO/ATENDIDO, añadirlo a `ESTADOS_RESERVA_AGENDA`.

**Todavía nada de esto está conectado a un controller ni al módulo.**

## 4. Lo que falta, en orden

### Backend (`modules/agenda`)

1. `agenda-reservas-crm.service.ts` (`ReservasAgendaService`):
   - `listar(query, usuario)`: `puedeVerAgendaClinica(usuario.rol)` o 403. Rango por
     defecto hoy..hoy+29 (`fechaCivilClinica`/`textoDeFechaCivil`), validar fechas que
     existen, `desde<=hasta`, máximo 92 días. `calcularPaginacion` + `paginar`, y
     además `porEstado` y el rango. Presentar: `precio` con `precioDelVps`,
     `telefonoE164` con `normalizarTelefono` (para el enlace `/conversaciones?telefono=`).
   - `deConversacion(conversacionId, usuario)`: `prisma.conversacion.findFirst({ where:
     { id, ...whereAccesoConversacion(alcanceAgente(usuario)) }, select: { cliente:
     { select: { telefono: true } } } })` → 404 si no; teléfono `+591XXXXXXXX` →
     `reservasPorTelefono(local, hoy)`. (Leer otra tabla para agregar está permitido.)
   - `comprobante(id, usuario)`: misma capacidad; detectar tipo por bytes (jpeg/png/
     webp/gif/pdf), `Cache-Control: private, no-store`, y **auditar** la apertura
     (`AuditService.registrar('ReservaAgenda', String(id), 'COMPROBANTE_AGENDA_VISTO', usuario.sub)`).
2. `agenda-reservas-crm.controller.ts` en `/agenda/reservas` (con sesión, NO `@Public`):
   `GET /`, `GET /conversacion/:id`, `GET /:id/comprobante`. Registrar controller,
   `AgendaConsultaClient` y el service en `agenda.module.ts` (importar `AuditModule`
   si no es global y `PrismaService`).
3. Pruebas: extender `test/agenda/legado-sintetico.sql` (columnas de paciente ya
   existen; crear el usuario `crm_agenda_consulta` sintético) y
   `agenda.mysql.integracion.spec.ts`: filtros, búsqueda con `%`, por teléfono con y
   sin 591, comprobante, y que el usuario de consulta no puede escribir. Unitarias
   para la capacidad por rol. Correr `bash scripts/probar-agenda-mysql.sh`.
4. `.env.example`: `AGENDA_VPS_CONSULTA`, `AGENDA_CONSULTA_USUARIO`, `AGENDA_CONSULTA_PASSWORD`.
5. Docs: fila de `modules/agenda` en `PANORAMA.md`, `ESTADO_ACTUAL.md`.

### Frontend (`frontend-crm-montalvo`)

6. `core/auth/roles.ts`: espejo `puedeVerAgendaClinica` + guard (como `exigeEntregaResultados`).
7. `features/reservas/`: `reserva.model.ts`, `reservas.service.ts` (solo `*Request()` y
   `comprobante()` con `ApiService.getBlob`), `reservas.page.ts/.html`:
   cabecera, chips de periodo (Hoy / 7 días / 30 días / Últimos 30) y de estado con
   `count` de `porEstado` en un `role="group"`, buscador con debounce, `<app-table>`,
   `<app-paginator>`, **cuatro estados** con `<app-error-carga>`. Estados en badge:
   PENDIENTE «Pendiente de pago» (neutral), PAGADO «Pago por verificar» (info),
   ATENDIDO «Atendida» (success). Monto con el pipe `moneda`. Fila → `<app-drawer>`
   con datos, `.crm-accion-enlace` a WhatsApp y «Ver conversación»
   (`/conversaciones?telefono=`), comprobante con `<app-image-viewer>` (blob → objectURL,
   revocar al cerrar).
8. Ruta `reservas` con el guard y `NavItem` `{ path: '/reservas', label: 'Reservas',
   icon: 'calendar', rolMinimo: 'ADMIN', roles: ['RECEPCION', 'ASISTENTE'] }`
   (ver `nav-items.ts`; ojo: «Actividades» ya usa `calendar`, elegir otro icono del catálogo si existe).
9. Chat: bloque «Próximas reservas» en la ficha lateral de la conversación (leer el
   skill `crm-conversaciones` antes), con `GET /agenda/reservas/conversacion/:id`;
   si la agenda no responde, el bloque se oculta sin romper el chat.
10. `npm run build` (compuerta), pruebas, y revisar la UI con `crm-ui-desde-codigo`.

### Despliegue (orden obligatorio)

11. René ejecuta `bash scripts/agenda/crear-usuario-consulta.sh` (en su terminal).
12. Backend: respaldo verificado → `git pull` → `npm ci` → build **sin tuberías que
    oculten el error** (`npm run build > /tmp/build.log 2>&1 && systemctl restart …`) →
    poner `AGENDA_VPS_CONSULTA=on` → reiniciar → `curl` health/400/401 y las rutas nuevas
    con un token. Receta completa en el skill `crm-backend-arquitectura` §4.
13. Merge de `reservas-crm` a `main` del backend; luego push del frontend (Vercel
    publica solo). Actualizar el SHA del schema en `frontend/.github/workflows/calidad.yml`
    solo si cambió el schema (no debería).

## 5. Trampas que ya mordieron en esta sesión

- **`npm run build | tail` oculta el fallo**: el primer despliegue del 6/10 reinició con
  el binario viejo. Verificar siempre `date -r dist/main.js`.
- **`check:skills` exige que todo módulo esté en `PANORAMA.md`**: falla en el servidor
  si la doc va en un commit aparte.
- **`validate_password`** del MySQL rechaza contraseñas sin mayúscula+minúscula+número+símbolo.
- **El límite de 120 peticiones/min por IP** también aplica a pruebas desde el servidor:
  no barrer la agenda con cientos de peticiones.
- **ConfigService prioriza `process.env`** sobre la configuración pasada al constructor
  (lo descubrió la prueba de identidad TLS).
- Alcance por rol: nunca `rol === '…'`; usar las funciones de `roles.ts` (el build lo exige).
- Archivos de otras IAs sin commitear (`AGENTS.md`, `AI_GUIDE.md`, `GEMINI.md`,
  `.cursor/`, cambios a `CRM_MANIFESTO.md`/`README.md` del frontend): no son de esta
  tarea; no incluirlos en commits sin preguntar a René.

## 6. Otros pendientes de René (no son de esta tarea)

- Hacer una reserva de prueba de punta a punta en la landing y pedir a recepción que la
  anule (verifica el paso a FileMaker/caja).
- Vercel: `CRM_REVALIDAR_SECRETO` (aviso instantáneo de promociones/directorio).
- Seguridad `montalvo-vps`: `/progs/prod040326.zip` público, phpMyAdmin y Webmin
  abiertos, sin respaldos de MySQL (ver memoria «seguridad-vps»). Sin aprobar.
