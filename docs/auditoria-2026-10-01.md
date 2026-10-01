# Revisión del CRM — 1 de octubre de 2026

Entrega local sobre `main`: backend `cd5208e28ffb041f450fbeb49c8f98f4bc095adf`
y frontend `12ba1535e4062e80577ac941aa66ec0f9ccd6f22`. Se ejecutó `git fetch origin` en ambos repositorios:
los HEAD locales coincidían con `origin/main` antes de editar. Los últimos
cambios incorporan categoría por valor, audiencias, campañas, cierre de chats
y filtro Gold. No se publicó ni desplegó esta entrega.

## Documentación y criterio de revisión

Se inventariaron los Markdown propios de los dos repositorios y del directorio
padre. Se contrastaron las auditorías F02–F09, F06-R1/R2, el informe
arquitectónico, los cierres de septiembre, R3 y CAMP-0/CAMP-1 con el panorama
vigente y el código reciente. Las referencias generales de Angular no son
auditorías del CRM. El historial de ESTADO_ACTUAL conserva decisiones antiguas:
una sección fechada no describe necesariamente el estado actual.

Las auditorías F01–F10 cerradas no se vuelven a declarar abiertas: esta revisión
añade regresiones de las funcionalidades recientes y corrige deuda concreta
del inbox. Se conservan el monolito modular, PrismaService, contratos actuales,
permisos por línea/rol, signals, componentes compartidos y fórmulas financieras.

## Errores corregidos

| Área | Antes | Ahora y evidencia |
| --- | --- | --- |
| Campañas: reserva interrumpida | `ENVIANDO` solo se recuperaba al arrancar; un fallo transitorio podía dejarla atascada hasta reiniciar | Cada vuelta considera reservas pendientes de conciliar; prueba con PostgreSQL real, sin reinicio |
| Campañas: fallo después de Meta | Fallar al guardar el vínculo convertía el destinatario en `FALLIDO`, aunque el WhatsApp ya hubiera salido | La reserva durable sobrevive al rollback y se enlaza con `Mensaje.clientMessageId`; trigger PostgreSQL fuerza el fallo después del despacho y confirma que no hay un segundo WhatsApp |
| Campañas: error individual | Un fallo al consultar otra campaña cortaba el lote | Se captura por destinatario, conserva su reserva y permite continuar; siguiente vuelta recupera el caso transitorio |
| Campañas: elegibilidad y recuperación | Una baja posterior podía ocultar un mensaje ya enviado y excluirlo de las métricas | Se busca primero el mensaje existente; se conserva su fecha real y se concilia incluso fuera del horario de nuevos envíos |
| Campañas: concurrencia | Resetear reservas al iniciar otro proceso podía interferir con envíos en vuelo | Bloqueo transaccional PostgreSQL por paciente, también entre campañas; dos workers durante una respuesta retenida de Meta no duplican el envío |
| Campañas: cancelación | Cancelar durante una validación fallida podía devolver una destinataria a pendiente en una campaña cancelada | Confirmación coordinada con la fila de campaña; permanece CANCELADA y la destinataria queda OMITIDA |
| Campañas: trabajo por vuelta | El cupo solo contaba mensajes enviados; podía recorrer miles de omisiones en un barrido | Máximo 20 destinatarias procesadas por vuelta, incluidas omisiones y errores; prueba con 21 bajas |
| DTO de creación | Filtro ausente o `[]` podía atravesar validación; espacios pasaban longitudes mínimas | `IsDefined` + `IsObject` + validación anidada; textos recortados antes de validar; pruebas con ValidationPipe |
| Inbox: último mensaje | Prisma podía traer todo el historial de los chats de la página para elegir uno en memoria | Consulta parametrizada `LATERAL … LIMIT 1` para IDs previamente autorizados; mismo desempate `createdAt DESC, id DESC` que el detalle |
| Formulario de campaña | Derivados leían `.value()` en error y podían romper el render | Guardas `hasValue()`, errores visibles y reintento sin cerrar el formulario; pruebas HTTP con 502/503 |
| Programación | `datetime-local` se convertía usando la zona del dispositivo | Se interpreta en America/La_Paz, se etiqueta esa zona y se muestran fechas de la ficha en Bolivia; rechaza fechas inexistentes, pasadas y más allá de 30 días |
| Validaciones UI | Tarifa vacía se convertía en cero; se ofrecían valores que el backend rechazaba | Tarifa explícita de 0 a 1, hasta cuatro decimales; límite de 2.000 destinatarias y longitudes de nombre/variables |
| Métricas de campaña | El polling terminaba al acabar el lote, aunque después llegaran entregas y lecturas | Ficha abierta se refresca cada 60 s; se detiene al cerrar/destruir y omite peticiones en pestañas ocultas; prueba con campaña TERMINADA |
| Accesibilidad | Campaña abría solo con clic en fila; campos y errores no siempre tenían asociación accesible | Botón nativo para abrir con teclado, etiquetas de variables, `aria-invalid` y `aria-describedby` en input/textarea |
| Tipos de pruebas | Jest transpila en aislamiento: aceptaba un constructor incompleto y un cuerpo Response mal tipado | Fixtures multimedia corregidas; `npm run check:tests` comprueba ambos repositorios con TypeScript |

## Medición del inbox

PostgreSQL local, cinco lecturas calientes tras calentamiento, **50 chats con
500 mensajes cada uno**, datos sintéticos y transporte loopback. Se compara
solo la lectura de mensajes, no la latencia HTTP ni la experiencia de producción.
El SQL anterior reproduce el documentado en R3 (IN sobre IDs, sin límite).

| Medida | SQL anterior | SQL nuevo |
| --- | ---: | ---: |
| Filas devueltas por PostgreSQL | 25.000 | 50 |
| Bytes al serializar esas filas como JSON | 7.419.501 | 14.851 |
| Mediana de consulta + materialización local | 38,04 ms | 0,51 ms |
| Ejecución PostgreSQL en EXPLAIN ANALYZE | 12,071 ms | 0,148 ms |

El plan nuevo usa `Conversacion_pkey`, un `Limit` por chat y el índice existente
`Mensaje_conversacionId_createdAt_idx`. No se añade índice ni migración.
Los bytes medidos pertenecen a las filas SQL: **la API anterior ya devolvía un
mensaje por chat**, así que esto no representa una reducción de 500 veces del
payload HTTP. Se reduce el trabajo y la materialización previos.

Reproducción, sin ejecutar a la vez otras suites sobre crm_test:

```sh
npm run build
CRM_TEST_DATABASE_URL='postgresql://crm_app:crm_dev_local@127.0.0.1:5433/crm_test' \
  node scripts/medir-inbox-local.mjs
```

El script exige loopback y la base `crm_test`, no lee `.env`, y elimina solo
sus fixtures. No copia pacientes reales ni trunca tablas.

## Verificación

| Comprobación | Resultado local |
| --- | --- |
| Backend unitarias | 56 suites / 667 casos, sin fallos |
| Backend integración PostgreSQL | 36 suites / 687 casos, sin fallos |
| Frontend completo | 62 archivos / 525 casos, sin fallos |
| Build backend y frontend | Correctos, con check:skills y check:tipos aplicables |
| Entry point backend, test:build | 9/9 |
| Typecheck incluyendo tests | Correcto en ambos repositorios |
| Arranque del módulo backend compilado, con configuración ficticia | health 200, login vacío 400, inbox/campañas/finanzas sin sesión 401 |
| YAML de workflows | Parseo y estructura básicos correctos; ejecución GitHub pendiente |

El bundle inicial final del frontend es **408,36 kB bruto / 108,13 kB
transferido**, dentro de los presupuestos de producción. No se atribuye a esta
entrega una mejora de tiempos de pintado sin medición de navegador.

Las suites financieras reportan casos aprobados que **no ejecutan aserciones
con Excel reales** si faltan CRM_EXCELS_2025_DIR/CRM_EXCELS_2026_DIR. Los conteos
anteriores no prueban conciliación contra esos archivos privados. No se
modificaron fórmulas ni clasificaciones.

Las tres migraciones ya versionadas de categoría manual, categoría de plantilla
y campañas se aplicaron exclusivamente a `crm_test`. Esta entrega no introduce
migraciones nuevas. Meta y R2 están simulados en sus fronteras de integración.

## Calidad en GitHub

Ambos repositorios incorporan `.github/workflows/calidad.yml`: builds, validación
de tipos de tests y suites; backend usa un PostgreSQL descartable y valida el
entry point. Permisos `contents: read`, sin credenciales productivas, con límite
de tiempo y cancelación de ejecuciones obsoletas. El frontend verifica enums
contra un SHA explícito del backend; actualizar ese SHA cuando cambie el schema.

Los comandos se comprobaron localmente. **El workflow aún no se ha ejecutado en
GitHub**: requiere publicar los archivos. No se cambiaron protección de ramas,
configuración de Vercel ni recetas de despliegue. Añadir un workflow no bloquea
por sí solo una publicación automática: la protección correspondiente se
configura en GitHub/Vercel por separado.

## Investigación de bandejas y Meta

- [Intercom Inbox](https://www.intercom.com/help/en/articles/6274899-get-started-with-intercom-inbox)
  documenta bandejas de equipo, asignación al responder, macros, teclado y
  operaciones en segundo plano. La conclusión para este CRM es mantener clara
  la persona que atiende el chat y separar campañas del trabajo de respuesta;
  evitar añadir un segundo sistema de propiedad comercial. El código reciente
  ya hace esa separación y las pruebas de campaña la conservan.
- [HubSpot coexistence](https://knowledge.hubspot.com/inbox/connect-a-whatsapp-number-to-hubspot-using-coexistence)
  demuestra que existen altas con Business App y API coexistentes. Por eso se
  retiró de las guías la orden genérica de eliminar una cuenta existente.
  No se afirma que este CRM soporte ese flujo: habría que integrar y verificar
  los eventos específicos antes de ofrecerlo.
- [Precios oficiales de WhatsApp](https://business.whatsapp.com/products/platform-pricing)
  describen cobro por mensajes entregados según mercado/categoría. Las guías
  antiguas aún mencionaban 1.000 conversaciones gratuitas: corregido.
  La tarifa editable del CRM continúa siendo una estimación, no una factura.
- [Angular httpResource](https://angular.dev/guide/http/http-resource)
  documenta que leer value en error lanza y recomienda hasValue; corregida
  también la explicación incorrecta del skill crm-feature-page.

Se corrigió además la afirmación de streaming en crm-backend-arquitectura:
leer detalle por lotes no impide que `new Workbook()` materialice todo el Excel.
No se reescribió la exportación financiera sin una necesidad medida.

## Límites y prioridades que siguen vigentes

1. No hay garantía de entrega exactamente una vez por una API externa. Un
   mensaje persistido o INCIERTO se reutiliza, nunca se reenvía por suposición;
   estados de entrega dependen del webhook. La ventana entre persistir un
   mensaje y despacharlo sigue perteneciendo al mecanismo saliente existente.
2. Crear una campaña todavía no lleva clave idempotente HTTP. El botón bloquea
   clics simultáneos, pero tras perder una respuesta debe comprobarse el listado
   antes de volver a crearla. Una clave por intención sería el siguiente cambio
   de contrato, con pruebas de desconexión/reintento y persistencia.
3. La confirmación de audiencia compara su **cantidad**, no un fingerprint de
   las mismas pacientes. Congela las elegibles al crear y vuelve a comprobar bajas
   antes de enviar; no garantiza identidad exacta si cambió el conjunto con igual
   tamaño. No se debe documentar una garantía que ese contrato no ofrece.
4. Compras posteriores a un envío son atribución simple; no demuestran impacto
   incremental ni ROAS de anuncios. CAMP-0 conserva los requisitos de cobertura
   e inversión real antes de ofrecer esas métricas.
5. pg/Prisma emiten una advertencia de consultas concurrentes dentro de algunas
   transacciones existentes. No se ocultó ni se cambió el driver en esta entrega;
   requiere revisión antes de pasar a pg 9.
6. No se realizaron pruebas visuales en navegador, carga productiva, cambios
   de infraestructura ni envíos reales. La regla local del repositorio excluye
   navegador; las comprobaciones UI son de DOM/HTTP en TestBed.

Estos límites acotan la entrega: no se declara «cero deuda técnica» ni una
certificación de seguridad/UX completa de todas las líneas del sistema.

## Inventario documental

Markdown de contexto, manuales y auditorías propios (sin dependencias ni referencias genéricas de skills). Las líneas son las de la entrega revisada.

| Documento | Líneas |
| --- | ---: |
| [CONTEXTO_CONTINUACION_CHAT_2026-09-22.md](../../CONTEXTO_CONTINUACION_CHAT_2026-09-22.md) | 125 |
| [CONTEXTO_CONTINUIDAD.md](../../CONTEXTO_CONTINUIDAD.md) | 257 |
| [REQUISITOS_INTEGRACION_META.md](../../REQUISITOS_INTEGRACION_META.md) | 93 |
| [backend-crm-montalvo/CLAUDE.md](../CLAUDE.md) | 227 |
| [backend-crm-montalvo/GEMINI.md](../GEMINI.md) | 15 |
| [backend-crm-montalvo/MANUAL-COMISIONES.md](../MANUAL-COMISIONES.md) | 802 |
| [backend-crm-montalvo/docs/CAMP-0-campanas-meta-roi.md](CAMP-0-campanas-meta-roi.md) | 1407 |
| [backend-crm-montalvo/docs/CAMP-1-atribucion-venta-lead.md](CAMP-1-atribucion-venta-lead.md) | 155 |
| [backend-crm-montalvo/docs/CIERRE-TECNICO-2026-09.md](CIERRE-TECNICO-2026-09.md) | 179 |
| [backend-crm-montalvo/docs/ENTREGA_WHATSAPP_AGENDA_MODALES_2026-09-21.md](ENTREGA_WHATSAPP_AGENDA_MODALES_2026-09-21.md) | 54 |
| [backend-crm-montalvo/docs/ESTADO_ACTUAL.md](ESTADO_ACTUAL.md) | 1852 |
| [backend-crm-montalvo/docs/PANORAMA.md](PANORAMA.md) | 158 |
| [backend-crm-montalvo/docs/REVISION-FINAL-ARCHIVOS-2026-09.md](REVISION-FINAL-ARCHIVOS-2026-09.md) | 228 |
| [backend-crm-montalvo/docs/auditoria-arquitectonica-2026-09-05.md](auditoria-arquitectonica-2026-09-05.md) | 549 |
| [backend-crm-montalvo/docs/auditoria-f02.md](auditoria-f02.md) | 119 |
| [backend-crm-montalvo/docs/auditoria-f03.md](auditoria-f03.md) | 275 |
| [backend-crm-montalvo/docs/auditoria-f04.md](auditoria-f04.md) | 212 |
| [backend-crm-montalvo/docs/auditoria-f05.md](auditoria-f05.md) | 195 |
| [backend-crm-montalvo/docs/auditoria-f06-entrega2.md](auditoria-f06-entrega2.md) | 183 |
| [backend-crm-montalvo/docs/auditoria-f06-etapa2.md](auditoria-f06-etapa2.md) | 45 |
| [backend-crm-montalvo/docs/auditoria-f06-r1.md](auditoria-f06-r1.md) | 278 |
| [backend-crm-montalvo/docs/auditoria-f06-recepcion-2026-09-14.md](auditoria-f06-recepcion-2026-09-14.md) | 137 |
| [backend-crm-montalvo/docs/auditoria-f06.md](auditoria-f06.md) | 158 |
| [backend-crm-montalvo/docs/auditoria-f07.md](auditoria-f07.md) | 66 |
| [backend-crm-montalvo/docs/auditoria-f09.md](auditoria-f09.md) | 127 |
| [backend-crm-montalvo/docs/f06-r2-primer-contacto-durable.md](f06-r2-primer-contacto-durable.md) | 242 |
| [backend-crm-montalvo/docs/lineas-whatsapp.md](lineas-whatsapp.md) | 58 |
| [backend-crm-montalvo/docs/plantillas-whatsapp.md](plantillas-whatsapp.md) | 201 |
| [backend-crm-montalvo/docs/recepcion-atencion-compartida-2026-09-21.md](recepcion-atencion-compartida-2026-09-21.md) | 16 |
| [backend-crm-montalvo/docs/rendimiento-r3-2026-09.md](rendimiento-r3-2026-09.md) | 784 |
| [frontend-crm-montalvo/CLAUDE.md](../../frontend-crm-montalvo/CLAUDE.md) | 125 |
| [frontend-crm-montalvo/CRM_MANIFESTO.md](../../frontend-crm-montalvo/CRM_MANIFESTO.md) | 534 |
| [frontend-crm-montalvo/META_COSTOS.md](../../frontend-crm-montalvo/META_COSTOS.md) | 105 |
| [frontend-crm-montalvo/META_INTEGRATION_GUIDE.md](../../frontend-crm-montalvo/META_INTEGRATION_GUIDE.md) | 156 |
| [frontend-crm-montalvo/README.md](../../frontend-crm-montalvo/README.md) | 62 |
| [frontend-crm-montalvo/docs/MANUAL_USUARIO.md](../../frontend-crm-montalvo/docs/MANUAL_USUARIO.md) | 247 |
