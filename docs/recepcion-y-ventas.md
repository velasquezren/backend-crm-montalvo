# Recepción y Ventas — preparación local del 2026-10-06

## Criterio funcional

| Recorrido | Atención / Recepción | Ventas |
|---|---|---|
| Texto libre, adjuntos, historial y persona disponible | Se conserva | Se conserva |
| Menú de servicio: ubicación, información aprobada, solicitud de cita | Opcional, sin activación nueva | Opcional |
| Flow de solicitud de cita autorizado | Conserva su configuración; no confirma citas | Conserva su configuración; no confirma citas |
| Promociones del CRM, tarjetas, atribución de código PRM | No | Sí |
| Configurar QR y ofrecer un pago nuevo | No | Sí |
| Plantillas de marketing aprobadas | No se ofrecen ni se envían | Sí, con las validaciones existentes |
| Plantillas de utilidad / avisos de resultados | Se conservan | Se conservan |
| Revisar pagos | Solo lectura para roles operativos | Agente/admin con acceso al chat |

Recepción conserva la atención compartida. Ventas conserva cartera, asignación y
solicitudes pendientes. No se traslada una conversación de número ni se crea un
lead comercial porque alguien escriba un código de promoción a Recepción.

## Comportamientos corregidos

- Menús: el backend rechaza opciones comerciales en Atención y detiene menús
  heredados incompatibles. Los muestra con el motivo, sin borrar la configuración.
- QR: lectura administrativa, guardado y subida exigen línea comercial antes de
  firmar/subir archivos. Una configuración antigua de Atención no habilita pagar.
- Pago: comprueba dentro de la transacción que conversación y línea coinciden.
- Entrada: mensajes y selecciones siguen conservándose; un botón antiguo de pago
  en Atención pide revisión humana, sin QR ni pago nuevo. Se mantiene deduplicación.
- Salida: acciones comerciales tipadas se rechazan también desde el compositor.
  El despachador detiene reintentos de ofertas comerciales y QR en Atención.
- Plantillas: categoría MARKETING filtrada tanto en catálogo fresco como en caché
  y respaldo. El registro compartido bloquea el envío de marketing desde Atención,
  incluidos los llamadores internos. Utilidad continúa por la tubería existente.
- Revisión de comprobantes: pedir otro y anular ahora exigen el mismo rango
  comercial que confirmar. UI y backend coinciden.
- UI: Atención no muestra configuración de cobro ni permite agregar/deshacer una
  opción promocional. Guardar con envíos desactivados ya no anuncia que está
  funcionando. Etiquetas largas disponen de una columna en el editor.

Se reutiliza `comercial`; no hay nuevas tablas, dependencias, transportes Meta,
colas, asignadores ni migraciones. Continúan `clientMessageId`, snapshots cifrados,
webhook único, deduplicación y Socket.IO existentes.

## Referencias y adaptación

[HubSpot: reglas de enrutamiento](https://knowledge.hubspot.com/inbox/set-your-conversations-routing-rules)
documenta asignación por canales/equipos y acceso al inbox. Se conserva aquí la
distinción existente entre bandeja compartida y cartera comercial.

[Intercom: asignación a personas y equipos](https://www.intercom.com/help/en/articles/6561699-assign-conversations-to-teammates-and-teams)
separa equipo y persona responsable; también distingue asignar de intervenir en la
conversación. No se copia su automatización: Montalvo conserva la pausa humana
explícita existente y su contexto persistido.

Estos son patrones concretos de productos consolidados, no una clasificación de
«mejores CRM» ni evidencia de que todas sus funciones sean adecuadas para una clínica.

## UX revisada desde código

Sin navegador, conforme a la guía de este repositorio. A 390 px el cajón deja
350 px de contenido; las opciones, tras padding y bordes, dejan unos 320 px.
Cada campo ocupa una fila. A escritorio, el cajón de 720 px deja 680 px; con
vista previa de 288 px y separación de 20 px quedan 372 px para el editor.
Dividir cada opción en dos campos dejaba aproximadamente 165 px: se eliminó esa
división. Los avisos permiten varias líneas; acciones de la tabla usan flex-wrap.
Se mantienen átomos, foco, botones con nombre accesible, cuatro estados y
animaciones existentes con movimiento reducido. No se agregaron animaciones globales.

## Límites y puesta en producción

- Preparación local, sin push, despliegue, cambio de flags, migración de producción,
  llamadas a pacientes ni modificaciones remotas de Meta.
- No se presume que Recepción deba activar un menú o Flow. Si se quiere atención
  completamente manual, debe mantenerse apagado su menú; no se cambió producción.
- La separación se aplica a capacidades conocidas e identificadores internos.
  No analiza semánticamente textos libres escritos por una persona.
- El Flow autorizado sigue siendo una **solicitud**, no una reserva transaccional.
- Los enlaces públicos de promociones deben apuntar a un número comercial antes
  de habilitar el recorrido. No se eligió ni cambió un número real por inferencia.
- Si existen menús de Recepción con promociones, al desplegar dejarán de enviarse
  hasta quitar esa opción. Es un cambio intencionado que debe revisarse antes.
- Pagos históricos no se borran: agentes/admin con acceso pueden resolverlos;
  no se mueve historial ni se reinicia la atribución comercial.
- No se afirma ausencia universal de deuda técnica: la verificación cubre estos
  límites y las regresiones ejecutadas, no una auditoría de todo el CRM.

## Evidencia local

- `npm run prisma:generate`: cliente local regenerado desde el esquema actual;
  no se cambió el esquema. Las migraciones existentes se aplicaron únicamente a
  PostgreSQL 16 descartable, loopback, puerto 5433, `crm_test`.
- Backend: `npm test -- --runInBand`, 69 suites y **877 pruebas** correctas.
- Integración completa: 42 suites; 39 correctas en la primera ejecución tras
  regenerar Prisma. Se corrigieron una espera prematura de transporte y fixtures
  incompatibles con la nueva política. Repetición de las tres suites afectadas:
  **140 pruebas correctas** (conversaciones, pagos, inicio de chat), incluyendo
  los nuevos casos de aislamiento, reintento de tarjeta/QR, marketing y roles.
- La suite histórica de verificación de diciembre avisa que no dispone de Excel
  externos y omite sus aserciones. No se cuenta como evidencia de esta entrega.
- `npm run test:flows`: **12 pruebas** correctas; validación local de borradores,
  sin operaciones remotas.
- Angular: ejecución completa final, **79 suites / 624 pruebas** correctas.
- Builds de ambos repositorios y sus `check:tests` correctos; checks de skills,
  tipos generados, Flows y `git diff --check` correctos.
- PostgreSQL descartable detenido al terminar. Nada se envió a Meta o a pacientes.
