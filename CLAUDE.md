# CRM Clínica Montalvo — backend

API del CRM de una clínica estética en Bolivia. NestJS 10 + Prisma 5 + PostgreSQL.
Lo usan a diario agentes de venta reales sobre datos de pacientes reales: **no hay
entorno de staging**. Un error aquí lo ve una paciente.

## Dónde está todo

Dos repositorios hermanos bajo el mismo directorio padre:

```
CRM/
├── backend-crm-montalvo/    ← estás aquí
└── frontend-crm-montalvo/   ← Angular 21, PWA, desplegado en Vercel
```

`CRM_MANIFESTO.md` vive en el repo del **frontend** pero gobierna los dos: es la
referencia de arquitectura que citan los skills.

## Antes de escribir código

Carga el skill `crm-backend-module`. No es opcional ni es para cambios grandes:
cubre paginación, escopado por rol, concurrencia en webhooks, firma de Meta y
migraciones, y casi todo cambio toca al menos uno de esos. Su descripción explica
cuándo aplica.

Ese skill documenta **cicatrices**, no teoría: cada regla está ahí porque algo se
rompió en producción. Si una te parece excesiva, probablemente estás a punto de
reintroducir el bug que la motivó.

## Comandos

```bash
npm run build          # check:skills + nest build — la compuerta real
npm test               # unitarias (rápidas, sin base)
npm run test:integracion:preparar && npm run test:integracion   # necesitan Postgres
npx prisma migrate dev --name <nombre> --create-only            # revisar el SQL antes
```

La base local escucha en el **puerto 5433**, no en el 5432.

**No uses el navegador en este proyecto.** Para probar un endpoint, `curl` contra
la base local.

## Invariantes

- **`npm run build` es la verdad.** Encadena `check:skills`, que compara los skills
  con el código y falla si mienten. Si te contradice, el equivocado es el skill:
  corrígelo en el mismo commit.
- **Ningún `any`.** Tampoco `catch (e: any)` — usa `unknown` y estrecha.
- **Ningún módulo toca la tabla de otro dominio.** Se llama a su service.
- **Todo listado se pagina.** Hay 15.000+ pacientes.
- **Nunca compares roles a mano** (`rol === 'ADMIN'`): usa `alcanceAgente()` /
  `cubreRol()` de `common/auth/roles.ts`. La jerarquía es `AGENTE < ADMIN < SUPER_ADMIN`.
- **Si tocas `schema.prisma`, la migración se genera y se commitea.** Sin eso, quien
  clone el repo queda con la base desincronizada.

## Caché

Una sola implementación: `common/cache/cache-memoria.ts` (TTL + tope de entradas +
deduplicación de cargas en vuelo). **No escribas otro `Map` con `expiresAt` a mano** —
había tres y una de ellas no borraba nunca, que es como se llegó a la fuga de KPIs.

Vive en el proceso, no es distribuida. Si algún día el backend escala a varias
instancias, ese archivo es el único sitio donde cambiar a Redis.

## Trampas conocidas

- **Comisiones: el Excel importado viene en DÓLARES**, y se convierte a Bs con el
  tipo de cambio al final. Asumir bolivianos en la base rompe el cálculo de forma
  silenciosa — ya pasó. El razonamiento completo está en la cabecera de
  `calculo-comisiones.service.ts`; léelo antes de tocar ese módulo.
- **La UI muestra Bs (es-BO)**; el dólar es interno al cálculo de comisiones.
- **`prisma/schema.prisma` es la fuente de verdad de los enums del frontend**, que
  los genera desde aquí. Añadir un valor a un enum obliga a correr `npm run sync:tipos`
  en el otro repo o su build falla.
