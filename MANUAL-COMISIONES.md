# Manual de comisiones — Clínica Montalvo

Cómo el sistema calcula la planilla, regla por regla, con los números reales de
**enero 2026** como ejemplo.

Este documento describe lo que el software hace hoy. Si algo aquí no coincide con
lo que hace el sistema, el equivocado es el documento.

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

## 2. La moneda: todo se calcula en dólares

El Excel de FileMaker viene en **dólares**. Todo el cálculo ocurre en dólares y el
tipo de cambio se aplica **una sola vez, al final**, para saber cuánto se paga en
bolivianos.

En enero 2026 el tipo de cambio es **6,97**.

En pantalla verás `$` en las columnas de precio, base y comisiones, y `Bs` solo en
lo que se paga: total en bolivianos, sueldo y total ganado.

---

## 3. Base de cálculo: sobre qué se comisiona

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
el anticipo en **0 de 356**, incluidas las 20 filas que traen anticipo.

---

## 4. Clasificación: qué es cada venta

Cada fila recibe una **clasificación**, y de ella sale su **tipo de comisión**.

### De dónde sale la clasificación, por orden de prioridad

1. **El diccionario de administración.** Reglas configuradas a mano. Mandan sobre
   todo lo demás — es la vía para corregir un caso concreto sin tocar el Excel.
2. **La columna del export.** FileMaker ya trae el servicio clasificado
   (Laboratorio, Consulta, Ecografía, Plan, Paquete, Cirugía, Otros servicios).
3. **Los heurísticos.** Solo si las dos anteriores no dicen nada. Deducen por el
   módulo y el texto del detalle.

Si ninguna de las tres reconoce el servicio, la fila queda marcada **para
revisión** y se clasifica como "Otros servicios" para no romper el cálculo.

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

## 5. El canal: quién trajo a la paciente

Cada venta es **EMPRESA** (la trajo la clínica) o **PROPIO** (la trajo la
vendedora). El canal sale de la columna `captacion` del Excel, según un mapeo que
administración configura.

**El canal propio siempre paga más.** En servicios, 4,5% frente a 5,5%.

---

## 6. Tipo C — consulta, laboratorio, ecografía y otros

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

## 7. Tipo B — cirugías, por nivel acumulado

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

## 8. Tipo A — planes y paquetes

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
cuentan por separado**. La columna "Planes" de la liquidación muestra la **suma**
de los dos cálculos, no un cálculo único.

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
> | Viviana (jefa) | 1 | 6 | 0 | 7 | 1 | 6 | **6 comisionan** |
> | Claudia | 3 | 4 | 0 | 4 | 1 | 3 | **3 comisionan** |
> | Yelca | 0 | 4 | 0 | 5 | 1 | 4 | **4 comisionan** |
> | Zuany | 1 | 4 | 0 | 4 | 1 | 3 | **3 comisionan** |
>
> Ninguna llega al objetivo de paquetes, que es 4 o 6. Y como el de planes varios
> es solo **1**, casi todos superan — por eso las cifras parecen altas.

### Cuáles comisionan, si no comisionan todos

El sistema elige los de **base más baja** primero, que es lo conservador para la
clínica. Administración puede cambiarlo: en la pestaña **Planes**, pulsar
cualquier plan lo marca a mano, y lo marcado manda sobre lo automático.

### El porcentaje del plan

| Tipo de plan | Nivel | Empresa | Propio |
|---|---|---|---|
| Paquete maternidad | Bronce | 1% | 2% |
| Paquete maternidad | Silver | 2% | 4% |
| Paquete maternidad | Gold | 3% | 5% |
| Plan varios | — | 3% | 5% |

El nivel del paquete sale del texto del detalle (GOLD, SILVER, BRONCE). Si no lo
dice, se asume **Silver**.

**El plan elegido paga sobre su base completa**, no sobre el excedente.

---

## 9. El área RA

Las ventas cuya columna `area` del export dice **RA** pertenecen a la unidad de
reproducción asistida.

**Hoy no pagan comisión directa: su porcentaje está en 0.** Antes las cobraba el
rol de coordinadora RA, que ya no existe.

> **Pero no valen cero.** Esas ventas **sí suman al monto vendido del mes**, que
> es la base de los dos bonos. En enero son 198 de las 423 filas —170 laboratorios
> y 25 consultas— y aportan unos $11 al pote de jefatura.

Si administración decide que deben comisionar, se cambia en **Configuración →
Reglas del cálculo → Comisión del área RA**, sin tocar código.

---

## 10. Los bonos

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

## 11. Quién se liquida

**Solo quien está en el equipo oficial.** Las vendedoras que aparecen en el Excel
pero no están configuradas se dan de alta solas y quedan a la espera de que
administración les asigne tipo y área.

No es un descarte silencioso: cada una deja un aviso en el log con lo que vendió.

> En diciembre, una vendedora con $16.189,80 en noviembre y $6.695,84 en diciembre
> no aparece en ninguna hoja de pago de la planilla real. Pagarle porque su nombre
> salió en el Excel sería inventar una comisión.

---

## 12. El total ganado

```
total ganado (Bs) = (comisiones + bonos en USD) × tipo de cambio + sueldo base
```

El sueldo base **se congela** al liquidar: un aumento posterior no cambia un mes
ya pagado.

---

## 13. Enero 2026, completo

423 ventas · tipo de cambio 6,97 · **$107.596,53** vendidos · **$93.608,91** de base

| | Viviana (jefa) | Claudia | Yelca | Zuany |
|---|---|---|---|---|
| Monto vendido | $42.725,33 | $30.251,94 | $16.611,64 | $16.453,95 |
| Base de cálculo | $37.171,06 | $26.319,11 | $14.452,10 | $14.314,95 |
| **Tipo A** (planes) | $412,89 | $191,30 | $278,29 | $159,58 |
| **Tipo B** (cirugías) | $551,24 | $112,59 | — | $25,70 |
| **Tipo C** (resto) | $24,60 | $99,61 | $51,37 | $81,86 |
| Nivel de cirugía | 4 | 2 | — | 1 |
| Acumulado cirugías | $18.374,51 | $7.506,03 | — | $2.570,13 |
| Planes vendidos → comisionan | 8 → 6 | 7 → 3 | 5 → 4 | 5 → 3 |
| Bono jefatura | $110,09 | — | — | — |
| Bono trimestral | — | — | — | — |
| **Total comisiones USD** | **$1.098,82** | **$403,50** | **$329,66** | **$267,14** |
| En bolivianos | Bs 7.658,78 | Bs 2.812,40 | Bs 2.297,73 | Bs 1.861,97 |
| Sueldo base | Bs 4.236,81 | Bs 2.750,00 | Bs 2.750,00 | Bs 2.750,00 |
| **TOTAL GANADO** | **Bs 11.895,59** | **Bs 5.562,40** | **Bs 5.047,73** | **Bs 4.611,97** |

### Cómo leer la fila de Viviana

- Vendió **$42.725,33** en 46 ventas.
- Su base es **$37.171,06** — el 87% del precio, sin el 13% de impuestos.
- **Tipo A**: de sus 8 planes comisionan 6 (1 paquete con objetivo 6 → ninguno;
  7 planes varios con objetivo 1 → seis). Total **$412,89**.
- **Tipo B**: acumuló $18.374,51 en cirugías → nivel 4 → 3% → **$551,24**.
- **Tipo C**: solo $24,60, porque casi todo su laboratorio y consulta es del área
  RA, que no comisiona.
- **Bono jefatura**: fue la única que superó su objetivo mensual de $15.000, así
  que el pote de $110,09 es suyo.
- **Bono trimestral**: cero, porque enero no es mes de cierre.
- Total: $1.098,82 × 6,97 = Bs 7.658,78, más su sueldo de Bs 4.236,81 =
  **Bs 11.895,59**.

---

## 14. Los cuatro parámetros globales

En **Configuración → Reglas del cálculo**. Solo el super administrador puede
cambiarlos, y se aplican en el **próximo** cálculo.

| Parámetro | Valor | Qué controla |
|---|---|---|
| `PCT_TIPO_C_RA` | 0 | Porcentaje del área RA |
| `FACTOR_BONO_JEFATURA` | 0,002 | El pote sobre el excedente |
| `FACTOR_BONO_TRIMESTRAL` | 0,005 | Sobre el promedio del trimestre |
| `MESES_BONO_TRIMESTRAL` | 3 | Meses que entran en el promedio |

---

## 15. Preguntas frecuentes

**¿Los bonos se calculan sobre la base o sobre el precio?**
Sobre el **precio bruto**, sin quitar el 13%. Solo las comisiones usan la base.
Es la única regla del sistema donde se usa el precio completo.

**¿Por qué la base total es menor que el precio total?**
Por el 13% de impuestos, y solo por eso. En enero: **$107.596,53** de precio →
**$93.608,91** de base. La diferencia es exactamente el 13%.

Si alguna vez ves una diferencia mayor, algo va mal: significaría que alguna fila
no está usando `precio × 0,87`.

**¿Por qué una venta dice "sin % directo · RA"?**
Porque su columna `area` del export dice RA, y el área RA tiene su porcentaje en
0. Sigue sumando al monto vendido y por tanto a los bonos.

**¿Por qué una cirugía dice "según nivel"?**
Porque su porcentaje depende del acumulado del mes de esa vendedora, no de la
venta suelta.

**¿Por qué no comisionan todos los planes?**
Porque el objetivo es una franquicia: solo comisiona lo que lo supera. El sistema
elige los de base más baja, y administración puede cambiar cuáles.

**¿Hay dos formas de que un plan comisione, por meta o por monto?**
No. Los planes comisionan **solo por cantidad**, y con dos objetivos separados:
uno para paquetes y otro para planes varios. El objetivo de **monto**
($12.000/$15.000) no toca los planes — solo decide el bono de jefatura.

**Cambié un parámetro y los números no se movieron.**
Los parámetros se aplican en el próximo cálculo. Hay que recalcular el periodo.

**¿Puedo saber con qué reglas se pagó un mes anterior?**
Sí, si se calculó después de agosto 2026: los reportes muestran las reglas
congeladas. Los periodos calculados antes lo dicen explícitamente.
