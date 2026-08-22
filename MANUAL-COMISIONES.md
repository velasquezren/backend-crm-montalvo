# Manual de comisiones — Clínica Montalvo

Cómo el sistema calcula la planilla, regla por regla, con los números reales de
**enero 2026** como ejemplo, y en qué pantalla se hace cada cosa.

Este documento describe lo que el software hace hoy. Si algo aquí no coincide con
lo que hace el sistema, el equivocado es el documento.

**Cómo leerlo.** La sección 1 es el flujo de trabajo y la 2 las pantallas: con
esas dos se opera el módulo. De la 4 a la 13 están las reglas de cálculo, para
cuando haya que explicar un número concreto. La 14 es un mes completo de ejemplo
y la 16 las preguntas que más se repiten.

---

## 1. El flujo, de principio a fin

```
IMPORTAR  →  REVISAR  →  CONFIGURAR  →  CALCULAR  →  REVISAR  →  CERRAR
 (Excel)   (clasificación)  (reglas)    (congela)   (reportes)  (bloquea)
```

| Paso | Qué pasa | Estado del periodo |
|---|---|---|
| **Importar** | Se sube el Excel de FileMaker. Cada fila se clasifica y se guarda. | BORRADOR |
| **Revisar** | Se corrige a mano lo que haga falta: clasificación, canal, exclusiones. | BORRADOR |
| **Configurar** | Se ajustan tarifas, objetivos y parámetros. Son **globales**. | BORRADOR |
| **Calcular** | Se liquida y **se guarda una foto de las reglas usadas**. | CALCULADO |
| **Cerrar** | Se bloquea. No se puede reimportar ni recalcular sin reabrir. | CERRADO |

### Tres cosas importantes sobre el orden

**La configuración no se guarda con el Excel.** Tarifas, niveles y parámetros son
globales: si los cambias hoy, cambian para cualquier cálculo futuro, también el de
un mes viejo. Por eso al calcular se guarda una **foto** de las reglas usadas
dentro del periodo, y los reportes la muestran. Así, meses después, se puede
responder "¿con qué reglas se pagó enero?".

**Recalcular sobrescribe.** Si el periodo ya está CALCULADO, el sistema pide
confirmación y avisa de que va a usar la configuración **actual**, que puede haber
cambiado. Los resultados anteriores se pierden.

**Reimportar conserva los ajustes manuales.** Volver a subir el mismo mes es
normal —FileMaker se corrige y se reexporta—. Las filas se reemplazan, pero las
correcciones de clasificación hechas a mano se conservan cruzándolas por servicio.

---

## 2. Las pantallas: dónde se hace cada cosa

### Planilla de Comisiones

Es la pantalla de trabajo. Arriba se elige el mes; el resto son pestañas:

| Pestaña | Para qué | Quién |
|---|---|---|
| **Importar** | Subir o arrastrar el Excel de FileMaker | Super admin |
| **Clasificación** | Revisar fila por fila cómo quedó clasificada cada venta, corregirla, excluirla con motivo | Admin |
| **Planes que comisionan** | Ver qué planes concretos pagan y cambiarlo a mano | Admin |
| **Reportes** | La liquidación de todo el equipo, y los reportes de bonos y por vendedora | Admin |
| **Configuración** | Tarifas, niveles, metas y los cuatro parámetros globales | Super admin |

En **Clasificación** se puede filtrar por clasificación, por tipo (A/B/C), por
vendedora, y buscar por servicio o paciente. El pie de la tabla muestra el total
del **filtro entero**, no el de la página que se está viendo.

En **Planes que comisionan** la lista sale ordenada del **último plan vendido al
primero** y numerada, porque ese orden *es* la regla (sección 9). Pulsar un plan
lo alterna entre automático, comisiona y no comisiona.

### Desempeño de Agentes

La ficha de una sola ejecutiva: responde **por qué cobró lo que cobró**.

- **Cabecera** — quién es y el total a transferir del mes.
- **Metas** — sus dos objetivos de planes por separado y en qué tramo de cirugías
  cayó, con cuánto le falta para el siguiente.
- **De qué se compone el pago** — una barra con el peso de cada concepto: sueldo,
  Tipo A, Tipo B, Tipo C y bonos.
- **Ventas del mes** — todas sus ventas, con buscador y filtro por canal.

Las metas y los tramos que muestra son los del **mes que se está viendo**, leídos
de la foto de reglas de ese periodo, no los de hoy.

### Resumen Anual

Los doce meses de cada vendedora en una matriz, con los trimestres y su bono.

### El selector Bs / $us

Está en la barra superior y afecta a **todo el CRM**: tablas, tarjetas y
gráficos. Es solo de visualización — no cambia ni un dato ni el cálculo.

El tipo de cambio lo trae el sistema del **último periodo importado**, no está
escrito en el programa. Y dentro de la Planilla se usa el tipo de cambio **de ese
mes**, que es con el que se liquidó: así lo que se ve en dólares cuadra con la
liquidación en bolivianos.

---

## 3. La moneda: todo se calcula en dólares

El Excel de FileMaker viene en **dólares**. Todo el cálculo ocurre en dólares y el
tipo de cambio se aplica **una sola vez, al final**, para saber cuánto se paga en
bolivianos.

En enero 2026 el tipo de cambio es **6,97**.

En pantalla, las columnas de precio, base y comisiones se muestran en la moneda
que elijas con el selector Bs / $us; lo que se paga —sueldo, total en bolivianos
y total ganado— está siempre en bolivianos porque es la moneda en la que se
transfiere.

---

## 4. Base de cálculo: sobre qué se comisiona

**La base es siempre el precio menos el 13% de impuestos.**

```
base = precio × 0,87
```

Sin excepciones. Un servicio de $57,39 tiene una base de $49,93.

### Los anticipos NO cambian la base

Si un plan trae anticipo, ese dato dice **cuánto lleva pagado la paciente** y no
afecta a la comisión. La vendedora cobra por vender el plan, no al ritmo al que se
cobra.

> **Ejemplo real de enero.** Plan Nacer Cesárea con precio 3.532,87 y anticipo
> 1.787,95. La base es **3.073,60** (3.532,87 × 0,87), no 1.787,95.

Esto está verificado contra la planilla de diciembre 2025, hoja `BDEjecutivas`:
en sus 356 filas, la columna INGRESO NETO es `precio × 0,87` en **356 de 356**, y
el anticipo en **0 de 356**, incluidas las 20 filas que traen anticipo. La fórmula
de la columna `BASE DE CALCULO` lo dice literalmente: `=SI(...; 0; PRECIO*0,87)`.

**Un plan se paga a lo largo de varios meses, pero comisiona una sola vez**: el mes
en que se vendió, por su precio entero. Lo que la paciente vaya pagando después es
asunto suyo con la clínica y no vuelve a generar comisión. Por eso da igual cuánto
adelantó y cuánto queda debiendo.

---

## 5. Clasificación: qué es cada venta

Cada fila recibe una **clasificación**, y de ella sale su **tipo de comisión**.

### De dónde sale la clasificación, por orden de prioridad

1. **El diccionario de administración.** Reglas configuradas a mano. Mandan sobre
   todo lo demás — es la vía para corregir un caso concreto sin tocar el Excel.
2. **La columna del export.** FileMaker ya trae el servicio clasificado
   (Laboratorio, Consulta, Ecografía, Cirugía, Otros servicios).
3. **Los heurísticos.** Solo si las dos anteriores no dicen nada. Deducen por el
   **área** de la venta y el texto del detalle.

Si ninguna de las tres reconoce el servicio, la fila queda marcada **para
revisión** y se clasifica como "Otros servicios" para no romper el cálculo.

### Ojo: "Plan" y "Paquete" significan lo contrario de lo que parecen

El export trae etiquetas `Plan` y `Paquete`, y **el sistema las ignora a
propósito**, porque en el vocabulario de la clínica están cruzadas:

| Dice el export | Es en realidad | Cuenta como |
|---|---|---|
| `Plan` — "Plan Nacer Cesárea (Gold)" | un **paquete** de maternidad | PLANPAQ |
| `Paquete` — "Paquete Cesarea Silver" | un **paquete** de maternidad | PLANPAQ |
| `Paquete` — "Paquete Niño Sano" | un **plan** varios | PLANNIN |

Como se ve, `Paquete` cae en los dos lados: la palabra no alcanza. Lo que sí
separa es el **área** — Maternidad o Pediatría — y es lo que usa el sistema.

Esto importa en dinero: los paquetes tienen objetivo 4 o 6 y tarifa por nivel;
los planes varios tienen objetivo **1** y tarifa plana. Confundirlos hacía
comisionar casi todos los paquetes del mes.

### Las nueve clasificaciones y su tipo

| Clasificación | Tipo | Cómo paga |
|---|---|---|
| Paquetes (PLANPAQ) | **A** | Porcentaje según nivel del paquete |
| Planes varios (PLANNIN) | **A** | Porcentaje propio |
| Cirugía | **B** | Porcentaje según nivel acumulado del mes |
| Consulta | **C** | Porcentaje fijo |
| Laboratorio | **C** | Porcentaje fijo |
| Ecografía | **C** | Porcentaje fijo |
| Otros servicios | **C** | Porcentaje fijo |
| Campaña | **C** | No comisiona (0%) |
| Promoción | **C** | No comisiona (0%) |

---

## 6. El canal: quién trajo a la paciente

Cada venta es **EMPRESA** (la trajo la clínica) o **PROPIO** (la trajo la
vendedora). El canal sale de la columna `captacion` del Excel, según un mapeo que
administración configura.

**El canal propio siempre paga más.** En servicios, 4,5% frente a 5,5%.

---

## 7. Tipo C — consulta, laboratorio, ecografía y otros

El más simple: un porcentaje fijo sobre la base.

| Clasificación | Empresa | Propio |
|---|---|---|
| Consulta | 4,5% | 5,5% |
| Laboratorio | 4,5% | 5,5% |
| Ecografía | 4,5% | 5,5% |
| Otros servicios | 4,5% | 5,5% |
| Campaña · Promoción | 0% | 0% |

> **Ejemplo.** Una consulta de $57,39 por canal empresa: base 49,93 × 4,5% =
> **$2,25**.

---

## 8. Tipo B — cirugías, por nivel acumulado

El porcentaje **no depende de la venta suelta**, sino de cuánto acumuló esa
vendedora en cirugías durante el mes.

| Nivel | Acumulado del mes | Empresa | Propio |
|---|---|---|---|
| — | menos de $1.000 | 0% | 0% |
| 1 | $1.000 – $5.000 | 1,0% | 1,5% |
| 2 | $5.000 – $10.000 | 1,5% | 2,0% |
| 3 | $10.000 – $15.000 | 2,5% | 3,0% |
| 4 | $15.000 – $22.000 | 3,0% | 3,5% |
| 5 | $22.000 – $30.000 | 3,5% | 4,0% |
| 6 | $30.000 – $40.000 | 4,0% | 4,5% |

**El nivel se aplica a todo lo acumulado, no solo al excedente.** Pasar de
$21.999 a $22.001 sube el porcentaje sobre la cifra completa.

> **Ejemplo real de enero.** Viviana acumuló **$18.374,51** en cirugías → nivel
> **4** → 3,0% por canal empresa → **$551,24** de comisión Tipo B.

---

## 9. Tipo A — planes y paquetes

El más complejo, y el que más dinero mueve.

### El objetivo es una franquicia, no una meta

Solo comisionan los planes que **superan** el objetivo:

```
planes que comisionan = vendidos − objetivo
```

Igualar el objetivo paga **cero**. Verificado contra la planilla de diciembre
2025, hoja `TIPO COMISION`: su columna VALIDACIÓN CUMPLIMIENTO es literalmente
`vendidos − objetivo`, y quien vendió tantos planes como su objetivo figura como
NO cumple.

### Hay DOS objetivos de planes, y no se mezclan

Este es el punto que más confusión genera al leer los reportes.

Los paquetes de maternidad y los planes varios tienen **objetivos distintos y se
cuentan por separado**. Son dos cubos independientes.

#### Qué es cada uno

| | **Paquetes de maternidad** (PLANPAQ) | **Planes varios** (PLANNIN) |
|---|---|---|
| Unidad de negocio | MATERNIDAD | VARIOS |
| Qué incluye | "Plan Nacer" cesárea y parto, y los paquetes de cesárea | El **Paquete Niño Sano** (pediatría) |
| Área de la venta | Maternidad | Pediatría |
| Objetivo | **4** vendedora · **6** jefa | **1** las dos |
| Tarifa | por nivel: Bronce 1/2 %, Silver 2/4 %, Gold 3/5 % | plana: 3 % empresa / 5 % propio |
| Lleva nivel | Sí (Bronce/Silver/Gold) | No |

**"Planes varios" es prácticamente el Paquete Niño Sano.** En los seis meses
exportados (octubre 2025 a marzo 2026) hay **una sola venta** de esta categoría:
un Paquete Niño Sano en enero. Con objetivo 1, no llegó a comisionar — harían
falta dos en el mismo mes para que una pague.

> ⚠️ **Los nombres del export están cruzados.** La columna `clasifiacion` de
> FileMaker etiqueta "Plan Nacer Cesárea" como `Plan` —y es un **paquete** de
> maternidad— y el "Paquete Niño Sano" como `Paquete` —y es un **plan** varios—.
> Además usa `Paquete` para los dos lados. Por eso el sistema **ignora esas dos
> palabras** y se guía por el **área** (Maternidad o Pediatría), que sí distingue.
> Ver la sección 5.

Y no confundir con el **objetivo de monto** ($12.000 / $15.000): ese no interviene
en los planes, solo en el bono de jefatura. Los planes comisionan **solo por
cantidad**.

### Los objetivos se cuentan por separado

| Cargo | Objetivo PLANPAQ | Objetivo PLANNIN | Objetivo mensual | Objetivo trimestral |
|---|---|---|---|---|
| **Jefa** | 6 | 1 | $15.000 | $15.000 |
| **Vendedora** | 4 | 1 | $12.000 | $15.000 |

> **Los cuatro casos de enero, que explican los números de la tabla:**
>
> | | Paquetes | obj | → | Planes varios | obj | → | **Columna "Planes"** |
> |---|---|---|---|---|---|---|---|
> | Viviana (jefa) | 8 | 6 | 2 | 0 | 1 | 0 | **2 comisionan** |
> | Claudia | 7 | 4 | 3 | 0 | 1 | 0 | **3 comisionan** |
> | Yelca | 5 | 4 | 1 | 0 | 1 | 0 | **1 comisiona** |
> | Zuany | 4 | 4 | 0 | 1 | 1 | 0 | **0** |
>
> Casi todo el mes es paquete de maternidad: de las 30 ventas del módulo PLANES,
> **24 son paquetes**, 5 son bariátricas (que se van a cirugía) y **una sola** es
> plan varios, el "Paquete Niño Sano" de Zuany. Zuany no cobra por planes: igualó
> los dos objetivos, y igualar paga cero.

> ⚠️ **Si viste antes esta tabla con "6 · 3 · 4 · 3 comisionan", era un error y
> está corregido.** El export nuevo de FileMaker trae una columna `clasifiacion`
> que los anteriores no tenían, y el sistema leía sus etiquetas al pie de la letra:
> mandaba a *planes varios* los 19 "Plan Nacer" —que son paquetes de maternidad—
> y a *paquetes* el "Paquete Niño Sano", que es el plan varios. Como el objetivo
> de planes varios es **1** y el de paquetes es 4 o 6, comisionaban **16 planes en
> vez de 6**. Ver la sección 5.

### Cuáles comisionan: los ÚLTIMOS

Si una vendedora hizo **8 planes** y su objetivo era **6**, comisionan **2** — y son
**los dos últimos que vendió**. Los otros 6 no pagan nada.

El orden lo da el **correlativo de registro** de la venta (`Cod. Origen`: VE1458,
VE1462…), que es el número con el que entró al sistema. No es lo mismo que la fecha:
en diciembre de 2025 la venta VE1458 lleva fecha del 22/12 y la VE1462 —posterior—
lleva la del 13/12. La planilla siempre siguió el correlativo.

En la pestaña **Planes que comisionan** la lista sale ya ordenada del último al
primero y numerada, así que los que comisionan son siempre **los de arriba**.

> **De dónde sale esta regla.** En diciembre de 2025 dos vendedoras superaron su
> objetivo de paquetes, y administración marcó a mano estas filas como COMISIONA:
>
> | Vendedora | Sus 6 paquetes, por correlativo | Objetivo | Marcados |
> |---|---|---|---|
> | Claudia | 1447 · 1452 · 1454 · 1457 · **1458** · **1462** | 4 | los 2 últimos |
> | Yelca | 1449 · 1461 · 1463 · 1465 · **1469** · **1470** | 4 | los 2 últimos |

**Por qué importa cuáles se eligen.** Cada plan paga con **su propia tarifa**, no con
un promedio. Los dos de Claudia cobraron `3% × 2.106,62 + 2% × 1.886,62 = **100,93**`.
Si en vez de los dos últimos se hubieran elegido sus dos planes más baratos, habría
cobrado **50,65** — la mitad. Esa era la regla que tenía el sistema antes, y por eso
se corrigió.

Administración puede cambiar la selección: en la pestaña **Planes que comisionan**,
pulsar cualquier plan lo marca a mano, y **lo marcado manda sobre lo automático**. Si
se marcan más planes de los que el cupo permite, los sobrantes no se pagan y el
sistema lo avisa en pantalla en vez de pagar de más en silencio.

### El porcentaje del plan

| Tipo de plan | Nivel | Empresa | Propio |
|---|---|---|---|
| Paquete maternidad | Bronce | 1% | 2% |
| Paquete maternidad | Silver | 2% | 4% |
| Paquete maternidad | Gold | 3% | 5% |
| Plan varios | — | 3% | 5% |

El nivel del paquete sale del texto del detalle (GOLD, SILVER, BRONCE). Si no lo
dice, se asume **Silver**.

**Cada plan elegido paga sobre su base completa**, no sobre el excedente, y con la
tarifa de **su propia fila**. Nada se promedia ni se reparte entre los demás planes.

---

## 10. El área RA

Las ventas cuya columna `area` del export dice **RA** pertenecen a la unidad de
reproducción asistida. Se dividen en dos grupos que se liquidan distinto:

- **Cirugía** (Aspiración de Óvulos, ICSI, Biopsia Embrionaria, Congelamiento,
  Inseminación, Transferencias) va al mismo pool de **Tipo B** que las demás
  cirugías — el nivel se fija con el acumulado del mes de TODAS las cirugías,
  RA o no.
- **Consulta, laboratorio, ecografía y otros** (lo que pide la unidad de
  reproducción y FileMaker atribuye a la ejecutiva) es **Tipo A (RA)**: se
  suma al ingreso de planes de maternidad de esa vendedora, y si esa suma
  combinada supera su **objetivo mensual en $** (12.000 vendedora / 15.000
  jefa — el mismo que usa el bono de jefatura, no el de cantidad de planes),
  el excedente cae en la misma escala de niveles que Tipo B (1.000 → 1 %,
  5.000 → 1,5 %, …, hasta 4 %/4,5 % en el nivel 6). El % del nivel se cobra
  **solo sobre la porción RA**, no sobre los planes — esos ya cobran su
  propia tarifa aparte.
- **Campaña y promoción** del área RA, en cambio, sí quedan en Tipo C al 0 %
  (`PCT_TIPO_C_RA`).

> **Verificado contra `CALCULO COMISION DICIEMBRE 2025.xlsx`** (`BDEjecutivas`,
> columnas AT-BD): en diciembre 2025, Claudia y Yelca superaron su objetivo
> combinado y cobraron NIVEL 1 sobre su porción RA (5,69 USD y 8,69 USD). Antes
> del 2026-08-22 el sistema no calculaba este cubo en absoluto y trataba TODA
> venta del área RA como Tipo C al 0 % — subpagaba exactamente esos dos casos.
>
> ⚠️ La propia planilla de administración trae una nota en `PARAMETROS!A58`:
> *"NO SE DEFINIÓ CÓMO DETERMINAR EL NIVEL EN PAGO TIPO A, EJEMPLO CLAUDIA
> CANEDO"* — ni la clínica da esta regla por cerrada del todo.

**No valen cero aunque el nivel no se alcance.** Todas las ventas del área RA
suman al monto vendido del mes, que es la base de los dos bonos. En enero son
198 de las 423 filas —170 laboratorios y 25 consultas— y aportan unos $11 al
pote de jefatura.

El 0 % de campaña/promoción se cambia en **Configuración → Reglas del cálculo
→ Comisión del área RA**, sin tocar código. La escala de niveles vive en la
tabla `NivelTipoARA` (endpoint `PATCH /planilla-comisiones/configuracion/niveles-tipo-a-ra/:nivel`,
SUPER_ADMIN); el panel de administración todavía no tiene una pantalla
dedicada para editarla — hoy se cambia por API, igual que se hacía con los
niveles de cirugía antes de tener su propia pantalla.

---

## 11. Los bonos

> ### Los bonos NO usan la base — usan el precio bruto
>
> Es la diferencia más importante de este apartado, y la que más confusión
> genera:
>
> | | Sobre qué se calcula |
> |---|---|
> | **Comisiones** (Tipo A, B y C) | La **base**: precio × 0,87 |
> | **Bonos** (jefatura y trimestral) | El **monto vendido**: precio bruto, sin quitar el 13% |
>
> Verificado celda por celda contra la planilla de diciembre 2025, hoja
> `CALCULO BONOS`. El MONTO VENDIDO que anota para la jefa es **26.641,39**, que
> es exactamente la suma de precios de su export — no 23.178,01, que sería el
> neto.

### Bono de jefatura

Cada vendedora que supera su objetivo mensual aporta al pote:

```
aporte = (monto vendido − objetivo mensual) × 0,002
```

**El pote se paga dos veces**: íntegro a la jefatura, y otro tanto igual repartido
entre el equipo de publicidad. Las vendedoras que lo generan cobran **cero** por
él.

> **Ejemplo real de enero.** Solo Viviana superó su objetivo mensual:
> `(42.725,33 − 15.000) × 0,002 = 55,45`. Con los aportes del resto el pote
> quedó en **$110,09**, que cobró íntegro como jefa.

**Comprobación con diciembre 2025**, donde las cuatro superaron su objetivo:

| | Monto vendido | Objetivo | Diferencia | × 0,002 |
|---|---|---|---|---|
| Viviana (jefa) | $26.641,39 | $15.000 | $11.641,39 | **$23,28** |
| Yelca | $20.759,43 | $12.000 | $8.759,43 | **$17,52** |
| Zuany | $18.843,40 | $12.000 | $6.843,40 | **$13,69** |
| Claudia | $18.098,82 | $12.000 | $6.098,82 | **$12,20** |
| | | | **Pote** | **$66,69** |

Los cinco números coinciden con las filas 18 a 22 de la hoja `CALCULO BONOS`.

### Bono trimestral

```
bono = promedio del trimestre × 0,005
```

Con dos condiciones:

1. **Solo se paga en meses de cierre**: marzo, junio, septiembre y diciembre. En
   enero es **cero**, y eso es correcto.
2. **Solo si el promedio supera el objetivo trimestral** ($15.000). Igualarlo paga
   cero.

El promedio se calcula sobre los **3 meses** anteriores incluyendo el que se
liquida, y usa lo **importado**, no lo liquidado: si subiste tres meses y solo
calculaste el último, el promedio sale igual de bien.

También sobre el precio bruto.

> **Ejemplo real de diciembre 2025 — Viviana.**
> `(31.908,22 + 33.025,19 + 26.641,39) / 3 = 30.524,93`
> `30.524,93 × 0,5% = 152,62 USD → Bs 1.063,76`

---

## 12. Quién se liquida

**Solo quien está en el equipo oficial.** Las vendedoras que aparecen en el Excel
pero no están configuradas se dan de alta solas y quedan a la espera de que
administración les asigne tipo y área.

No es un descarte silencioso: cada una deja un aviso en el log con lo que vendió.

> En diciembre, una vendedora con $16.189,80 en noviembre y $6.695,84 en diciembre
> no aparece en ninguna hoja de pago de la planilla real. Pagarle porque su nombre
> salió en el Excel sería inventar una comisión.

---

## 13. El total ganado

```
total ganado (Bs) = (comisiones + bonos en USD) × tipo de cambio + sueldo base
```

El sueldo base **se congela** al liquidar: un aumento posterior no cambia un mes
ya pagado.

---

## 14. Enero 2026, completo

423 ventas · tipo de cambio 6,97 · **$107.596,54** facturado · **$93.608,99** de base

Cifras leídas directamente del export `enero.xlsx`, así que no dependen de ningún
cálculo:

| | Viviana (jefa) | Claudia | Yelca | Zuany |
|---|---|---|---|---|
| Ventas del mes | 46 | 205 | 76 | 95 |
| Monto vendido | $42.725,33 | $30.251,95 | $16.611,64 | $16.453,95 |
| Base de cálculo | $37.171,04 | $26.319,20 | $14.452,13 | $14.314,93 |
| **Paquetes de maternidad** (meta 6 jefa / 4 vendedora) | 8 → **2 comisionan** | 7 → **3** | 5 → **1** | 4 → **0** |
| **Planes varios** (meta 1) | 0 → 0 | 0 → 0 | 0 → 0 | 1 → **0** |
| Acumulado cirugías | $18.374,51 | $7.506,03 | — | $2.570,13 |
| Nivel de cirugía | 4 | 2 | — | 1 |
| Sueldo base | Bs 4.236,81 | Bs 2.750,00 | Bs 2.750,00 | Bs 2.750,00 |

Una quinta persona, Gizelle, aparece con 1 venta de $1.553,67 y **no se liquida**:
no está en el equipo oficial (sección 12).

### Cómo se lee la columna de Viviana

- Vendió **$42.725,33** en 46 ventas; su base es el 87 % de eso.
- **Tipo A**: hizo 8 paquetes de maternidad con meta 6, así que comisionan
  **los 2 últimos que vendió** — no los 8, y no los dos más baratos.
- **Tipo B**: acumuló $18.374,51 en cirugías → nivel 4 → 3 % sobre todo ese
  acumulado.
- **Tipo C**: le queda muy poco, porque casi todo su laboratorio y consulta es
  del área RA, que hoy paga 0 %.
- **Bono de jefatura**: es la única que superó su objetivo mensual de $15.000.
- **Bono trimestral**: cero, porque enero no cierra trimestre.

### Las comisiones de este mes hay que volver a calcularlas

> ⚠️ Enero se liquidó **antes** de dos correcciones, así que las cifras de
> comisión que haya guardadas no son las buenas:
>
> 1. Comisionaban los planes de base más baja en vez de **los últimos vendidos**.
> 2. La clasificación cruzaba paquetes con planes varios, y por eso **comisionaban
>    16 planes donde deben comisionar 6**.
>
> **Qué hacer:** Planilla → enero 2026 → Calcular. Después, copiar aquí las filas
> de Tipo A, Tipo B, Tipo C, bonos y total ganado desde
> Reportes → Liquidación.
>
> Lo que **no** cambia y ya está en la tabla de arriba: ventas, monto vendido,
> base, acumulado de cirugías, nivel, conteo de planes y sueldo base. Ninguno
> depende de qué planes comisionan.

---

## 15. Los cuatro parámetros globales

En **Configuración → Reglas del cálculo**. Solo el super administrador puede
cambiarlos, y se aplican en el **próximo** cálculo.

| Parámetro | Valor | Qué controla |
|---|---|---|
| `PCT_TIPO_C_RA` | 0 | Campaña y promoción del área RA (el resto del área RA no pasa por este parámetro: ver sección 10) |
| `FACTOR_BONO_JEFATURA` | 0,002 | El pote sobre el excedente |
| `FACTOR_BONO_TRIMESTRAL` | 0,005 | Sobre el promedio del trimestre |
| `MESES_BONO_TRIMESTRAL` | 3 | Meses que entran en el promedio |

La escala de niveles de Tipo A (RA) —tabla `NivelTipoARA`— vive aparte de estos
cuatro parámetros; ver sección 10.

---

## 16. Preguntas frecuentes

**¿Los bonos se calculan sobre la base o sobre el precio?**
Sobre el **precio bruto**, sin quitar el 13%. Solo las comisiones usan la base.
Es la única regla del sistema donde se usa el precio completo.

**¿Por qué la base total es menor que el precio total?**
Por el 13% de impuestos, y solo por eso. En enero: **$107.596,54** de precio →
**$93.608,99** de base. La diferencia es exactamente el 13%.

Si alguna vez ves una diferencia mayor, algo va mal: significaría que alguna fila
no está usando `precio × 0,87`.

**¿Qué son exactamente los "planes varios"?**
Es la otra clasificación de plan (PLANNIN), y en la práctica es el **Paquete Niño
Sano** de pediatría. No es maternidad: los "Plan Nacer" de cesárea y parto son
*paquetes* y van al otro cubo, aunque el Excel los etiquete como "Plan".

Tiene meta **1** —para jefa y para vendedora— y tarifa plana de 3 % empresa / 5 %
propio, sin niveles Bronce/Silver/Gold.

En los seis meses exportados (octubre 2025 a marzo 2026) hay **una sola venta** de
esta categoría. Con meta 1, harían falta dos en el mismo mes para que una pague.

**Una vendedora hizo 8 planes y su meta era 6. ¿Cuánto cobra?**
Por **2 planes**, y son los **dos últimos** que vendió. Los otros 6 no pagan nada.
Si hubiera hecho 6 o menos, no cobraría nada por planes.

**¿Y si el plan se paga en cuotas durante varios meses?**
No importa. El plan comisiona **una sola vez**, en el mes en que se vendió y por su
precio entero menos el 13%. Lo que la paciente pague después no vuelve a generar
comisión, y lo que quede debiendo no la reduce.

**¿Por qué una venta dice "sin % directo · RA"?**
Porque su columna `area` del export dice RA. Si es cirugía, cobra por el nivel de
Tipo B; si es consulta/laboratorio/ecografía/otros, cobra por el nivel de Tipo A
(RA) cuando el excedente combinado con planes supera el objetivo mensual — no
tiene un % fijo por fila en ninguno de los dos casos. Solo campaña y promoción
del área RA están en 0 fijo. Sigue sumando al monto vendido y por tanto a los
bonos en cualquier caso.

**¿Por qué una cirugía dice "según nivel"?**
Porque su porcentaje depende del acumulado del mes de esa vendedora, no de la
venta suelta.

**¿Por qué no comisionan todos los planes?**
Porque el objetivo es una franquicia: solo comisiona lo que lo **supera**. Los que
comisionan son los **últimos vendidos**, y administración puede cambiar cuáles en
la pestaña "Planes que comisionan".

**¿Hay dos formas de que un plan comisione, por meta o por monto?**
No. Los planes comisionan **solo por cantidad**, y con dos objetivos separados:
uno para paquetes y otro para planes varios. El objetivo de **monto**
($12.000/$15.000) no toca los planes — solo decide el bono de jefatura.

**Cambié un parámetro y los números no se movieron.**
Los parámetros se aplican en el próximo cálculo. Hay que recalcular el periodo.

**¿Puedo saber con qué reglas se pagó un mes anterior?**
Sí, si se calculó después de agosto 2026: los reportes muestran las reglas
congeladas. Los periodos calculados antes lo dicen explícitamente.
