# F02 — Publicación atómica de una planilla

Verificado el 7 de septiembre de 2026. Alcance: importación/reimportación;
sin cambios de cálculo, tarifas, clasificación, máquina de estados, rutas ni frontend.

> Informe histórico de F02. F03 amplió después la transacción a REPEATABLE READ
> y la coordinación con otros comandos; ver [auditoria-f03.md](auditoria-f03.md).

## Reproducción antes del cambio

La prueba `importacion-atomica.integracion.spec.ts` se añadió y ejecutó antes de
modificar el servicio. Usa el parser real de Excel y Prisma contra PostgreSQL
17.10 descartable, exclusivamente `crm_test` en loopback. No simula transacciones.

1. Importa dos ventas ficticias, conserva un ajuste manual y prepara un resultado
   almacenado con el periodo en CALCULADO, TC 6,97 y archivo `anterior.xlsx`.
2. Intenta sustituirlas por un Excel de 501 filas, TC 7 y archivo `nueva.xlsx`.
3. Un trigger de test falla en la fila 501. Su consulta SQL confirma que las
   primeras 500 filas ya se insertaron: `F02: fallo posterior a 500 filas`.
4. La aserción de conservación falla: quedan 500 ventas nuevas, cero resultados,
   BORRADOR, `calculadoEn = null`, TC 7, `filasTotales = 501`, `filasValidas = 2`
   y `archivoNombre = nueva.xlsx`. Las ventas anteriores ya no existen.

Las cinco suites financieras de integración existentes pasaron antes del cambio:
65 casos, incluidos los archivos de octubre, noviembre y diciembre de 2025.

## Flujo anterior completo

| Paso | Comportamiento anterior |
|---|---|
| Recepción | Guards/DTO y `FileInterceptor('archivo')`; el controller comprueba archivo, tamaño y extensión y pasa buffer, nombre, DTO y usuario al servicio. |
| Configuración | `asegurarConfiguracion` rellena valores globales ausentes. |
| Parseo | `leerExcel`: primera hoja, cabeceras obligatorias, conversión de fechas/números/texto y descarte de filas vacías. |
| Periodo/TC | `deducirPeriodo`, overrides del DTO y `resolverTipoCambio`; esta última consulta configuración local, sin solicitud externa. |
| Validación | Consulta del periodo y rechazo si no es editable. Carga de reglas, IVA y captación. |
| Ajustes | Lectura de ajustes manuales del periodo fuera de la publicación. |
| Maestros | Alta de vendedoras/médicos y actualización de nombres/configuración, confirmadas por separado. |
| Periodo | `upsert` confirmado: nombre, TC, importador, total y BORRADOR; en reimportación borra `calculadoEn`. |
| Borrados | Una transacción cubre únicamente ventas y resultados anteriores. |
| Lotes | Clasificación y mapeo intercalados con `createMany` independientes, de 500 filas. |
| Final | Actualización separada de `filasValidas`, invalidaciones de caché, auditoría y respuesta. No se calcula una nueva liquidación. |

## Diseño nuevo

**Fuera de la transacción de publicación:** recepción, validaciones de archivo y
DTO, inicialización global de configuración existente, parseo, normalización,
deducción de periodo/TC, lectura de reglas/IVA/captación, clasificación, contadores,
claves de ajustes y preparación de las filas y de los maestros detectados.
Las restricciones persistentes de PostgreSQL siguen validándose al escribir.

**Dentro de un único `$transaction`:**

1. `pg_try_advisory_xact_lock(202602, anio * 12 + mes)` reserva la publicación del
   mes, incluso cuando todavía no existe el periodo. Si está ocupado, responde
   409 sin publicar nada. No espera otra importación manteniendo la transacción.
2. Relee el periodo y comprueba `esEditable`.
3. Hace el `upsert` del periodo y lee sus ajustes usando el cliente `tx`.
4. Sincroniza vendedoras y médicos con ese mismo cliente. No hay transacciones
   anidadas ni altas/nombres nuevos que sobrevivan a un fallo de publicación.
5. Borra las ventas y resultados anteriores del periodo seleccionado.
6. Aplica los ajustes preparados a cada lote e inserta todos los lotes mediante
   `tx.ventaImportada.createMany`.
7. Actualiza `filasValidas` y confirma. Ante un error se revierte todo lo anterior.

Se usa READ COMMITTED y un límite de 30 segundos para la publicación completa.
No se parsea Excel, reclasifica ni llama a proveedores externos dentro de ella.
El límite es una protección acotada, no una medición de capacidad de producción.

**Después del commit:** invalidación del catálogo y resumen anual, auditoría
best effort existente, log y respuesta con el mismo contrato. Un rollback no
invalida cachés ni registra una importación exitosa. La siembra global de
configuración y la auditoría siguen teniendo su semántica independiente.

## Garantías y límites

- Los lectores no ven lotes parcialmente publicados. Ven la versión confirmada
  anterior hasta el commit; después, la nueva. Varias consultas separadas pueden
  atravesar el instante del commit: no se cambia el aislamiento de los lectores.
- El fallo en cualquier lote o en la actualización final conserva IDs, ventas,
  ajustes, resultados, configuración fotografiada y metadatos anteriores. Una
  primera importación fallida tampoco deja un periodo nuevo ni altas de maestros.
- El éxito conserva el ID del periodo, sustituye todas las ventas, elimina sus
  resultados previos y vuelve a BORRADOR, como antes. No recalcula ni modifica
  las reglas de clasificación o cálculo. Los demás periodos no se reemplazan.
- Se conserva la clave y precedencia actual de ajustes. Los contadores siguen
  contando el clasificador antes de aplicar ajustes. No se amplían los campos
  preservados ni se cambia el tratamiento de `configuracionUsada` o aprobaciones.
- El bloqueo solo coordina importaciones que usan este código. Cálculo, ajustes,
  revisión, pago y otras escrituras concurrentes siguen pendientes de F03.
- Meses distintos no comparten el bloqueo de importación, pero pueden competir
  por médicos/vendedoras globales. Un deadlock/timeout de PostgreSQL aborta la
  publicación completa; no se añade reintento automático.
- La preparación mantiene las filas normalizadas y sus datos de inserción en
  memoria. No se resuelve aquí el coste del parser ni se migra xlsx.

## Verificación y rollback

`npm run test:integracion -- --runTestsByPath src/modules/planilla-comisiones/*.integracion.spec.ts`
ejecuta las suites financieras, incluida la nueva. Requiere exclusivamente una
base `crm_test` descartable con las migraciones existentes; nunca usar producción.
La suite nueva crea y retira sus triggers y datos ficticios dentro de esa base.

Los diez casos nuevos cubren fallo posterior a 500 filas, rollback final tras 501,
éxito con ajustes y otro periodo intacto, alta fallida y reintento, archivo inválido,
los tres estados no editables y dos importaciones simultáneas tanto con periodo
existente como nuevo. La concurrencia se sincroniza con una barrera SQL y se
observa desde otras conexiones reales.

Resultados después del cambio: 6 suites financieras / 75 casos y 29 suites
unitarias / 465 casos, todos pasan. También pasan el typecheck de producción,
el typecheck de la nueva suite, `npm run build` (incluidos `check:skills` y
`check:build`) y `git diff --check`. No se ejecutaron las integraciones de otros
dominios. No se accedió a producción; solo se aplicaron las 41 migraciones ya
existentes al PostgreSQL descartable para preparar los tests.

El rollback de aplicación consiste en restaurar únicamente el servicio de
importación a su revisión anterior. No hay migración ni cambio de contrato que
revertir; hacerlo reabre F02. Los tests y este diagnóstico pueden conservarse.
No restaura automáticamente datos de una reimportación que sí se haya confirmado.
