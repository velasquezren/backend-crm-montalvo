# CAMP-1 — cerrar el eslabón Lead → Venta

Continúa [`CAMP-0-campanas-meta-roi.md`](CAMP-0-campanas-meta-roi.md), cuya
conclusión fue: la captura de campañas funciona, lo que falta es enlazar la
venta con el lead. Esto es ese enlace.

Medido contra producción el **2026-09-18**. Decisión aplicada: **opción B** —
poblar `Venta.leadId` desde la interfaz, sin heurísticas.

## Qué estaba roto, exactamente

Nada en el backend ni en el esquema: `Venta.leadId` existe con su índice, el DTO
lo acepta, el service valida que el lead sea del mismo cliente y `GET /ventas`
ya devuelve `lead.anuncioId`. El selector de origen existe en la interfaz desde
el **2026-08-21** (`aa90bc1`).

El fallo era de un solo renglón: **el selector arrancaba en «Ninguno» y había
que acordarse de pulsar el chip.** Nadie se acordaba.

| | |
| --- | ---: |
| Ventas en la base | 14 |
| Ventas con `leadId` | **0** |
| Ingresos | Bs 24.262 |
| Ingresos trazables hasta un anuncio | **Bs 400 (1,6 %)** |

## El arreglo

Preseleccionar el lead **solo cuando no hay ambigüedad**. La regla vive aparte
de la página, en `origen-inequivoco.ts`, porque es lo único delicado:

```ts
leadsAbiertos.length === 1 ? leadsAbiertos[0].id : null
```

Con dos leads abiertos no se elige ninguno. Quedarse con el más reciente sería
inventar de qué anuncio vino la venta, y **una atribución falsa es peor que un
`null`**: se ve igual que una correcta en un informe y nadie la audita después.
El caso no es hipotético — hay 16 clientes con dos leads.

La preselección nunca pisa una decisión: un chip pulsado o una venta abierta
desde la ficha de un lead (`?leadId=`) mandan sobre ella. Y cuando hay más de un
lead, los chips muestran la fecha para que la agente pueda distinguirlos.

## El efecto secundario que importa tanto como la atribución

`LeadsService.marcarConvertidos(clienteId, leadId?)` tiene dos ramas:

- **con `leadId`** → cierra solo ese lead;
- **sin `leadId`** → cierra **todos** los leads abiertos del cliente.

Con `leadId` siempre en NULL, la rama estrecha era **código muerto** y todas las
ventas caían en la ancha. Para un cliente con dos campañas, vender por una
cerraba la otra como «convertida» y le atribuía el mismo resultado. A partir de
ahora la rama estrecha se usa de verdad.

Las dos ramas estaban ya cubiertas por pruebas de integración; lo que cambia es
cuál se ejecuta en producción.

## Cobertura esperada

La preselección acierta en el **99,9 % de los clientes con lead** (15.822 de
15.838 tienen exactamente uno). Lo que **no** se puede predecir es cuántos
ingresos pasarán a ser trazables: eso depende de qué proporción de las ventas
nuevas venga de clientes con lead de campaña, y hoy solo **1 de 288** leads con
`anuncioId` ha terminado en venta. La medición vuelve a hacerse en 4-6 semanas,
con el umbral que ya fijó CAMP-0: **60 % de cobertura de ingresos y 30 ventas
atribuidas** antes de publicar CAC o ROAS.

## Histórico: 14 ventas, propuesta de backfill (NO ejecutada)

Clasificación de las ventas existentes:

| Caso | Ventas | Ingresos | Leads con anuncio |
| --- | ---: | ---: | ---: |
| **A** · cliente con UN lead (inequívoco) | **14** | Bs 24.262 | 1 |
| B · cliente con VARIOS leads (ambiguo) | 0 | — | — |
| C · cliente SIN lead | 0 | — | — |

Las 14 son caso A, así que el backfill sería mecánico y sin ambigüedad:

```sql
-- PROPUESTA. No ejecutar sin autorización explícita.
UPDATE "Venta" v SET "leadId" = (SELECT l.id FROM "Lead" l WHERE l."clienteId" = v."clienteId")
WHERE v."leadId" IS NULL
  AND (SELECT count(*) FROM "Lead" x WHERE x."clienteId" = v."clienteId") = 1;
```

**Qué ganaría**: 14 ventas enlazadas. **Qué no ganaría**: los ingresos
trazables seguirían siendo **Bs 400 de Bs 24.262**, porque solo uno de esos 14
leads tiene `anuncioId`. La cobertura pasa de 1,6 % a 1,6 %.

Dicho de otro modo: el backfill hace el grafo consistente, **no mejora la
métrica**. Es barato y reversible (se puede volver a NULL por los mismos ids),
pero no urge. Si se ejecuta, conviene guardar antes la lista de los 14 ids.

Hay un efecto colateral menor: los 14 leads implicados ya están en `CONVERTIDO`,
así que el `UPDATE` no los toca y no cambia ningún KPI de embudo.

## Límite conocido

**No se puede corregir el lead de una venta ya registrada.** El módulo no tiene
endpoint de edición —solo `PATCH /ventas/:id/estado`—, así que un origen mal
elegido hoy solo se arregla en la base. Con la preselección puesta esto importa
menos que antes, pero sigue siendo cierto y no se ha añadido el endpoint: sería
superficie nueva que CAMP-1 no pedía.
