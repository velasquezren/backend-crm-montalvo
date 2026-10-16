# Estado actual

Última conciliación documental: **15/10/2026**, código base backend `c20e012`,
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

## Capacidades recientes que ya existen

| Tema | Estado comprobable y dónde continuar |
| --- | --- |
| IA por WhatsApp | Existe proveedor Gemini, clasificación, sugerencias/respuestas, audio y agenda del médico. Reservas conversacionales y QR incorporados el 15/10 (`2d70cd4`, `5dc4420`, `7daea1f`). Ver [asistente](asistente-ia.md); no reiniciar el plan «no hay IA» del 7/10. |
| Médicos a solicitud | `9efdd1f`, nota `c20e012`: el asistente coordina preferencias y deja `SOLICITUD_CITA`, sin inventar cupos. **Desplegado el 15/10** (19:46 La Paz, respaldo `/root/backup-crm-20261015-194528-cita-a-solicitud.sql.gz`); [guía](asistente-ia.md). |
| Recepción | Existe modo **Solo médicos** (`0e5600a`): pacientes atendidos por personas/menú y médicos autorizados por el asistente. Configuración registrada en el [historial de octubre](historial/estado-2026-10.md). |
| Agenda y pagos | Web, Flow y asistente usan `AgendaReservasService`; `ReservaChat` enlaza QR/comprobante. Una reserva y un comprobante no equivalen a confirmación de Caja. [Agenda](agenda.md), [pago por chat](reservas-pago-chat.md). |
| Horarios FileMaker | Backend y frontend implementados (`06a0ac0`, `9b31bb7`); despliegue y bandera activa registrados en `62a6777`. **Aceptación desde FileMaker pendiente**: [procedimiento](filemaker-horarios.md). |
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

- **FileMaker:** pegar la credencial por canal privado y ejecutar la aceptación
  con un médico. No se puede certificar con los dobles MySQL de las pruebas.
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
