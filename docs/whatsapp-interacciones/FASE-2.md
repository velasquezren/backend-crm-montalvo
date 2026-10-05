# Fase 2 — integración local de interacciones Meta

Fecha: 2026-10-04. Sin push, despliegue, mensajes reales, IA ni operaciones sobre activos Meta. La preparación de fase 1 se reutiliza.

## 1. Cambios realizados

| Área | Archivos | Cambio |
|---|---|---|
| Entrada | `webhooks/dto/whatsapp-webhook.dto.ts`, `webhooks/whatsapp-webhook.controller.ts` | Contexto, timestamp y `nfm_reply`; recuperación del mensaje original desde bytes ya verificados por el guard existente. El whitelist sigue validando el perímetro. Tipos desconocidos con ID/remitente se conservan cifrados. |
| Persistencia | `ingesta-whatsapp.service.ts`, `interacciones-integracion.ts` | Mensaje, estructura, correlación y actualización de conversación en la misma transacción. Índice Meta existente deduplica reintentos. No se ejecutan acciones ni automáticos por el texto de una selección. |
| Salida | `dto/enviar-mensaje.dto.ts`, `conversaciones.controller.ts`, `conversaciones.service.ts` | El POST existente `/:id/mensajes` acepta `interaccion` opcional; exige `clientMessageId`, ventana de 24 h y acceso vigente. No permite adjuntar media simultáneamente. Valida límites antes de guardar. No existe otro endpoint ni cliente Meta. |
| Despacho | `despachador-saliente.service.ts`, `reintento-saliente.service.ts` | Guarda oferta cifrada y reconstruye la misma intención tras reinicio. Compare-and-set a INCIERTO antes de llamar al cliente existente; resultado incierto jamás genera reenvío automático. Los rechazos definitivos conocidos siguen el barrido existente. |
| Plantillas | `plantillas-whatsapp.ts`, `conversaciones.service.ts`, `despachador-saliente.service.ts` | Quick replies de plantillas aprobadas: payload estable por nombre/idioma/posición, con copia de opciones ofrecidas. No se deduce la acción del título. Se conserva la política actual de no reintentar automáticamente plantillas. |
| Historial | `conversaciones.service.ts` | Proyección permitida en detalle y páginas antiguas, siempre después de verificar permisos. Inbox y Socket.IO conservan sus contratos. Nunca se incluye la relación privada completa. |
| Angular | `conversacion.model.ts`, `conversacion-thread.component.ts/html`, `interaccion-preview.component.ts/spec.ts` | Conecta el componente preparado al hilo real; muestra selección, estado, referencia local y versión. Detalles nativos accesibles, sin JSON, tokens ni acciones de envío. No se construye un compositor/Flow Builder nuevo. |
| Flows locales | `flows/solicitud-cita.v1.json`, `flows/interes-promocion.v1.json` | Añade `flow_version` fijo al resultado para correlacionar la revisión esperada. Continúan siendo borradores DEMO locales. |

Los tipos y constructores puros de fase 1 permanecen. No se añaden dependencias npm.

### Correlación

Se busca el mensaje SALIENTE por `context.id` **dentro de la conversación receptora**. Esta identifica cliente y línea. Además se compara el teléfono con el snapshot del destinatario: cambiar el teléfono de la ficha no redirige un reintento pendiente. Se comprueban el tipo de respuesta, ID de opción ofrecida, timestamp desde el envío, vencimiento de la oferta (24 h) y hora de recepción. Para Flows se exige token aleatorio del servidor, ID/version guardados, `flow_version` coincidente y campos/valores expresamente admitidos por el contrato guardado. Los campos personales permitidos quedan privados, nunca se expanden en UI.

`flow_token` solo es una correlación adicional. No autoriza consultar datos, reservar, enviar documentos o ejecutar herramientas. La identidad aquí es la cuenta de WhatsApp reconocida por el webhook firmado, **no una verificación clínica de identidad del paciente**.

Un UPDATE condicionado consume la oferta una vez. Dos mensajes Meta distintos que respondan simultáneamente quedan `CORRELACIONADA` y `DUPLICADA`; repetir el mismo wamid no crea otro mensaje. Estados adicionales: `CADUCADA`, `NO_CORRELACIONADA`, `INVALIDA`, `DESCONOCIDA`. Todos quedan para atención humana, sin generar una segunda asignación ni cambiar la persona asignada.

Al reintentar un rechazo confirmado, el wamid anterior se conserva dentro del sobre privado y se libera el campo de correlación para el nuevo intento, atómicamente con la reclamación. Un status tardío del intento anterior no puede resolver el nuevo INCIERTO. El nuevo status se reconcilia mediante el `biz_opaque_callback_data` existente.

## 2. Migración y desarrollo

Migración: `prisma/migrations/20261004232556_interacciones_meta/migration.sql`.

Una tabla `InteraccionMensaje`, relación 1:1 con `Mensaje` y borrado en cascada; no cambia enums, filas históricas ni el índice de idempotencia. Contiene sobre cifrado, proyección segura, estado, consumo y fechas de caducidad/retención. La FK es TEXT porque ese es el tipo físico del ID existente. La primera prueba detectó la incompatibilidad UUID/TEXT y se corrigió **en la instancia descartable** antes de validar de nuevo.

Se creó una instancia PostgreSQL 16 propia en `/tmp/crm-meta-phase2-pg`, exclusivamente loopback:5433, base `crm_test`. Prisma CLI se ejecutó con `DOTENV_CONFIG_PATH=/dev/null` y URL local explícita. Se aplicó el historial de migraciones y después la nueva. No se utilizó la URL de la aplicación ni se accedió a producción.

### Privacidad y retención propuestas, implementadas solo localmente

- AES-256-GCM con IV aleatorio y AAD ligado al ID del mensaje entrante / `clientMessageId` saliente. Clave independiente de 32 bytes en `WHATSAPP_INTERACCIONES_KEY` mediante gestión de secretos; no hay clave de producción en el repositorio.
- Original íntegro dentro del límite HTTP; el parser puede marcarlo desconocido/inválido sin destruirlo. No se guarda el webhook completo, contactos ajenos ni estados externos en ese sobre.
- Original/snapshot privado: siete días. Proyección estructurada: treinta días. Las ofertas dejan después una lápida mínima para impedir su degradación accidental a texto durante un reintento. El texto seguro del mensaje sigue la política del historial existente.
- Limpieza en el barrido existente, sin otro cron. Antes de activar, configurar también `WHATSAPP_INTERACCIONES_RETENCION=on`; mantenerlo al apagar la función para que la limpieza continúe. Un proceso detenido no puede purgar hasta volver a ejecutarse.
- La purga de tablas no elimina copias de seguridad ya tomadas; la política de backups y la gestión/rotación de claves requieren revisión antes de producción. Perder la clave impide descifrar/reintentar y no habilita ningún fallback inseguro.

## 3. Evidencia local end-to-end

`src/modules/conversaciones/interacciones.integracion.spec.ts` levanta Nest HTTP con firma Meta, ValidationPipe, JWT/sesiones reales, guards de roles, servicios reales, PostgreSQL real y gateway Socket.IO real. Solo las salidas externas se sustituyen. Usuarios, teléfonos, secretos y payloads son sintéticos.

Cubre botones/listas/quick replies/Flows, firma inválida, rollback, deduplicación, selecciones simultáneas, versiones/tokens incorrectos, caducidad, cruce de paciente/línea/contexto/opción, payload inválido/desconocido, clientMessageId concurrente y cambio de intención, reintento sin cambio de estructura, resultados inciertos, historial/paginación, recepción compartida, línea comercial asignada, control humano, conversación cerrada, ventana cerrada, límites Meta, apagado, retención, estados de entrega y fallos parciales.

`scripts/test-interacciones-reinicio.cjs` arranca **otro proceso Node** contra la misma base: se termina durante el envío simulado; el nuevo proceso encuentra INCIERTO y no reenvía. Un rechazo conocido sí permite reconstruir la oferta. La fixture tiene la URL loopback fija y bloquea `fetch`.

Comandos reproducibles, únicamente con `crm_test` descartable preparada:

```bash
npm run build
npm run check:tests
npm run test:integracion -- --runTestsByPath src/modules/conversaciones/interacciones.integracion.spec.ts
npm test -- --runInBand --testPathPattern='(conversaciones|lineas-whatsapp|common/whatsapp)'
npm run test:flows
npm run test:build
```

En Angular: `npm run check:tests`, `npm run build`, `npm test -- --watch=false --include='src/app/features/conversaciones/**/*.spec.ts'`. Se usa DOM de prueba, sin navegador conforme a las instrucciones de los repositorios. No se afirma una prueba contra WhatsApp real.

### Resultados finales

| Control | Resultado |
|---|---|
| Integración nueva, Nest HTTP + PostgreSQL + Socket.IO + proceso reiniciado | **29/29** |
| Regresión PostgreSQL existente: conversaciones, reintentos, aislamiento/idempotencia, índice clientMessageId y líneas | **163/163**, cinco suites |
| Unitarias backend de mensajería/líneas/WhatsApp | **223/223**, 17 suites |
| Angular conversaciones, incluido historial seguro | **146/146**, 18 archivos |
| Validación/pruebas de borradores Flow | Dos JSON válidos localmente; **5/5** pruebas |
| Verificación de artefactos de build | **9/9** pruebas |
| Builds backend y Angular | Correctos |
| `check:tests` backend y Angular | Correctos |
| `git diff --check`, ambos repositorios | Correcto |

Se corrigieron dos problemas de las fixtures: nombre del modelo de membresías y
timeout de cinco segundos insuficiente al competir tres procesos Node con los
builds. La prueba de reinicio tiene ahora límite explícito por subproceso y por
caso. Las validaciones finales anteriores corresponden al código corregido.
Logs locales sin datos reales: `/tmp/meta-phase2-integracion.log`,
`/tmp/meta-phase2-regresion-db.log`, `/tmp/meta-phase2-regresion-unit.log`,
`/tmp/meta-phase2-front-tests.log` y `/tmp/meta-phase2-build-*.log`. El log combinado
de regresión conserva el fallo inicial de fixture, corregido y validado en la
ejecución final de las 29 pruebas nuevas; sus cinco suites existentes pasaron.

## 4. MCP oficial

Se registró `whatsapp_business_tools` con `https://mcp.facebook.com/whatsapp_business_tools` mediante `codex mcp add`. El cliente detectó OAuth e inició autorización oficial de Meta. Se detuvo la espera al requerir consentimiento del propietario; **no hay conexión autenticada ni inventario nuevo consultado en esta fase**. El MCP `meta_developer_tools` previamente disponible es otro servidor y no sustituye este consentimiento.

El propietario puede continuar con `codex mcp login whatsapp_business_tools --no-browser`, revisar empresas/WABAs y conceder solo los activos previstos. El flujo oficial solicitó `business_management`, `whatsapp_business_management`, `whatsapp_business_messaging`; disponer de esos permisos no autoriza a esta tarea a realizar escrituras. Tras autenticar debe recargarse el cliente para descubrir sus herramientas. No se copiaron contraseñas ni tokens a prompts/configuraciones del CRM.

## 5. Preparado pero desactivado

- `WHATSAPP_INTERACCIONES` ausente equivale a apagado. No se modificó ningún `.env` para activarlo.
- API manual de botones/listas y despacho de Flow desde snapshot, ingesta estructurada y proyección al historial.
- Catálogo de Flows publicados deliberadamente vacío (`catalogoFlows()`): el HTTP rechaza IDs arbitrarios, drafts e intercambio dinámico. El soporte se verifica con snapshots sintéticos, sin fingir IDs reales.
- Borradores locales con versión fija; falta enlazar activos remotos revisados y su contrato de respuestas al catálogo del servidor.
- No hay botones nuevos de automatización, asistente, menú automático, motor de asignación ni Flow Builder.

Al apagar, el barrido excluye interacciones pendientes: no las convierte en texto. Con el flag apagado, la entrada y visualización siguen la conducta legacy. La migración debe aplicarse antes de desplegar el código, incluso si la función queda desactivada.

## 6. Autorizaciones previas a producción

1. Propietario: consentimiento OAuth y selección de activos MCP; después, solo lecturas.
2. Aprobación específica de la migración en producción y del despliegue de backend/frontend, con respaldo y validación operativa.
3. Política clínica de retención/backups y gestión de la clave independiente; configurar limpieza incluso durante una desactivación funcional.
4. Revisión de Flows reales/versiones/contratos y asociación explícita en el catálogo. Crear/publicar activos o efectuar pruebas con números reales necesita otra autorización; esta fase no las concede.
5. Activación explícita del flag, por separado del despliegue. Una activación permitiría envíos manuales reales a través del POST existente.

## 7. Riesgos y límites pendientes

- No se validó un activo Flow publicado ni una entrega real de Meta. Falta OAuth del propietario y el catálogo autorizado. No hay endpoint de intercambio dinámico ni cifrado de ese protocolo; el cifrado de esta fase es **almacenamiento interno**, no el protocolo de data exchange.
- Respuestas a mensajes legacy sin oferta durable se muestran como no correlacionadas. Nunca se autorizan por título. Al activar, las respuestas estructuradas quedan para el personal: no disparan acuses/pedido de datos ni baja por texto de botón; el webhook oficial de preferencias sigue intacto. Revisar con operación antes de activar.
- Mensajes sin ID/remitente no pueden asociarse con seguridad; se conserva el rechazo/omisión existente. Payloads rechazados por el perímetro HTTP no se persisten.
- Un estado INCIERTO sin confirmación posterior de Meta requiere revisión humana. Se prefiere una duda visible a duplicar un mensaje.
- Las plantillas conservan su política previa: sin reintento automático. Las campañas existentes no se convierten en automatizaciones interactivas en esta fase.
- Correlacionar un Flow no registra ni confirma citas, no demuestra identidad clínica y no da acceso a documentos o datos sensibles.

No se activó IA, no se conectó ScriptCase/MySQL/FileMaker, no se publicaron Flows/plantillas, no se enviaron mensajes, no se cambiaron líneas/webhooks remotos y no se hizo push ni deploy.
