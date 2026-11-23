# Get-or-create bajo concurrencia: `upsert` NO basta, usa catch-P2002

> Parte de la skill `crm-backend-module`: lee antes su [índice](../SKILL.md).

Cualquier endpoint que reciba tráfico concurrente para la misma entidad
(webhooks de Meta, que se entregan en paralelo y con reintentos) tiene una
race clásica en el patrón `findFirst → si no existe → create`: dos peticiones
simultáneas ven "no existe" a la vez y ambas crean; la segunda choca contra el
índice único con un 500 (P2002). **Probado: `prisma.upsert` tampoco lo resuelve**
— internamente hace el mismo "buscar → insertar" y también rebota bajo carrera.

El patrón correcto (ver `ClientesService.obtenerOCrearPorTelefono` y
`ConversacionesService.obtenerOCrearConversacion`): intentar crear y, si el
único rebota, releer — para entonces la otra petición ya lo creó.

```ts
const existente = await this.prisma.x.findUnique({ where: { clave } });
if (existente) return existente;
try {
  return await this.prisma.x.create({ data: { … } });
} catch (error) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const yaCreado = await this.prisma.x.findUnique({ where: { clave } });
    if (yaCreado) return yaCreado; // otra petición concurrente lo creó
  }
  throw error;
}
```

Requiere que exista el índice único sobre la clave. Si una entidad relacionada
NO puede ser única (ej. un cliente sí puede tener varios `Lead`), no fuerces un
único: en su lugar **ata su creación a la de una entidad que sí lo sea** — el
lead de "primer contacto" se crea solo cuando `obtenerOCrearConversacion`
devuelve `esNueva: true`, y como la conversación es única por cliente,
exactamente una petición concurrente lo dispara. Verifica siempre con una
prueba real de N webhooks en paralelo (`curl … &` × N) que los conteos
resultantes son 1/1/N/1, no confíes en que "debería" estar bien.

### El mismo razonamiento vale para VALIDAR unicidad, no solo para crear

Comprobar con un `findUnique` que un código no está usado y crear después es la
misma carrera con otro nombre, y falla peor: entre el SELECT y el INSERT cabe
otra petición, así que bajo carrera real uno de los dos rebota igual — pero como
nadie esperaba el rebote, sale un **500 "error del servidor"** donde debía leerse
"ese PAC ya es de otra paciente". Y son dos viajes a la base por alta que no
hacen falta: el índice único ya sabe la respuesta.

Entró exactamente así el 2026-09-05 con `Cliente.pac`, en el mismo archivo que
200 líneas más abajo documenta por qué ese patrón no sirve. Que la lección esté
escrita al lado no basta: **si el campo tiene índice único, la validación es el
catch del P2002**.

**Pero ojo con cómo se averigua QUÉ columna chocó.** Lo natural es mirar
`error.meta.target`, y con el driver adapter que usa este proyecto **ese campo
no existe**: el nombre del índice viaja en
`error.meta.driverAdapterError.cause.constraint.index`. Mirar solo `target`
devuelve `undefined`, el código no reconoce el choque y el P2002 sube como 500.

No es teórico: así estuvo rota la idempotencia de R2.1 desde que se desplegó
hasta el 2026-09-18. `recuperarEnvioDuplicado` no reconocía el rebote de
`clientMessageId`, así que el reintento —lo único que R2.1 existía para hacer
seguro— devolvía un 500 sobre un mensaje que **sí** se había enviado. No lo vio
nadie porque la prueba de R2.1 ejercitaba el índice contra Prisma directamente y
nunca pasaba por ese método.

Hay que mirar **las dos formas**, y hay **un solo sitio** donde están miradas:
`prisma/choque-unico.ts` (`candidatosDeChoqueUnico`, `tablaDelChoque`,
`campoDeIndice`). Úsalo; no vuelvas a leer `error.meta` a mano.

Vive aparte porque tenerlo dentro de un módulo no sirvió de nada: el 2026-09-29
apareció **la segunda víctima de lo mismo**, `traducirChoqueUnico` de Clientes,
que llevaba muerta desde la migración a Prisma 7 sin que nadie lo notara. Un
teléfono repetido —el caso más corriente de recepción, corregir el número de una
paciente— devolvía el error crudo de Prisma en vez del 409 que explica de quién
es ese número. El helper de Conversaciones ya tenía la respuesta a 700 líneas de
distancia; por eso ahora es compartido y tiene prueba propia con un volcado
literal del error, no una forma inventada.

Si el 409 va a llegar a una pantalla, manda también **qué campo** chocó en el
cuerpo (`{ message, campo }`): sin eso la interfaz tiene que deducirlo del texto
del mensaje, y un choque de PAC acaba señalando la casilla del teléfono.

Y la lección de fondo, que vale para cualquier módulo: **probar que el índice
único rebota NO es probar lo que tu código hace con el rebote.** Eso se prueba
llamando al service.

```ts
try {
  return await this.prisma.cliente.create({ data });
} catch (error: unknown) {
  this.traducirChoqueUnico(error, { telefono: dto.telefono, pac: pacNormalizado });
  throw error;
}
```

### Reclamar un recurso "del pool": UPDATE condicionado, no lectura-y-escritura

Distinto del get-or-create de arriba: acá el registro YA existe y dos agentes
pueden intentar quedárselo a la vez (ej. responder la misma conversación sin
asignar). No lo resuelvas leyendo si está libre (`findUnique`) y recién
después escribiendo — dos peticiones concurrentes pueden leer "libre" a la
vez y las dos escriben, la segunda pisando a la primera. Condiciona el propio
`where` del `update` al estado que asumís que tiene ahora (`agenteId: null`) y
usa `updateMany`, no `update` (que exige que el registro exista con ESE
`where` exacto, o lanza). De dos escrituras concurrentes, exactamente una
afecta una fila; la otra afecta cero filas y no necesita saber por qué. Ver
`enviarMensaje()` en `conversaciones.service.ts`.
