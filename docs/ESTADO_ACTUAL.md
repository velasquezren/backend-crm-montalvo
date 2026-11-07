# Estado actual

Última conciliación documental: **15/10/2026** (filas de Resultados y FileMaker revisadas el **06/11/2026**), código base backend `c20e012`,
frontend `9b31bb7`. Esto no certifica el estado remoto de hoy: los despliegues
que se citan son los registrados en el historial. Compruebe Git y los cambios
locales al comenzar; una modificación sin commit puede pertenecer a otra tarea.

## Para retomar

1. Parta de la petición actual, no del último «siguiente paso» de una auditoría.
2. Busque el dominio en [el índice](README.md) y su responsabilidad en
   [PANORAMA](PANORAMA.md). Lea solo las secciones implicadas.
3. Antes de proponer una implementación, busque su símbolo, ruta y pruebas en
   el código; contraste con `git log --all -- <ruta>`.
4. Diferencie **implementado**, **probado localmente**, **despliegue registrado**
   y **comprobado en vivo**. Ni un build ni este documento prueban los cuatro.

### Desde otra máquina

- Clonar con SSH (`git@github.com:velasquezren/...`): backend y frontend del CRM y
  `backend-resultados-montalvo`. La clave SSH de la máquina nueva tiene que estar
  en GitHub y, para desplegar, en `authorized_keys` de root en `107.175.132.15`.
- `.env` no está en Git: crearlo desde `.env.example` (local) y nunca copiar el
  de producción. Postgres local en `:5433` con `crm` y `crm_test`
  (`npm run test:integracion:preparar`).
- Conectores de Meta para Claude Code (se configuran por máquina):
  `claude mcp add --transport http whatsapp_business_tools https://mcp.facebook.com/whatsapp_business_tools`
  y autorizar con `/mcp`. Es el que crea plantillas.

## Capacidades recientes que ya existen

| Tema | Estado comprobable y dónde continuar |
| --- | --- |
| Nombres de usuario de WhatsApp (BSUID) | **Desplegado el 25/10** (backend `d22ef19`, Vercel `7893a4e`): el webhook ya no descarta a quien escribe sin teléfono; `Cliente.waUsuarioId`, envío por `recipient`, cambios de BSUID y frontend sin número. Migración `contacto_whatsapp_bsuid` aplicada. [Contrato](lineas-whatsapp.md#nombres-de-usuario-de-whatsapp-bsuid-23102026). |
| Plataforma del backend | **Desplegado el 25/10** (`d22ef19`, 20:43 La Paz, respaldo `/root/backup-crm-20261025-204055-bsuid-nest11.sql.gz`): NestJS 11 (Express 5), `exceljs` en vez de SheetJS (lectura idéntica al export real con TZ del VPS), Prisma 7.10.1, CI con `.nvmrc`; `npm audit --omit=dev` de 23 a 2 moderadas no aplicables. Tareas con `@TareaPeriodica` y pg-boss (`TRABAJOS_PGBOSS`, migración `pgboss_trabajos`); rastreo de errores (`SENTRY_DSN`) y latido (`LATIDO_URL`). Banderas sin poner en el servidor: todo sigue apagado (temporizadores). [Arquitectura §5](../.claude/skills/crm-backend-arquitectura/SKILL.md). |
| Aviso de ventas a Meta (CAPI) | Desplegado el 25/10 y **apagado** (`META_CONVERSIONES`): encenderlo lo decide la clínica por la política de salud de Meta. [Guía](conversiones-meta.md). |
| Resultados multítipo | **Desplegado el 25/10**: Resultados `4cb6ada` (release `20261025-multitipo-4cb6ada`, migración `tipos_informe_referencia`), CRM `d22ef19`, Vercel `7893a4e`. Tipos clínicos, filtros antes de paginar, identidad estricta y referencias por tipo. Guion de Papanicolau documentado en Resultados; laboratorio configurado y probado el 26/10 en FileMaker y con PDF sintético en el servidor. Falta registrar aceptación del primer envío clínico por botón. [Guía de laboratorio](https://github.com/velasquezren/backend-resultados-montalvo/blob/main/docs/filemaker-laboratorio.md). [Contrato y orden de publicación](informes-por-whatsapp.md#cola-multítipo-de-resultados-desplegada-el-25102026). |
| Transcripción interna de audios | Activada el 17/10 (`e935c2f`) en Recepción y Ventas para nuevos audios entrantes; conserva `SOLO_MEDICOS`/`RESPONDER`. Cola durable, texto bajo el audio y actualización en vivo, sin respuestas por esta función. [Contrato y verificación](asistente-ia.md#transcripción-interna-para-las-agentes-17102026). |
| IA por WhatsApp | Existe proveedor Gemini, clasificación, sugerencias/respuestas, audio y agenda del médico. Reservas conversacionales y QR incorporados el 15/10 (`2d70cd4`, `5dc4420`, `7daea1f`). Ver [asistente](asistente-ia.md); no reiniciar el plan «no hay IA» del 7/10. |
| Médicos a solicitud | `9efdd1f`, nota `c20e012`: el asistente coordina preferencias y deja `SOLICITUD_CITA`, sin inventar cupos. **Desplegado el 15/10** (19:46 La Paz, respaldo `/root/backup-crm-20261015-194528-cita-a-solicitud.sql.gz`); [guía](asistente-ia.md). |
| «Marcar atendida» | Resuelve y devuelve el chat a lo automático; desde `cc23475` la IA contesta el siguiente mensaje sin esperar los 15 min tras el último de una persona ([atención](atencion-humana.md)). Frontend `4279582` lo dice en el aviso. **Desplegado el 15/10** (20:17 La Paz, respaldo `/root/backup-crm-20261015-201607-marcar-atendida.sql.gz`; Vercel `5bc05e6`). |
| Recepción | Existe modo **Solo médicos** (`0e5600a`): pacientes atendidos por personas/menú y médicos autorizados por el asistente. Configuración registrada en el [historial de octubre](historial/estado-2026-10.md). |
| Agenda y pagos | Web, Flow y asistente usan `AgendaReservasService`; `ReservaChat` enlaza QR/comprobante. Una reserva y un comprobante no equivalen a confirmación de Caja. [Agenda](agenda.md), [pago por chat](reservas-pago-chat.md). |
| Horarios FileMaker | René confirmó envíos individuales; `DR1110` se verificó sincronizado. Soporte 15/30 min desplegado el 16/10: backend `1439106`, frontend `120400b`, migración MySQL y permisos comprobados. `DR2435` aún sin envío recibido; falta pulsar su botón en FileMaker. [Procedimiento y evidencia](filemaker-horarios.md). |
| Aviso de ecografía y laboratorio desde FileMaker | **Desplegado y en uso** (04/11, prod `4544ae0`; activado 09:47 con la cuenta `filemaker@montalvo.com`, ASISTENTE + línea Recepción). Los guiones de Ecografía (`ENVIAR PDF AL PORTAL`) y de Labtrio piden destino, permiten «Cambiar número» y avisan; primeros avisos reales 04/11 13:31. Falta una prueba con ficha de prueba y el número de René, y rotar el token del guion. [Activación y revisión de guiones](filemaker-avisos-ecografia.md). |
| Aviso a un número de otra ficha (FileMaker) | **Desplegado el 06/11 13:22** (`be77c20`, respaldo `/root/backup-crm-20261106-132007.sql.gz`, `dist.anterior` como vuelta atrás): «Cambiar número» con el WhatsApp de otra ficha (un familiar) manda el aviso a ese chat sin tocar fichas; migración `destino_aviso_resultado`. [Contrato](filemaker-avisos-ecografia.md#enviar-a-un-número-de-otra-ficha-06112026). |
| «Recibir PDF» al destinatario elegido en FileMaker | **Corrección desplegada el 07/11** (`16cb16f`, rama `hotfix/recibir-pdf-destinatario-20261107`, sobre `be77c20`; equivalente en main `515017e`): si el destinatario tiene un PAC propio que no existe en Resultados, ya no corta la consulta antes de resolver al paciente autorizado. 16 integraciones sintéticas y build aprobados. Respaldo `/root/backup-crm-pap-20261107-090547/` (base y dist); salud y guardas HTTP verificados. Producción quedó en HEAD separado: para un futuro despliegue completo, cambiar explícitamente a `main` antes del pull. Los cambios de 40 MB y Climon de las filas siguientes siguen pendientes. |
| «Recibir PDF» hasta 40 MB | **Sin desplegar** (`ac38454`, 06/11): el CRM baja y sube a Meta informes de hasta 40 MB (antes 15). El portal de Resultados ya acepta 40 MB (desplegado 06/11 14:15). Sin esto, el «Recibir PDF» de un informe de más de 15 MB queda en REVISIÓN. Desplegar cuando René lo pida. |
| Laboratorio avisa desde su línea | **Sin desplegar** (`ff41118`, 06/11): con `RESULTADOS_LAB_LINEA_ID` los informes LABORATORIO salen por la línea Laboratorio CLIMON (+591 77385889) con `climon_resultado_laboratorio`. Plantilla creada el 07/11 (id `28725450153822938`, PENDING): falta que Meta la apruebe; luego desplegar y encender. [Pasos](plantillas-whatsapp.md#7-climon_resultado_laboratorio--aviso-de-laboratorio-desde-la-línea-de-climon). |
| Mis informes | Implementado; despliegue del 13/10 registrado para prueba y Recepción (`ed7f204`, Resultados `1604ded`). [Contrato, permisos y banderas](informes-por-whatsapp.md). No tratarlo como preparación sin desplegar. |
| Promociones y directorio | Pantallas Angular, API pública, tarjetas y reconocimiento PRM implementados. El directorio está enlazado a la agenda; [guía](promociones-y-directorio.md). |
| PDF y autor del mensaje | Límite de PDF 15 MB (`f599547`, frontend `a57f9a6`); autor humano incorporado en `ee0806f`. Columnas nuevas requieren sus migraciones versionadas. |

## Trabajo cerrado: consultar antes de reabrir

Estos registros evitan repetir investigaciones. Una regresión nueva puede
justificar reabrirlos; una lista antigua de pendientes, por sí sola, no.

| Trabajo | Evidencia y límite |
| --- | --- |
| F01–F10 | Cierre de septiembre y pruebas en [historial](historial/estado-2026-09.md). Contratos detallados en auditorías F02–F09; no quedan como plan de implementación activo. |
| F06-R1/R2, envío y recepción durables | [Adjuntos](auditoria-f06-r1.md), [primer contacto](f06-r2-primer-contacto-durable.md), [salientes](auditoria-f06-entrega2.md). Conservar idempotencia y estado incierto. |
| R2.2 y R3 | [Cierre técnico](CIERRE-TECNICO-2026-09.md). PWA sin recarga forzada es decisión deliberada. Mediciones de septiembre no prueban el rendimiento actual. |
| Último mensaje del inbox | `lectura-mensajes-inbox.ts` usa SQL lateral con `LIMIT 1`; [auditoría del 1/10](auditoria-2026-10-01.md), `inbox-escala.integracion.spec.ts`. No repetir el diagnóstico de `take: 1` de septiembre. |
| MIME saliente | `contenido-adjunto.ts` y su spec; el despachador lo usa. El fallo de decidir por extensión ya se corrigió. |
| CAMP-1 | [Contrato de atribución](CAMP-1-atribucion-venta-lead.md), `VentasService.corregirOrigen` y pruebas de ventas. `Venta.leadId` manda; no reconciliar `Lead.estado` por inferencia. CAMP-0 es diagnóstico histórico, no orden de construir ROAS/CAPI. |
| IA derivaba después de validar la reserva | `7daea1f`; `conversacion-asistente.spec.ts`. Una salida vacía con acción válida no es fallo; no añadir otra IA o flujo de reservas para resolverlo. |

## Pendientes con alcance explícito

- **Banderas del 23/10** (desplegado el 25/10): encender por separado `TRABAJOS_PGBOSS`, `SENTRY_DSN` y `LATIDO_URL`. Cada cambio de enum en el backend exige subir el `ref:` fijo del CI del frontend.
- **Respaldo externo:** activo desde el 26/10 en `gs://crm-clinica-montalvo-respaldos`, con restauración probada ([arquitectura §4](../.claude/skills/crm-backend-arquitectura/SKILL.md)). Las copias locales de Resultados (`/root/backups-resultados`) retienen 7 días desde el 26/10. Red (Cloudflare/WireGuard) sigue pendiente.
- **FileMaker:** reenviar el horario 08:30–11:45 de `DR2435`; soporte 15/30 ya desplegado. El envío individual ya funciona; carga colectiva y activador automático todavía requieren aceptación dentro de FileMaker.
- **Clínica:** conocimiento y criterio de derivación por línea, orientación de
  emergencia y contenidos públicos. Las guías describen requisitos; no prueban
  cómo está configurada hoy cada línea.
- **Lectura automática del comprobante de reserva:** el registro/asociación
  existe; la lectura de IA se aplica a promociones. No confundir ambos caminos.
- **Scripts antiguos de importación:** `seed-admin.js` e `import-pacientes.js`
  conservan imports anteriores a Prisma 7. No ejecutarlos sin adaptar y probar
  en una base descartable; se preservan como procedencia de importaciones.
- **Dependencias y propuestas de la revisión del 10/10:** conservar evidencia
  en [auditoría del 1/10](auditoria-2026-10-01.md) y
  [revisión del 10/10](REVISION_2026-10-10.md). No se certificaron de nuevo
  vulnerabilidades, cuotas, cuentas Meta, índices ni configuración de producción.
  Antes de retomar una propuesta, comprobar código, historial y necesidad actual.
- **Edad de pacientes:** `servicios/normalizacion.ts` todavía usa fecha local
  del proceso; propuesta de fecha civil de La Paz no implementada en esta auditoría.

## Continuidad e historial

- [Octubre hasta el 15/10](historial/estado-2026-10.md): despliegues, aceptación,
  pruebas y decisiones de agenda, IA, pagos e informes.
- [Septiembre](historial/estado-2026-09.md): F01–F10, R2/R3, CAMP-1 y antecedentes.
- Para un cambio futuro, actualizar **la guía del dominio** si cambia su contrato.
  Actualizar aquí solo estado/pending que afecte a la siguiente sesión, con ruta
  de evidencia y límite de verificación. Git conserva el detalle de cambios.
  No agregar un nuevo handoff por conversación ni volver a acumular aquí bitácoras.
