---
name: crm-backend-module
description: Patrón obligatorio de los módulos NestJS de este CRM — límites de dominio, paginación, validación con DTOs, roles y auditoría. Úsalo al crear o modificar cualquier módulo bajo src/modules/, al añadir un endpoint, al tocar el schema de Prisma o al escribir una consulta.
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

El backend es la autoridad, no el frontend:

```ts
// controller
@Get()
findAll(@Query() query: QueryClienteDto, @CurrentUser() usuario: UsuarioJwt) {
  const soloAgenteId = usuario.rol === 'ADMIN' ? undefined : usuario.sub;
  return this.service.findAll(query, soloAgenteId);
}
```

Convención: un **AGENTE** ve lo suyo + lo sin asignar (pool); un **ADMIN** ve todo.
Endpoints exclusivos de admin: `@Roles('ADMIN')`. Endpoints sin sesión: `@Public()`.
Los tres guards globales (Throttler → JWT → Roles) están en `app.module.ts`.

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
- Rate limit global 120/min; **login 5/min** contra fuerza bruta
- Contraseñas con bcrypt; el JWT nunca lleva datos sensibles

## Antes de dar por terminado

- `npx nest build` sin errores (**no uses el navegador en este proyecto**).
- Probar con `curl` contra la base local (puerto 5433) si tocaste un endpoint.
- Ningún `any`, ningún `take` fijo nuevo, ningún acceso a la tabla de otro dominio.
