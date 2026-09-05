---
name: crm-backend-module
description: Patrón obligatorio de los módulos NestJS de este CRM — límites de dominio, paginación, validación con DTOs, jerarquía de roles, concurrencia, webhooks y auditoría. Úsalo SIEMPRE al crear o modificar cualquier módulo bajo src/modules/, al añadir o tocar un endpoint, al escribir una consulta de Prisma, al cambiar schema.prisma o generar una migración, y al integrar un servicio externo (WhatsApp/Meta) — incluso para cambios que suenan pequeños ("agrega un campo", "un endpoint de listado").
---

# Patrón de módulo del backend

NestJS 10 + Prisma 7 + PostgreSQL. Reglas base: `CRM_MANIFESTO.md` (repo del frontend) §1.1.

## Reglas de oro

1. **Un módulo nunca toca la base de otro dominio.** Si Ventas necesita recategorizar un cliente,
   llama a `ClientesService.actualizarCategoria()`, jamás a `prisma.cliente` directamente.
2. **Toda entrada externa se valida con un DTO** antes de llegar a la lógica de negocio.
   Nunca `@Body('campo') x: any` — eso salta el `ValidationPipe` por completo.
3. **`schema.prisma` es la única fuente de verdad del modelo.** No dupliques tipos a mano.

## Los tipos de Prisma salen del barril, nunca de `@prisma/client`

```ts
import { Prisma, Rol, EstadoVenta } from '../../prisma/prisma-client';
```

Desde Prisma 7 el cliente **se genera** a `src/generated/prisma/` (fuera de git,
lo rehace `postinstall`) en vez de vivir dentro del paquete. Importar de
`@prisma/client` ya no da los tipos reales: compila, pero `Prisma` queda
degradado y cosas como `error instanceof Prisma.PrismaClientKnownRequestError`
dejan de estrechar el tipo — que es como se descubrió. `check:skills` lo rechaza.

El barril existe para que la ruta generada se cite **una vez**: si cambia el
`output` del `schema.prisma`, cambia una línea y no 51 archivos.

**El cliente nunca se instancia a mano.** Se inyecta `PrismaService`, que es
quien arma el adaptador `pg` con el tamaño de pool y los tiempos de espera
pensados para este servidor. Un `new PrismaClient()` suelto se salta todo eso.

## Anatomía

```
modules/<dominio>/
├── dto/
│   ├── create-<x>.dto.ts
│   ├── update-<x>.dto.ts
│   └── query-<x>.dto.ts     # extiende PaginationDto
├── <dominio>.controller.ts  # sin lógica de negocio: valida y delega
├── <dominio>.service.ts     # toda la lógica
└── <dominio>.module.ts      # exporta el service si otros lo consumen
```

## Paginación (obligatoria en todo listado)

Nunca devuelvas una tabla entera ni uses `take` fijo: hay 15.000+ clientes.

```ts
// dto/query-x.dto.ts
export class QueryClienteDto extends PaginationDto {
  @IsOptional() @IsEnum(CategoriaCliente) categoria?: CategoriaCliente;
}

// service
async findAll(query: QueryClienteDto, soloAgenteId?: string) {
  const where: Prisma.ClienteWhereInput = { /* … */ };
  const { skip, take } = calcularPaginacion(query);

  const [datos, total] = await this.prisma.$transaction([
    this.prisma.cliente.findMany({ where, orderBy: { updatedAt: 'desc' }, skip, take }),
    this.prisma.cliente.count({ where }),
  ]);

  return paginar(datos, total, query);
}
```

Respuesta: `{ datos, total, pagina, limite, totalPaginas }`.
Por defecto 25 por página, tope duro 100 (`common/dto/pagination.dto.ts`).
El frontend consume este sobre con `RespuestaPaginada<T>` y el átomo `<app-paginator>`.

**Ya no hay excepciones. El inbox era la última, y salió cara** (2026-08-27).
Devolvía las 500 conversaciones más recientes sin paginar y la UI filtraba por
pestañas y **buscaba** sobre ese conjunto. El fallo no era lentitud: una
conversación en el puesto 501 no aparecía al buscar a esa paciente por nombre,
así que la agente leía "sin resultados" y concluía que no estaba en el sistema.

Es la forma más peligrosa de este bug, porque **un corte se lee como un dato**.
Con un `take` fijo la pantalla no dice "hay más": dice "no hay". Y el WARN que
avisaba del tope estaba en el log del servidor, donde nadie lo mira.

Lo que costó arreglarlo, por si tienta repetirlo: mover las cuatro operaciones
—ordenar, filtrar por pestaña, filtrar por agente, buscar— a Postgres, más una
columna desnormalizada (`Conversacion.esperandoRespuesta`) porque "el último
mensaje es ENTRANTE" no se puede expresar en un `where` de Prisma. **Habría
sido más barato paginar desde el principio.**

## Visibilidad por rol

El backend es la autoridad, no el frontend. Hay tres roles **jerárquicos**:
`AGENTE` (1) < `ADMIN` (2) < `SUPER_ADMIN` (3), definidos en `common/auth/roles.ts`.

```ts
// controller
@Get()
findAll(@Query() query: QueryClienteDto, @CurrentUser() usuario: UsuarioJwt) {
  return this.service.findAll(query, alcanceAgente(usuario));
}
```

`alcanceAgente(usuario)` devuelve el `agenteId` al que hay que limitar la consulta, o `undefined`
si el usuario ve todo — justo lo que esperan los services en su parámetro `soloAgenteId`.

**No escribas la comparación a mano** (`usuario.rol === 'ADMIN' ? undefined : usuario.sub`).
Ese era el patrón anterior y se rompió al añadir SUPER_ADMIN: el guard tenía su tabla de rangos y
el escopado su propia lista, y una quedó desactualizada respecto de la otra — un super admin
terminaba viendo solo *sus* registros. Con `alcanceAgente()` y `tieneAlcanceGlobal()`, añadir un
rol es tocar `RANGO_ROL` y nada más.

Convención: un **AGENTE** ve lo suyo + lo sin asignar (pool); de **ADMIN** para arriba se ve todo.

`@Roles()` también aplica la jerarquía: **`@Roles('ADMIN')` deja pasar al SUPER_ADMIN** sin
enumerarlo endpoint por endpoint. Para restringir algo *solo* al super admin (gestión de usuarios,
importar o eliminar una planilla de comisiones), usa `@Roles('SUPER_ADMIN')`.
Endpoints sin sesión: `@Public()`. Los tres guards globales (Throttler → JWT → Roles) están en
`app.module.ts`.

### La regla de `findAll` se aplica también a `findOne` y a las mutaciones

Escopar solo el listado no basta: si `findOne(id)`/`update(id, …)` no repiten el mismo chequeo,
un agente autenticado puede leer o editar **cualquier** registro por ID con solo conocer el UUID,
sin importar a quién esté asignado — el filtro del listado se vuelve cosmético. Encontrado real en
Clientes, Conversaciones y Leads (ver commits que arreglan "ownership check").

**Leads (2026-08-21) fue el caso más completo**: `findAll`/`resumen` sí escopaban, pero
`updateEstado`/`asignarAgente` no recibían `soloAgenteId` en absoluto — ni el controller lo
pedía ni el service lo aceptaba —, así que cualquier agente podía cambiar el estado o el dueño
de cualquier lead del sistema. `asignarAgente` además escribía `prisma.cliente`/`prisma.conversacion`
directamente en vez de llamar a `ClientesService.update()` (que ya hace esa cascada con
transacción y AuditLog): dos copias del mismo gesto de reasignación, una sin auditoría y que
solo tocaba ESE lead, no los demás leads abiertos del mismo cliente. La regla corta: si dos
módulos hacen "lo mismo" al reasignar un agente, uno de los dos es una copia divergente — el
que no pase por el service del dueño de la tabla es el sospechoso.

```ts
// service — mismo soloAgenteId que findAll, 404 (no 403) para no confirmar que el registro existe
async findOne(id: string, soloAgenteId?: string) {
  const registro = await this.prisma.cliente.findUnique({ where: { id } });
  if (!registro || (soloAgenteId && registro.agenteId && registro.agenteId !== soloAgenteId)) {
    throw new NotFoundException(`Cliente ${id} no encontrado`);
  }
  return registro;
}
```

`update()` debe llamar a este `findOne(id, soloAgenteId)` antes de escribir, no a una versión sin
escopar. Los **agregados** (KPIs, conteos) tienen el mismo hueco si no se filtran por `soloAgenteId`
igual que las consultas de detalle — ver el bug corregido en `kpis.service.ts` (`resumen()` sumaba
conversaciones y leads de toda la clínica al funnel de un agente).

**Excepción a propósito:** las llamadas *internas* entre módulos (ej. `VentasService` llamando a
`ClientesService.findOne(dto.clienteId)` para validar que el cliente existe al registrar una venta)
no pasan `soloAgenteId` — son lógica de negocio legítima, no el agente navegando IDs a mano. El
parámetro es opcional y por defecto `undefined` (sin restricción) exactamente para no romper esos
casos.

## Autenticación: access token corto + refresh token en cookie cross-site

`AuthService.login()` firma dos JWT distintos. El `access_token` viaja en el
header `Authorization` de cada petición y por eso lleva payload mínimo (`sub`,
`email`, `nombre`, `rol`) — la foto del usuario **nunca** va ahí: en base64
llegó a pesar ~2,7 MB y disparaba 431 (Request Header Fields Too Large) en
todo lo autenticado; se devuelve aparte, en el cuerpo de la respuesta. El
`refresh_token` dura 30 días **absolutos desde el login** — no rota ni desliza
con el uso, `refresh()` solo emite un `access_token` nuevo — y viaja en una
cookie `HttpOnly` que arma `opcionesCookieRefresh()` (`auth.controller.ts`).

**Por qué la cookie depende de `NODE_ENV`:** el frontend vive en Vercel y esta
API en otro dominio — es cross-site, no cross-origin del mismo sitio. Con
`SameSite=Lax` el navegador nunca manda la cookie en el POST a `/auth/refresh`
(`Lax` solo la deja viajar en navegaciones de nivel superior), así que el
refresco silencioso queda muerto en producción aunque el endpoint esté bien.
Cross-site exige `SameSite=None`, que a su vez exige `Secure`; en local
(mismo sitio) basta `Lax`.

**`res.cookie()` y `res.clearCookie()` tienen que compartir las mismas
opciones** (`path`, `sameSite`, `secure`): el navegador solo borra una cookie
si esos atributos coinciden byte a byte con los que la crearon. Por eso
`opcionesCookieRefresh()` es una función compartida por login y logout, no dos
literales copiados — si divergen, `logout` responde 204 igual pero la cookie
sigue viva.

**En `refresh()`, solo un problema real de credenciales responde 401.** El
`try` cubre nada más la verificación de la firma; releer al usuario en la
base va fuera de ese `try` (o, si falla por algo que no es "no existe", el
error se relanza tal cual, sin convertirlo en 401). Envolver también la
consulta convertía un parpadeo transitorio de Postgres en "token inválido" —
el interceptor del frontend reacciona a cualquier 401 de `/auth/refresh`
cerrando la sesión, así que una caída de un segundo en la base echaba a
**todas** las agentes conectadas a la vez, en vez de dejar que el fetch se
reintentara con un 500.

**`POST /auth/logout` borra la cookie, no revoca el JWT.** Es sin estado: una
copia que ya salió del navegador (otra pestaña, otro dispositivo) sigue siendo
válida hasta que expira. Esto resuelve el caso real y frecuente en la clínica
—varias agentes comparten equipo, y sin logout el `refresh_token` de la
anterior seguía siendo canjeable— no una revocación de verdad; eso exigiría
guardar algo en la base (ej. `sesionesValidasDesde` contra el `iat` del token)
y no existe todavía. `@Public()` en los tres endpoints (`login`, `refresh`,
`logout`) es intencional: quien cierra sesión puede tener el `access_token`
ya vencido, y no poder salir por eso sería absurdo.

## Llamadas externas lentas: nunca bloquear la respuesta al cliente

Si un endpoint dispara una llamada a un servicio de terceros que no determina
el resultado que ve el usuario (ej. reenviar un mensaje por WhatsApp Cloud API
tras ya haberlo guardado en la base), **no la esperes (`await`) antes de
responder**. El agente no debería pagar con latencia el round-trip a un
tercero (Meta: 300-900ms típico) por algo que ya ocurrió (el mensaje ya está
guardado). Ver `enviarMensaje()`/`enviarPorWhatsApp()` en
`conversaciones.service.ts`: la llamada a Meta se dispara con `void this.algo(...)`,
nunca con `await`, y sus errores solo se registran con el logger — nunca deben
poder tumbar ni demorar la respuesta HTTP.

```ts
// ✅ el agente ve su mensaje enviado en cuanto se guarda en la base
const mensaje = await this.prisma.mensaje.create({ ... });
void this.enviarPorWhatsApp(telefono, contenido); // sin await, a propósito
return mensaje;
```

**Esto no contradice la regla — distingue red de local.** Antes de ese
`await this.prisma.mensaje.create(...)`, `enviarMensaje()` sí espera
`verificarVentana24h()`: una consulta LOCAL a Postgres (no de red a Meta) que
confirma que el último mensaje ENTRANTE del paciente tiene menos de 24h — la
ventana de servicio al cliente (CSW) de WhatsApp. Fuera de esa ventana Meta
rechaza igual el texto libre, pero tarda un webhook de `statuses` en
avisarlo; adelantar el rechazo con un `BadRequestException` local le ahorra
al agente esperar un tick que nunca llega. Lo que la regla prohíbe bloquear
es la llamada de RED a un tercero, no cualquier `await`. (La ventana de 72h
de Free Entry Point por anuncio es independiente y no entra en este chequeo:
solo habilita plantillas sin costo, nunca texto libre.) Ver
`fueraDeVentana24h` en el frontend — es el mismo cálculo duplicado a
propósito para pintarlo en la UI antes de que la agente escriba; si se toca
uno, se toca el otro.

## Tiempo real: push por WebSocket en vez de que el frontend haga polling

Cuando una vista necesita reflejar cambios que otro actor produce (mensajes
entrantes de un webhook, otro agente escribiendo) el patrón es un
`@WebSocketGateway` liviano que **solo avisa que algo cambió**, nunca lleva
los datos en el payload — el dato real se sigue sirviendo por REST, que es
donde vive el escopado por rol. Ver `ConversacionesGateway`
(`conversaciones.gateway.ts`): se autentica el handshake con el mismo
`JwtService` que usa `JwtAuthGuard`, y `emitirActividad(conversacionId)` se
llama tras cada `mensaje.create` (tanto en `enviarMensaje` como en
`procesarEntrante` del webhook). Requiere `app.useWebSocketAdapter(new IoAdapter(app))`
en `main.ts` — sin esto el gateway no tiene con qué servir las conexiones.

**Un mensaje entrante debe bumpear `conversacion.updatedAt`**, no solo crear
el `Mensaje`: el inbox ordena por `updatedAt desc`, así que sin este update
un chat con un mensaje nuevo del paciente no sube al tope de la lista hasta
que un agente responda. Ambos writes van en la misma `$transaction`.

## Estados de entrega estilo WhatsApp (ticks): usa lo que el proveedor ya manda

Antes de construir un mecanismo propio de "¿llegó el mensaje?", revisa si el
proveedor externo ya lo notifica — WhatsApp Cloud API manda un array
`statuses` (sent/delivered/read/failed) en el mismo webhook que usa para
mensajes entrantes, correlacionado por el id que la propia API devolvió al
enviar. Ver `Mensaje.estadoEnvio` + `procesarEstadoMensaje()` en
`conversaciones.service.ts` y el manejo de `cambio.value?.statuses` en
`whatsapp-webhook.controller.ts`: no hay polling ni verificación activa,
solo escuchar lo que Meta ya envía. El estado nunca retrocede (un 'delivered'
tardío no debe pisar un 'read' que ya llegó) — se compara antes de escribir.

## Migraciones: si `--create-only` trae cambios que no pediste, es drift

Antes de aplicar una migración nueva, mira el SQL generado. Si aparece algo
que no tiene que ver con tu cambio (índices, columnas de otro módulo), el
`schema.prisma` del repo ya iba adelantado a la última migración committeada
— alguien tocó el schema sin generar migración (`db push`, edición a mano, o
una sesión paralela). No lo mezcles con tu cambio: aísla el schema al estado
previo (`git stash` de `schema.prisma`), genera una migración solo para ese
drift, aplícala, y recién ahí restaura tu cambio y genera la migración real.
Mezclarlo todo en un commit hace imposible saber después qué migración hizo
qué. Pasó una vez con 5 índices compuestos que existían en `schema.prisma`
pero nunca se habían migrado — ver `fix_indices_faltantes`.

## Get-or-create bajo concurrencia: `upsert` NO basta, usa catch-P2002

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
catch del P2002**, y el `meta.target` del error dice qué columna chocó.

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

## Rate-limit tras un proxy inverso: `trust proxy` o el límite es global

El `ThrottlerGuard` (y el `@Throttle` del login) filtran por `req.ip`. Detrás
de Apache/nginx en loopback, sin configurar `trust proxy` Express ve siempre
`127.0.0.1` → **todas** las peticiones caen en el mismo bucket y el límite
"por IP" se comparte entre todos los usuarios (5 logins fallidos y quedan
todos bloqueados). En `main.ts`: `app.set('trust proxy', 'loopback')` — toma
la IP real del `X-Forwarded-For` que agrega el proxy, y `loopback` (no `true`)
evita que un cliente externo falsifique su IP. Los webhooks de proveedores
(Meta) van con `@SkipThrottle()`: sus ráfagas y reintentos no deben chocar
contra el límite —tras varios 429 Meta desactiva la suscripción— y son
idempotentes de todos modos.

## Un webhook `@Public()` se sostiene con la FIRMA, no con el rate-limit

`@SkipThrottle()` + `@Public()` + escritura en base es la combinación más peligrosa del
backend, y es exactamente lo que necesita un webhook. Lo único que separa ese endpoint de
internet es verificar la firma del proveedor. Meta firma cada POST con HMAC-SHA256 del
cuerpo en `X-Hub-Signature-256`; sin comprobarlo, cualquiera que conociera la URL —pública
por necesidad— podía dar de alta pacientes y leads sin límite e inyectar mensajes falsos en
el hilo de cualquier paciente. **`META_VERIFY_TOKEN` no cubre esto**: solo protege el GET
de alta de la suscripción, no los POST posteriores.

Ver `MetaSignatureGuard` (`common/guards/`). Está en `common/` y no en un módulo **porque Meta
firma todos sus webhooks igual**: WhatsApp Cloud API, Lead Ads, Messenger y los DM de Instagram
comparten cabecera, algoritmo y App Secret. Todo webhook de Meta que se añada cuelga de este
guard — un `@UseGuards(MetaSignatureGuard)` sobre el POST y ya. Hoy lo usan
`webhooks/whatsapp` y `webhooks/meta` (Lead Ads). Tres cosas que no son
obvias:

- Se firma el cuerpo **crudo**, no el JSON reserializado — requiere
  `NestFactory.create(AppModule, { rawBody: true })` en `main.ts` y `RawBodyRequest<Request>`.
- `timingSafeEqual` **lanza** si los buffers difieren en longitud, y `Buffer.from(hex,'hex')`
  trunca en silencio ante caracteres inválidos: compara longitudes antes, o una firma
  malformada es un 500 en vez de un 403.
- **Falla cerrado**: sin `META_APP_SECRET` se rechaza todo. Un modo "sin secreto, dejar
  pasar" deja el agujero abierto para siempre. El precio es que la variable es obligatoria
  para recibir mensajes.

Misma trampa en la verificación GET: `token === esperado` con `esperado` sin configurar
compara `undefined === undefined` y da por buena cualquier petición. Comprueba que la
variable exista *antes* de comparar.

**Esto ya no depende de que alguien se acuerde.** `npm run check:skills` recorre todos los
controladores bajo `webhooks/` y falla el build si un `@Post()` no lleva
`@UseGuards(MetaSignatureGuard)` o no responde `@HttpCode(200)`, y si `.env.example` deja de
documentar `META_APP_SECRET`. Se automatizó porque este agujero no reaparece por descuido, sino
por un webhook **nuevo** escrito meses después copiando el patrón de otro: cuando había dos
(`webhooks/whatsapp` y `webhooks/meta`), los dos estaban abiertos.

## Procesar lotes de un webhook: un try/catch POR ELEMENTO

Un webhook responde 200 antes de procesar (Meta corta a los 3s), así que **lo que se pierda
procesando no se reintenta nunca**. Con un solo try/catch envolviendo el bucle, una
excepción en el mensaje 2 de 5 se lleva los 3 restantes y todos los `statuses` de ese
cambio: mensajes de pacientes desapareciendo sin traza. Cada elemento va en su propio
try/catch, y el catch registra el id para poder rastrearlo. Ver `procesarWebhook()` en
`whatsapp-webhook.controller.ts`.

Corolario para probarlo: si el handler dispara el procesamiento con `void`, expón el método
asíncrono (no `private`) para que la prueba pueda esperar su promesa.

## Barridos de fondo: concurrencia ACOTADA, nunca `Promise.all` sobre el lote

Un `setInterval` que despacha notificaciones, correos o llamadas externas es la
tentación clásica de cambiar el `for await` por un `Promise.all(lote.map(…))`
"para que vaya más rápido". En este servidor eso es una regresión, no una
optimización:

- el VPS tiene **un núcleo y 1,7 GB**, y el pool de Prisma se dimensiona solo a
  `núcleos × 2 + 1` → **tres conexiones**;
- el barrido comparte ese pool con las peticiones de las agentes. Cincuenta
  `update()` a la vez contra tres conexiones, con `pool_timeout` de 10 s, no
  ralentizan el barrido: hacen fallar el chat que alguien estaba abriendo;
- cada push firma un JWT VAPID (ECDSA), que es CPU en un core que no sobra.

El patrón es tandas pequeñas, con el try/catch **por elemento** de la sección
anterior dentro de cada una:

```ts
for (let i = 0; i < pendientes.length; i += CONCURRENCIA) {
  await Promise.all(pendientes.slice(i, i + CONCURRENCIA).map(x => this.notificarUno(x, ahora)));
}
```

Ver `barrerRecordatoriosPendientes()` en `actividades.service.ts` (CONCURRENCIA 5).
Dos corolarios que costaron lo mismo:

- **`Promise.allSettled` sobre funciones que ya tienen try/catch no aísla nada**
  — ninguna promesa rechaza. Dice una intención que el catch ya cumple, y de paso
  disimula que la concurrencia no está acotada.
- **Un `take: N` en la consulta del barrido es un tope, y un tope que se alcanza
  significa avisos sin mandar.** Loguéalo, o el día que pase se descubre porque
  una agente no recibió el suyo.

## Un campo de DTO con valores cerrados lleva `@IsIn`/`@IsEnum`, no `@IsString`

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

## Consultas: agregar en SQL, no en JS

Prohibido traer filas para contarlas o sumarlas en memoria:

```ts
// ❌ carga todas las ventas del cliente
const ventas = await this.prisma.venta.findMany({ where: { clienteId } });
const total = ventas.reduce((s, v) => s + Number(v.monto), 0);

// ✅ la base devuelve solo el número
const { _sum, _count } = await this.prisma.venta.aggregate({
  where: { clienteId, estado: 'GANADA' },
  _sum: { monto: true },
  _count: true,
});
```

Usa `$transaction([...])` para lanzar en paralelo las consultas independientes (típico: página + total).

## Archivos subidos: `ArchivoSubido`, no `any`

Los endpoints que reciben un archivo (importar planilla de comisiones, recursos de memoria del
agente) usan `FileInterceptor` de Multer. Como el `@UploadedFile()` no viene tipado y no vale la
pena instalar `@types/multer` por cuatro propiedades, existe la interfaz `ArchivoSubido`
(`modules/memoria-agente/archivo-subido.ts`): `originalname`, `mimetype`, `size`, `buffer`.

```ts
@Post('importar')
@Roles('SUPER_ADMIN')
@UseInterceptors(FileInterceptor('archivo'))
importar(@UploadedFile() archivo: ArchivoSubido, @CurrentUser() usuario: UsuarioJwt) { … }
```

Valida siempre `mimetype` y `size` en el service antes de parsear: el `ValidationPipe` no ve el
archivo, así que un DTO no te protege aquí.

## Auditoría

Toda mutación crítica (ventas, comisiones, clientes) llama a `AuditService.registrar()`.
Nunca debe tumbar la operación de negocio: ya está envuelto en try/catch.

## Migraciones

Al cambiar `schema.prisma`, **genera y commitea la migración** — si no, quien clone el repo
tendrá una base desincronizada:

```bash
npx prisma migrate dev --name descripcion_corta --create-only   # revisar el SQL
npx prisma migrate deploy                                        # aplicar
```

Con datos reales en la base, revisa siempre el SQL antes de aplicarlo (`--create-only`).

## Seguridad ya montada

- `helmet()` + `compression()` en `main.ts`
- CORS restringido a `CORS_ORIGINS` (env), no abierto
- `ValidationPipe` con `whitelist` (descarta campos no declarados) — **sin** `forbidNonWhitelisted`:
  se probó y se quitó a propósito, porque rechaza con 400 los webhooks de Meta (traen decenas de
  campos que no modelamos) y tras varios 400 Meta desactiva la suscripción. `whitelist` solo ya
  protege contra que un cliente cuele campos inesperados; no lo reactives sin filtrar antes por ruta.

  **Consecuencia que muerde:** `whitelist` descarta toda propiedad **sin decorador de
  `class-validator`**. Un DTO declarado sin decoradores no llega incompleto al service —
  llega `{}`, siempre, sin excepción y sin una línea en el log. Pasó con `SuscribirPushDto`
  (2026-08-10): el endpoint devolvía 200, guardaba cero y las notificaciones jamás
  funcionaron. En objetos anidados hacen falta además `@ValidateNested()` + `@Type(() => Clase)`,
  o el hijo se vacía igual. `check:skills` falla si encuentra un DTO sin ningún decorador.
- Rate limit 120/min general; **login 5/min** contra fuerza bruta — **por IP real**
  gracias a `trust proxy` (ver sección de rate-limit arriba); el webhook de WhatsApp
  va con `@SkipThrottle()`
- HTTP/2 en el vhost de Apache (`Protocols h2 http/1.1`); WebSocket proxyado en `/socket.io/`
- Contraseñas con bcrypt; el JWT nunca lleva datos sensibles

## Antes de dar por terminado

- `npx nest build` sin errores (**no uses el navegador en este proyecto**).
- Probar con `curl` contra la base local (puerto 5433) si tocaste un endpoint.
- Si tocaste `schema.prisma`, la migración está generada y commiteada.
- Ningún `any`, ningún `take` fijo nuevo, ningún acceso a la tabla de otro dominio,
  ninguna comparación de rol a mano (usa `alcanceAgente` / `cubreRol`).

## Mantenimiento

`npm run check:skills` contrasta los datos de este archivo con el código: rutas citadas, los
roles de `@Roles(...)` contra el `enum Rol` de `schema.prisma`, y los helpers de
`common/auth/roles.ts`. Va encadenado a `npm run build`.

Si añades un rol al enum y este skill no lo menciona, el check falla a propósito: esa es
exactamente la desincronización que dejó el escopado por rol enseñando el patrón viejo.
Verifica **datos, no criterio** — las decisiones y cicatrices de arriba se actualizan a mano.
