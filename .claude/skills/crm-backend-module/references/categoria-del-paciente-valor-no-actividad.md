# Categoría del paciente: valor, no actividad (2026-09-30)

> Parte de la skill `crm-backend-module`: lee antes su [índice](../SKILL.md).

`Cliente.categoria` es lo que lee todo el CRM (inbox, fichas, filtros, el índice). Su
regla vive en **`clientes/categoria-paciente.ts`** (`categoriaPorValor` + umbrales) y la
aplica `CategoriaPacienteService`:

- **Dos fuentes:** `VentaImportada` (FileMaker, en dólares, unida por `pac`) y `Venta`
  GANADA del CRM (en Bs, pasada a $ con `TipoCambioService.vigente()`). Las importadas
  se toman como vienen: el SQL solo exige `precio > 0`.
- **El SQL agrega, TypeScript decide.** La consulta devuelve gasto en la ventana y
  compras; quién es Gold lo dice `categoriaPorValor`. Escribir la regla también en un
  `CASE` de SQL es tenerla dos veces.
- **Se escribe con `$executeRaw`, no con `updateMany`:** Prisma movería `updatedAt` en
  miles de fichas y Clientes ordena por esa fecha. Recalcular no es editar.
- **Fijada a mano = intocable.** `categoriaFijadaEn` no nulo saca a la ficha del
  cálculo, y el UPDATE lo vuelve a exigir por si la fijan mientras corre el barrido.
  Solo SUPER_ADMIN fija (`PUT /clientes/:id/categoria`, `null` = automática): las
  agentes son ADMIN para cooperar en el chat y la categoría decide campañas.
- **`categoria` ya no está en `CreateClienteDto`.** Estaba, cualquier agente la cambiaba
  editando la ficha, y la siguiente venta la pisaba. `whitelist` descarta la de un
  cliente viejo que la siga mandando.
- **Cuándo se recalcula:** cada 6 h todas (así entra una planilla sin que
  `planilla-comisiones` conozca a Clientes, y una Gold que deja de comprar baja sola),
  y en el acto una sola al guardar una venta o cambiar el PAC.

**El valor se suma en UN sitio:** `valorDePacientesSql()` (mismo archivo) son las CTE
`filemaker` y `crm` que usan la categoría y Audiencias. Si cada uno sumara a su manera,
una paciente Gold en su ficha podría no serlo en una audiencia.

**Campañas es UN módulo (`modules/campanas`), con la audiencia dentro** (2026-10-03).
La audiencia nació como módulo y pantalla aparte, pero no tiene otro uso que armar una
campaña: `AudienciasService` es un provider más del módulo y su ruta es
`GET /campanas/audiencia`, declarada antes de `:id` (Express casa en orden y, después,
«audiencia» se leería como el id de una campaña). Si algo más necesita segmentar
pacientes, se exporta el service; no se le devuelve su módulo.

**La audiencia solo lee.** El embudo cuenta a cada paciente por su
PRIMER motivo de exclusión (`MOTIVOS_EXCLUSION`, en orden), así que los números suman
exactamente el total; resumen y página salen de la misma CTE `MATERIALIZED`, en una
sentencia, y el total que se pagina es el «elegibles» del resumen. «Campaña reciente» se
lee de `Mensaje.plantillaCategoria = 'MARKETING'`: **si añades un camino que mande
plantillas, guarda su categoría**, o Audiencias le volverá a escribir a quien acaba de
recibir una.

**Campañas (`modules/campanas`) mandan por `EnvioPlantillasService.enviarPlantillaDeCampana`,
nunca por `enviarPlantilla`.** El envío del chat está hecho para una persona atendiendo: asigna el
chat y la paciente a quien escribe, reabre, mueve `updatedAt` y saca de «Sin responder».
Una campaña lanzada por el propietario dejaría cientos de chats a su nombre, inundaría
«Todas» y escondería a quien esperaba respuesta. El camino de campaña comparte las
validaciones (línea, plantilla, variables, baja) y ninguno de esos efectos; el mensaje
va `automatico: true` y un chat nuevo nace cerrado.

- **Idempotencia:** `claveDeEnvio(destinatarioId)` como `clientMessageId`. Tras una caída
  la fila vuelve a PENDIENTE (`onModuleInit`) y el reintento recupera el mismo mensaje.
  **Todo chequeo previo al envío tiene que excluir el mensaje de la propia
  destinataria**: «otra campaña reciente» lo veía y la omitía.
- **Pausa sola** ante un 400/503 de Conversaciones (plantilla retirada, línea caída):
  vale para todas, seguir solo apila fallos. Un fallo de una sola paciente es FALLIDO.
- Las métricas no se copian: se cuentan sobre `Mensaje` (lo marca el webhook).

**Cicatriz:** se calculaba solo con las ventas del CRM —22 en total— y nunca caducaba:
16.294 de 16.318 fichas eran Prospecto, la categoría no servía para decidir nada y nadie
lo notaba porque no fallaba, solo no decía nada.
