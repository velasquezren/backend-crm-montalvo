---
name: crm-backend-module
description: Patrón obligatorio de los módulos NestJS de este CRM — límites de dominio, paginación, validación con DTOs, jerarquía de roles, concurrencia, webhooks y auditoría. Úsalo SIEMPRE al crear o modificar cualquier módulo bajo src/modules/, al añadir o tocar un endpoint, al escribir una consulta de Prisma, al cambiar schema.prisma o generar una migración, y al integrar un servicio externo (WhatsApp/Meta) — incluso para cambios que suenan pequeños ("agrega un campo", "un endpoint de listado").
---

# Patrón de módulo del backend

NestJS 11 (Express 5) + Prisma 7 + PostgreSQL. Reglas base: `CRM_MANIFESTO.md` (repo del frontend) §1.1.

## Consulta por tarea

Leer Reglas de oro y tipos de Prisma; después solo las secciones del cambio:
DTO/listado → Paginación y validación; acceso → Visibilidad y Autenticación;
mensajería → Atención humana, Estados de entrega, Webhooks y Líneas;
persistencia → Migraciones y concurrencia; IA → Asistente. El mapa de módulos
está en [PANORAMA](../../../docs/PANORAMA.md). No cargar finanzas o despliegue
para cambiar un endpoint de otro dominio.

## Referencias por tema (carga solo la que toque)

Cada archivo es una sección completa de esta skill; no hace falta leerlas todas.

- [Paginación (obligatoria en todo listado)](references/paginacion.md) — Nunca devuelvas una tabla entera ni uses take fijo: hay 15.000+ clientes.
- [Promociones y directorio médico (2026-10-05)](references/promociones-y-directorio-medico.md) — Diseño en [promociones y directorio](../../../docs/promociones-y-directorio.md). El CRM es la
- [Categoría del paciente: valor, no actividad (2026-09-30)](references/categoria-del-paciente-valor-no-actividad.md) — Cliente.categoria es lo que lee todo el CRM (inbox, fichas, filtros, el índice). Su
- [Visibilidad por rol](references/visibilidad-por-rol.md) — El backend es la autoridad, no el frontend. La jerarquía vive en
- [Autenticación: sesión revocable + refresh token en cookie cross-site](references/autenticacion-sesion-revocable-refresh-token-en.md) — AuthService.login() firma dos JWT distintos. El access_token viaja en el
- [Llamadas externas lentas: nunca bloquear la respuesta al cliente](references/llamadas-externas-lentas-nunca-bloquear-la.md) — Si un endpoint dispara una llamada a un servicio de terceros que no determina
- [Tiempo real: push por WebSocket en vez de que el frontend haga polling](references/tiempo-real-push-por-websocket-en.md) — Cuando una vista necesita reflejar cambios que otro actor produce (mensajes
- [Estados de entrega estilo WhatsApp (ticks): usa lo que el proveedor ya manda](references/estados-de-entrega-estilo-whatsapp-usa.md) — Antes de construir un mecanismo propio de "¿llegó el mensaje?", revisa si el
- [Migraciones: si `--create-only` trae cambios que no pediste, es drift](references/migraciones-si-create-only-trae-cambios.md) — Antes de aplicar una migración nueva, mira el SQL generado. Si aparece algo
- [Get-or-create bajo concurrencia: `upsert` NO basta, usa catch-P2002](references/get-or-create-bajo-concurrencia-upsert.md) — Cualquier endpoint que reciba tráfico concurrente para la misma entidad
- [Rate-limit tras un proxy inverso: `trust proxy` o el límite es global](references/rate-limit-tras-un-proxy-inverso.md) — El ThrottlerGuard (y el @Throttle del login) filtran por req.ip. Detrás
- [Un webhook `@Public()` se sostiene con la FIRMA, no con el rate-limit](references/un-webhook-public-se-sostiene-con.md) — @SinLimite() + @Public() + escritura en base es la combinación más peligrosa del
- [Procesar lotes de un webhook: un try/catch POR ELEMENTO](references/procesar-lotes-de-un-webhook-un.md) — El webhook de WhatsApp espera la persistencia antes de confirmar 200.
- [Una bandera se prueba ENCENDIDA, o la suite certifica lo que no corre](references/una-bandera-se-prueba-encendida-o.md) — Toda bandera de este backend parte apagada y se enciende en producción
- [Barridos de fondo: concurrencia ACOTADA, nunca `Promise.all` sobre el lote](references/barridos-de-fondo-concurrencia-acotada-nunca.md) — Un setInterval que despacha notificaciones, correos o llamadas externas es la
- [Un campo de DTO con valores cerrados lleva `@IsIn`/`@IsEnum`, no `@IsString`](references/un-campo-de-dto-con-valores.md) — @IsString() en un campo que el service compara contra literales
- [Consultas: agregar en SQL, no en JS](references/consultas-agregar-en-sql-no-en.md) — Prohibido traer filas para contarlas o sumarlas en memoria:
- [Archivos subidos: `ArchivoSubido`, no `any`](references/archivos-subidos-archivosubido-no-any.md) — Los endpoints que reciben un archivo (importar planilla de comisiones, recursos de memoria del
- [Auditoría](references/auditoria.md) — Toda mutación crítica (ventas, comisiones, clientes) llama a AuditService.registrar().
- [Migraciones](references/migraciones.md) — Al cambiar schema.prisma, genera y commitea la migración — si no, quien clone el repo
- [Seguridad ya montada](references/seguridad-ya-montada.md) — se probó y se quitó a propósito, porque rechaza con 400 los webhooks de Meta (traen decenas de
- [Líneas de WhatsApp, recepción y asistente (2026-09-13 · rol ASISTENTE 2026-09-22)](references/lineas-de-whatsapp-recepcion-y-asistente.md) — Entregar resultados es una capacidad, no un rango ni solo una membresía:

## Reglas de oro

1. **Un módulo nunca escribe la base de otro dominio.** Si Ventas necesita recategorizar un cliente,
   llama a `ClientesService.actualizarCategoria()`, jamás a `prisma.cliente` directamente.
   Leer para agregar (KPIs, Servicios) sí vale. Las escrituras cruzadas que existen hoy, con su
   motivo, están en PANORAMA («Quién escribe cada tabla»): una nueva se apunta ahí.
2. **Toda entrada externa se valida con un DTO** antes de llegar a la lógica de negocio.
   Nunca `@Body('campo') x: any` — eso salta el `ValidationPipe` por completo.
3. **`schema.prisma` define persistencia y enums del CRM.** No dupliques sus
   enums a mano. DTO y modelos de respuesta describen contratos de API distintos;
   MySQL de agenda y Resultados conservan contratos propios.

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

## Antes de dar por terminado

- `npm run build` sin errores (**no uses el navegador en este proyecto**). Incluye
  `npm run lint` (ESLint con tipos, `eslint.config.mjs`): promesas sin esperar,
  `switch` incompletos sobre un enum, `any`, `==`. Una promesa que se lanza y no
  se espera va por `enSegundoPlano()` o con `void` explícito; nada de desactivar
  la regla.
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
