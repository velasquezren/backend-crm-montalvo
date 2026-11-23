# 3. Escala real de datos (medida en producción, no estimada)

> Parte de la skill `crm-backend-arquitectura`: lee antes su [índice](../SKILL.md).

Remedido el **2026-09-02** (`pg_stat_user_tables`); entre paréntesis, lo que
había el 2026-08-26, para que se vea la pendiente y no solo la foto:

```
Lead            15.665  (15.620)
Cliente         15.652  (15.608)   33 MB — 21 MB tabla + 11 MB índices
Mensaje          2.564   (2.186)
VentaImportada   2.368   (1.287)   ← +84 % en una semana
AuditLog           583     (473)
Conversacion       370     (325)
Venta                6       (3)
```

**La que crece rápido ahora es otra**: hasta el 2026-08-26 eran las dos del
inbox (`Mensaje` y `Conversacion`, que motivaron el arreglo de `LIMITE_INBOX`
en §7). En la semana siguiente el inbox se calmó (+17 % y +14 %) y el salto se
lo llevó **`VentaImportada`, que casi se duplicó: 1.287 → 2.368 (+84 %)**.

Eso importa porque `VentaImportada` es justo la tabla que alimentan y leen el
parseo y la exportación de Excel con `exceljs` — el trabajo síncrono que bloquea
el único núcleo (§7). Todavía no duele, pero es el número a mirar la próxima vez
que alguien reporte que la planilla "se cuelga", y ya no vale el "hoy con 1.287
filas probablemente no se nota" que dice más abajo esta misma sección.

Las dos tablas grandes siguen planas: `Cliente` y `Lead` sumaron ~45 filas cada
una en esos siete días (+0,3 %). Las grandes no crecen; las chicas sí.

`TipoCambioDiario` (módulo `tipo-cambio`, agregado después de esta medición)
no está en la tabla: es un valor por día, así que su techo natural es ~365
filas/año aunque nunca se pierda una sincronización — no hace falta remedirlo
para saber que no es un problema de escala.

Base completa: **60 MB**. Esto importa para calibrar cualquier conversación sobre
"performance": **no es un problema de volumen de datos** — 60 MB entra entero en
RAM varias veces. El cuello de botella es la máquina compartida (§2: cuatro
núcleos y 7,9 GB que se reparten con Resultados y ClamAV), no el tamaño de las tablas. Optimizar asumiendo
un problema de "big data" que no existe sería resolver lo que no duele.

`Venta` pasó de 0 (2026-08-21) a 3 (2026-08-26) a 6 (2026-09-02): se usa, pero
a cuentagotas. Sigue en pie la lectura de que el flujo real de ventas vive
todavía en `VentaImportada` (el Excel de comisiones) y que el módulo `Ventas` es
nuevo o está en migración. No es código muerto — confirmar con quien conoce el
negocio antes de tocarlo.
