# Visibilidad por rol

> Parte de la skill `crm-backend-module`: lee antes su [índice](../SKILL.md).

El backend es la autoridad, no el frontend. La jerarquía vive en
`common/auth/roles.ts`: `RECEPCION` y `ASISTENTE` (0) < `AGENTE` (1) <
`ADMIN` (2) < `SUPER_ADMIN` (3). El rango 0 es el **suelo**, así que
`@Roles('RECEPCION')` no restringe a recepción: significa «cualquier sesión».

### Rango no es capacidad: `ROLES_OPERATIVOS`

`RECEPCION` y `ASISTENTE` comparten rango porque ninguno tiene alcance
comercial: atienden los chats de **sus líneas**, no agendan sobre leads, no
acceden a líneas comerciales y localizan pacientes por conversación accesible
en vez de por cartera. Eso **no** se escribe `rol === 'RECEPCION'`.

```ts
import { esRolOperativo, ROLES_OPERATIVOS } from '../../common/auth/roles';

if (esRolOperativo(usuario.rol) && dto.leadId) throw new BadRequestException(…);
// en un filtro Prisma:
{ usuario: { rol: { in: [...ROLES_OPERATIVOS] } } }
```

Al añadir `ASISTENTE` (2026-09-22) había **seis** comparaciones sueltas con
`'RECEPCION'` —tres en actividades, una en usuarios, una en líneas y una dentro
de un `where` de Prisma en `acceso-conversacion.ts`—. Cada una era una tabla de
roles paralela esperando a desincronizarse, igual que pasó al añadir
SUPER_ADMIN. Ahora la lista está en un sitio: añadir un rol operativo es tocar
`ROLES_OPERATIVOS` y nada más. Si escribes el nombre de un rol a mano fuera de
`roles.ts` o de un `@Roles()`, estás reintroduciendo el bug.

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
transacción y AuditLog; hoy se llama con su nombre, `ClientesService.reasignarAgente()`):
dos copias del mismo gesto de reasignación, una sin auditoría y que
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

**Delegar en otro módulo no elimina el alcance del comando HTTP.** Por ejemplo,
`VentasService.create()` transmite `soloAgenteId` a `ClientesService.findOne()`:
validar solo existencia permitía registrar ventas sobre pacientes ajenos (F04).
Lo mismo se aplica a un cliente existente localizado por teléfono desde Leads.
El parámetro sigue siendo opcional para operaciones internas de confianza y
usuarios con alcance global; no debe omitirse por el mero hecho de cruzar un service.
