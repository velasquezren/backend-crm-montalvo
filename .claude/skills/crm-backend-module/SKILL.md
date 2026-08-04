---
name: crm-backend-module
description: Patrón obligatorio de los módulos NestJS de este CRM — límites de dominio, paginación, validación con DTOs, jerarquía de roles, concurrencia, webhooks y auditoría. Úsalo SIEMPRE al crear o modificar cualquier módulo bajo src/modules/, al añadir o tocar un endpoint, al escribir una consulta de Prisma, al cambiar schema.prisma o generar una migración, y al integrar un servicio externo (WhatsApp/Meta) — incluso para cambios que suenan pequeños ("agrega un campo", "un endpoint de listado").
---

# Patrón de módulo del backend

NestJS 10 + Prisma 5 + PostgreSQL. Reglas base: `CRM_MANIFESTO.md` (repo del frontend) §1.1.

## Reglas de oro

1. **Un módulo nunca toca la base de otro dominio.** Si Ventas necesita recategorizar un cliente,
   llama a `ClientesService.actualizarCategoria()`, jamás a `prisma.cliente` directamente.
2. **Toda entrada externa se valida con un DTO** antes de llegar a la lógica de negocio.
   Nunca `@Body('campo') x: any` — eso salta el `ValidationPipe` por completo.
3. **`schema.prisma` es la única fuente de verdad del modelo.** No dupliques tipos a mano.

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

**Excepción documentada:** el inbox de conversaciones no se pagina (la UI filtra por
pestañas sobre el conjunto cargado); se acota a las 100 más recientes.

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
Clientes y Conversaciones (ver commits que arreglan "ownership check").

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

## Procesar lotes de un webhook: un try/catch POR ELEMENTO

Un webhook responde 200 antes de procesar (Meta corta a los 3s), así que **lo que se pierda
procesando no se reintenta nunca**. Con un solo try/catch envolviendo el bucle, una
excepción en el mensaje 2 de 5 se lleva los 3 restantes y todos los `statuses` de ese
cambio: mensajes de pacientes desapareciendo sin traza. Cada elemento va en su propio
try/catch, y el catch registra el id para poder rastrearlo. Ver `procesarWebhook()` en
`whatsapp-webhook.controller.ts`.

Corolario para probarlo: si el handler dispara el procesamiento con `void`, expón el método
asíncrono (no `private`) para que la prueba pueda esperar su promesa.

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
