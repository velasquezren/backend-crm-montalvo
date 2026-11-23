# Un campo de DTO con valores cerrados lleva `@IsIn`/`@IsEnum`, no `@IsString`

> Parte de la skill `crm-backend-module`: lee antes su [índice](../SKILL.md).

`@IsString()` en un campo que el service compara contra literales
(`'CON_COMPROBANTE'`, `'SIN_COMPROBANTE'`) deja pasar cualquier otra cosa hasta el
`else`, que casi siempre significa "sin filtro". El resultado no es un error: es
**la lista entera**, y en una pantalla titulada "Pendientes de comprobante" eso se
lee como un dato ("están todas pendientes"), no como el fallo que es.

Y al revés: **un centinela de la interfaz no cruza la API.** "Sin filtro" se dice
omitiendo el parámetro, no mandando un `TODOS` que el service tenga que conocer.
Exporta el conjunto (`export const FILTROS_X = [...] as const`) y valida con
`@IsIn(FILTROS_X)`; el tipo sale del mismo sitio y no hay dos listas que sincronizar.

`check:skills` exige un decorador **por campo**, no uno por clase: un campo nuevo
en un DTO que ya estaba validado llega `undefined` al service, sin lanzar y sin
log, y es así como entra de verdad este fallo.
