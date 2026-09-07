# F03 — Consistencia del periodo de comisiones

Diagnóstico e implementación local del 7 de septiembre de 2026. Alcance exclusivo:
estado financiero, concurrencia entre comandos y vigencia de resultados.
F01/F02 son el baseline; no se despliega ni se consulta producción.

## Máquina de estados anterior

Reconstruida de `planilla-comisiones.service.ts`, `calculo-comisiones.service.ts`,
`configuracion-comisiones.service.ts` y `estados-periodo.ts`, sobre el árbol que
ya contenía F02. No hay comando de cierre independiente: completa el cierre la
última aprobación necesaria.

| Estado A → comando → estado B | Precondiciones y efectos anteriores |
| --- | --- |
| AUSENTE → importar → BORRADOR | Archivo validado y parseado; periodo explícito o deducido. F02 publica metadatos, maestros y lotes bajo lock mensual y una transacción. |
| BORRADOR / CALCULADO → reimportar → BORRADOR | Solo editable. Conserva ajustes por clave, sustituye ventas, elimina resultados y limpia calculadoEn. Dejaba foto de configuración y posibles firmas antiguas. Auditoría posterior best-effort. |
| BORRADOR / CALCULADO → ajustar venta → mismo estado | Venta existente, periodo editable, vendedora destino existente. Excluir exige motivo; incluir lo limpia. Permite cambiar clasificación, canal, nivel, vendedora y selección de planes. Marca ajustadaManual y retira requiereRevision. No elimina resultados ni firmas ni foto. |
| BORRADOR / CALCULADO → reclasificar pendientes → mismo estado | Solo filas requiereRevision que coinciden con la regla. Selecciona meses editables y actualiza ventas posteriormente, una a una, sin proteger el estado en esas escrituras ni invalidar resultados. |
| BORRADOR / CALCULADO → calcular o recalcular → CALCULADO | Comprueba estado una vez. Lee configuración, ventas, vendedoras y meses del trimestre fuera de la transacción final. Esta reemplaza resultados y foto, escribe calculadoEn y CALCULADO. No coordina las lecturas con los comandos de estado. |
| CALCULADO → enviar a revisión → EN_REVISION | Exige resultados, ninguna fila sin clasificar o sin vendedora, ninguna vendedora pendiente de configurar. Lee estado y alertas antes de un UPDATE por id; guarda fecha y remitente. |
| EN_REVISION → aprobar, faltan firmas → EN_REVISION | Upsert único por periodo/usuario. Consulta SUPER_ADMIN activos actuales y firmas. Cada llamada escribe auditoría, incluso repitiendo la misma firma. |
| EN_REVISION → aprobar, conjunto completo → CERRADO | Se exige al menos una firma válida y ninguna pendiente. UPDATE por id, fecha/autor de cierre y auditoría posterior. Firmas, comprobación y cierre no comparten transacción. |
| EN_REVISION → rechazar → CALCULADO | Origen específico y motivo por DTO. Valida fuera; transacción borra firmas y limpia campos de revisión. Conserva resultados y foto. Auditoría posterior. |
| CERRADO → reabrir → CALCULADO | Origen específico, SUPER_ADMIN y motivo por transporte. Valida fuera; transacción borra firmas y limpia cierre/revisión. Conserva resultados. Guarda snapshot de configuración después mediante auditoría que silencia errores. |
| CERRADO → pagar → PAGADO | Valida origen antes de UPDATE por id; guarda fecha/autor. Auditoría posterior. |
| PAGADO → ningún comando de estado → sin salida prevista | Terminal en la tabla, pero una reapertura validada previamente podía sobrescribir un pago concurrente. |
| BORRADOR / CALCULADO → eliminar → AUSENTE | Comprueba editabilidad antes del DELETE; cascada de ventas/resultados/firmas. Auditoría posterior. |
| Cualquier estado → cambiar metas propias → mismo estado | PUT/DELETE por periodo y PATCH por id solo comprobaban existencia. Sin protección de estado ni invalidación. |
| Cualquier estado → cambiar configuración global → mismo estado | Tarifas, parámetros, objetivos por defecto y condiciones de vendedoras afectan el próximo cálculo. La foto y los resultados anteriores permanecen. Diccionario/captación/IVA se aplican a entradas al importar; aplicar una regla a pendientes sí escribe ventas existentes. El TC del cálculo es el ya guardado en el periodo. |

### Documentación y tests frente al código

`estados-periodo.ts` y el schema afirman que PAGADO es terminal, EN_REVISION
congela las cifras y una firma corresponde a lo revisado. La tabla expresa las
transiciones deseadas, pero no protege el intervalo SELECT → UPDATE.
`cierre-periodo.spec.ts` probaba reglas con dobles, incluso precargando firmas;
el caso «aprobar dos veces» ejecutaba una única llamada. Se conserva su cobertura
de reglas y se corrige ese caso para hacer las dos llamadas.

`foto-configuracion.integracion.spec.ts` exige deliberadamente conservar una
foto aunque cambien parámetros globales; solo recalcular adopta lo nuevo.
Esa regla se mantiene. No se interpreta «configuración vigente» como «último
valor global»: la configuración contractual es la fotografiada por el cálculo.

## Defectos reproducidos antes del cambio de implementación

PostgreSQL 17.10 local descartable, base `crm_test`, datos ficticios. Las barreras
pausan llamadas que consultan PostgreSQL real; no emulan commits ni aislamiento.

| Caso | Secuencia observada sobre F02 | Expectativa que falló |
| --- | --- | --- |
| A | Reabrir lee CERRADO y se pausa. Pagar lee CERRADO y confirma PAGADO. Reabrir continúa y confirma CALCULADO, conservando pagadoEn. | Solo uno de los comandos incompatibles debe confirmar. |
| B | Calcular crea ResultadoComision. Excluir una venta con motivo conserva CALCULADO y esos resultados. Enviar a revisión confirma EN_REVISION. | Edición debe invalidar e impedir revisar/aprobar el cálculo anterior. |
| C | Recalcular lee estado/configuración y se pausa. Enviar a revisión confirma. Recalcular publica CALCULADO, dejando incluso metadatos de revisión. | El cálculo no puede sobrescribir la revisión. |
| D, repetición | Dos llamadas iguales de aprobación generan dos hechos APROBAR. Una repetición después del cierre falla. | Repetición idéntica no debe duplicar firma ni auditoría/cierre. |
| D, concurrencia | Ambos upserts se confirman; se demoran las lecturas del primer aprobador hasta que el segundo cierra. Ambos observan el conjunto completo y registran CERRAR. | Un cierre y una única evidencia de cierre. |
| Auditoría | Un trigger PostgreSQL rechaza AuditLog.REABRIR. La reapertura ya se había confirmado y AuditService silencia el fallo. | Estado, firmas y evidencia deben confirmar o revertir juntos. |

La primera ejecución de A/B/C/repetición/auditoría produjo cinco fallos; la
barrera inicial de doble cierre no forzaba que ambos leyesen todas las firmas.
Se corrigió esa barrera antes de implementar y se reprodujeron dos CERRAR.

## Estrategia elegida

Una sola frontera, en `transaccion-periodo.ts`, reutilizada por los comandos:

1. `pg_try_advisory_xact_lock(202602, anio * 12 + mes)`: misma clave que F02.
   Excluye escritores del mismo mes y también protege la primera importación,
   cuando todavía no hay fila. No espera: devuelve 409 si está ocupado.
2. Transacción `REPEATABLE READ`, timeout 30 segundos: ventas, configuración,
   vendedoras, metas y bases de bonos se leen desde una instantánea coherente.
   No se abre una segunda transacción para cargar configuración.
3. Tras adquirir el advisory lock, `UPDATE PeriodoComision SET estado = estado`
   sobre la clave mensual. No cambia estado, timestamps ni valores de negocio.
   Deja una versión MVCC y toma el lock de fila. Es necesaria porque el snapshot
   de REPEATABLE READ podría haberse tomado justo antes del commit del dueño
   anterior del advisory lock. PostgreSQL rechaza entonces el snapshot antiguo,
   también si el comando anterior solo agregó una firma y conservó EN_REVISION.
   Hay una prueba real de esta frontera.
4. Estado y relaciones se releen y validan dentro. Error de validación o
   persistencia revierte ventas, resultados, firmas, metadatos y auditoría.

La consulta previa por id solo obtiene la clave mensual inmutable. No autoriza
la operación ni decide el estado. Si desaparece el id antes de tomar el lock,
se informa conflicto. La escritura de control tampoco sobrevive a un fallo.

### Exclusión y concurrencia permitida

Comparten lock: importar/reimportar, editar/incluir/excluir/seleccionar planes,
reclasificar pendientes, calcular/recalcular, enviar, aprobar/cerrar, rechazar,
reabrir, pagar, borrar periodo y editar/eliminar sus metas propias por cualquiera
de sus endpoints.

Una aplicación de regla a varios meses toma sus locks ordenados por año/mes;
si encuentra un conflicto, revierte toda esa aplicación. La creación de la regla
global sigue siendo el comando anterior del controller: no se convierte aquí
en una nueva arquitectura ni se resuelve su atomicidad independiente.

Meses distintos y lecturas pueden avanzar concurrentemente. Las modificaciones
globales de tarifas, parámetros y vendedoras también pueden avanzar: el cálculo
en curso utiliza su snapshot, y el siguiente cálculo adopta los valores nuevos.
Igualmente, los promedios trimestrales quedan fotografiados como entradas del
cálculo actual; editar otro mes no reescribe resultados ya liquidados.

### Por qué no otras alternativas

- UPDATE condicionado solo por estado no detecta dos versiones distintas de
  CALCULADO ni protege las ventas/resultados/firmas que se escriben antes.
- Versionar tablas exigiría migración y propagar la versión por cada comando y
  relación. La invalidación transaccional y la exclusión mensual resuelven las
  invariantes solicitadas sin ese contrato nuevo.
- Solo un lock de fila no cubre la primera importación de F02. Solo el advisory
  lock no garantiza una lectura consistente de varios catálogos globales.
- No se bloquea toda la configuración ni todos los meses: la fotografía es
  deliberadamente histórica, y MVCC ofrece una lectura coherente.

## Vigencia y máquina nueva

```
AUSENTE → importar → BORRADOR
BORRADOR / CALCULADO → reimportar → BORRADOR
BORRADOR / CALCULADO → ajustar/incluir/excluir/seleccionar planes → BORRADOR
BORRADOR / CALCULADO → reclasificar pendientes afectadas → BORRADOR
BORRADOR / CALCULADO → modificar/eliminar metas propias → BORRADOR
BORRADOR / CALCULADO → calcular/recalcular → CALCULADO
CALCULADO → enviar a revisión sin bloqueos → EN_REVISION
EN_REVISION → aprobar, faltan firmas → EN_REVISION
EN_REVISION → aprobar, se completan firmas → CERRADO
EN_REVISION → rechazar → CALCULADO
CERRADO → reabrir → CALCULADO
CERRADO → pagar → PAGADO
PAGADO → sin salida
BORRADOR / CALCULADO → eliminar → AUSENTE
```

Cambiar entradas borra resultados y firmas, limpia `calculadoEn`,
`configuracionUsada` y marcas de revisión/cierre/pago. Se vuelve a BORRADOR en
la misma transacción que la edición. Incluso repetir un ajuste explícito
invalida conservadoramente; no se intenta demostrar equivalencia del DTO.
BORRADOR no puede enviarse ni aprobarse hasta calcular de nuevo.

Rechazo y reapertura retiran firmas, pero conservan el cálculo porque por sí
mismos no editan sus entradas. La siguiente edición lo invalida. Recalcular
retira firmas y metadatos previos al publicar la nueva foto y resultados.

Repetir aprobación idéntica (mismo usuario y comentario normalizado) es
idempotente en EN_REVISION y CERRADO: no agrega firma ni auditoría. En revisión
se sigue evaluando el conjunto actual de aprobadores como antes. Una firma
distinta en CERRADO o cualquier aprobación en PAGADO recibe 409. Pagar,
reabrir, rechazar y enviar no adquieren idempotencia nueva: exigen su origen.

## Transacciones y auditoría

Fuera de publicación de importación: recepción, Excel, normalización,
clasificación, preparación de lotes y resolución del tipo de cambio. F02 sigue
siendo todo-o-nada; ahora comparte exclusión con los demás comandos.

Dentro del cálculo: lectura consistente de base/configuración, cálculo local,
retirada de resultados anteriores, nuevos resultados/foto/estado y auditoría.
No hay Excel ni HTTP externo dentro. Se mantiene el motor y sus fórmulas.

Dentro de los comandos de estado: validación, agregados de revisión, firmas,
transición y auditoría. Dentro de ediciones: validación, escritura, invalidación
y auditoría. Las invalidaciones de caché existentes se ejecutan tras el commit.

La auditoría financiera no usa el catch best-effort. `registrarFinanciero`
recibe el mismo cliente transaccional; cualquier rechazo SQL aborta el comando.
Al retirar una liquidación se conserva la foto anterior con resultados y firmas;
reabrir/rechazar guardan la evidencia antes de borrar aprobaciones. Enviar,
cerrar y pagar conservan snapshots de la liquidación correspondiente.

`configuracionUsada` agrega campos JSON para tarifas RA, condiciones económicas
de vendedoras y promedios trimestrales utilizados. No cambia tablas ni números.
La auditoría/telemetría de los demás dominios y de maestros globales mantiene
su contrato existente. No se convierte todo el logging del CRM en transaccional.

## Conflictos HTTP

Lock ocupado, estado incompatible o snapshot obsoleto producen ConflictException
(409). Se traducen P2034 y SQLSTATE 40001/40P01 de P2010; se comprobó la forma
real de `driverAdapterError.cause.originalCode` con Prisma 7/adapter-pg.
Otros fallos de persistencia siguen fallando y revirtiendo; no se disfrazan de
conflictos. No hay reintentos financieros automáticos.

El frontend actual captura el error de estos comandos y usa `mensajeDeError`
para mostrar `error.message` mediante toast. Ya admite 409; no se modifica
Angular ni se cambia el cuerpo de éxito de los endpoints.

## Límites, despliegue y rollback

- Sin migración, dependencias nuevas, módulos nuevos ni cambios de fórmulas.
  Los campos JSON adicionales son compatibles con los lectores existentes.
- Los locks son cooperativos: SQL directo, scripts externos o una versión vieja
  de la aplicación pueden eludirlos. Al desplegar, no deben convivir escritores
  antiguos y nuevos; no se ha desplegado esta fase.
- F03 no certifica retrospectivamente periodos ya desactualizados por fallos
  anteriores. No se han leído ni corregido datos de producción. Los periodos
  sospechosos necesitan revisión operativa y, si corresponde, recálculo antes
  de continuar. Los estados existentes no se migran automáticamente.
- La pertenencia de usuarios al conjunto SUPER_ADMIN sigue siendo dinámica.
  Su gestión y revocación no se rediseñan en F03; el cierre fotografía el conjunto
  visto por su transacción.
- No hay token de versión de pantalla: la protección cubre los comandos de
  backend y la revisión congelada. Tras un 409 el cliente debe actualizar datos.
- El cálculo mantiene conexión/snapshot durante el trabajo local y la auditoría
  agrega lecturas/escrituras. Hay timeout y rollback; no se midió carga en el VPS.
  Las cachés de informes conservan sus TTL y límites existentes.
- No se cambia la visibilidad global de vendedoras ni la semántica de informes.

Rollback de aplicación: revertir solo la entrega F03 y reconstruir/verificar
el artefacto, manteniendo F01/F02. No restaurar ventas ni auditorías con SQL.
Los BORRADOR invalidados siguen requiriendo recálculo; no cambiar su estado a
mano ni resucitar resultados retirados. El rollback reabre los defectos F03,
por lo que hay que detener los comandos financieros mientras se evalúa.

## Verificación

La suite `consistencia-periodo.integracion.spec.ts` usa únicamente `crm_test`
en loopback, barreras controladas y triggers de error de auditoría. Compara
estado, ventas, resultados, aprobaciones, objetivos y AuditLog, incluyendo
rollback, doble llamada real, ambos ganadores posibles de pagar/reabrir,
configuración concurrente y snapshot anterior al lock.

Resultados del árbol final:

| Verificación | Resultado |
| --- | --- |
| Nueva suite PostgreSQL F03 | 22 pruebas pasan |
| Todas las integraciones financieras | 7 suites, 97 pruebas pasan, incluidas las 10 de F02 y los fixtures mensuales |
| Backend unitario completo | 29 suites, 465 pruebas pasan |
| Typecheck de producción | Pasa, sin emitir ni alterar la caché incremental |
| Typecheck adicional de los tres archivos de tests nuevos/modificados | Pasa; evita confiar solo en la transpilación aislada de Jest |
| npm run build | Pasa; check:skills y dist/main.js con contenido verificados |
| npm run test:build | 9 pruebas pasan, incluidos build limpio, consecutivo y compilador sin emisión |
| npm run check:skills | Pasa |
| git diff --check | Pasa |

Se aplicaron las 41 migraciones existentes en la base local descartable antes
de las pruebas. El schema no cambió; no se introduce ni requiere una migración.
No se corrieron las integraciones de otros dominios ni se usó producción.

Comandos reproducibles desde el backend, con PostgreSQL local de tests disponible:

```sh
npm run test:integracion -- --runTestsByPath src/modules/planilla-comisiones/*.integracion.spec.ts
npm test -- --runInBand
node node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --incremental false
npm run build
npm run test:build
npm run check:skills
git diff --check
```

El typecheck de tests usó una configuración temporal que extiende
`tsconfig.build.json`, incluye `consistencia-periodo.integracion.spec.ts`,
`cierre-periodo.spec.ts` y `ajustar-venta.spec.ts`, agrega tipos node/jest y desactiva
emisión/incremental. No modifica la configuración de build cerrada en F01.

## Archivos de esta entrega

- `src/common/audit/audit.service.ts`: vía de auditoría financiera sin catch.
- `src/modules/planilla-comisiones/transaccion-periodo.ts`: frontera, locks e invalidación.
- `src/modules/planilla-comisiones/planilla-comisiones.service.ts`: comandos e importación coordinados.
- `src/modules/planilla-comisiones/calculo-comisiones.service.ts`: instantánea y publicación única.
- `src/modules/planilla-comisiones/configuracion-comisiones.service.ts`: lecturas con tx y metas propias protegidas.
- `src/modules/planilla-comisiones/planilla-comisiones.controller.ts`: transmite usuario a la auditoría de metas/reglas.
- `src/modules/planilla-comisiones/estados-periodo.ts`: comentario de la invalidación real.
- `src/modules/planilla-comisiones/consistencia-periodo.integracion.spec.ts`: 22 pruebas reales.
- `src/modules/planilla-comisiones/cierre-periodo.spec.ts`: doubles transaccionales y repetición real.
- `src/modules/planilla-comisiones/ajustar-venta.spec.ts`: double adaptado sin cambiar las reglas comprobadas.
- `docs/auditoria-f03.md`: diagnóstico, decisiones y verificación.

Los cambios locales de F01 en CLAUDE/build tests y los archivos de F02 ya
existían. Esta entrega los conserva; el diff global de Git todavía los incluye.
