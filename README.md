# CRM Clínica Montalvo — backend

API NestJS + Prisma + PostgreSQL. El frontend Angular vive en el repo hermano
`frontend-crm-montalvo`; ambos repos deben clonarse bajo el mismo directorio padre.

- Trabajo de agentes: [CLAUDE.md](CLAUDE.md).
- Buscar un módulo o procedimiento: [índice documental](docs/README.md).
- Continuar trabajo: [estado breve](docs/ESTADO_ACTUAL.md).

## Instalación y arranque local (Linux / macOS)

Clonar ambos repositorios como hermanos. Entorno comprobado: Node 22.23.2 y
npm 10.9.8; usar Node 22 >= 22.12 (los `engines` de dependencias son más
restrictivos que el `>=22` del proyecto). PostgreSQL 16 para las integraciones.

```bash
npm ci
cp .env.example .env   # solo si todavía no existe; completar variables locales
npm run build
npm test -- --runInBand
npm run test:build
```

`npm ci` genera Prisma sin necesitar una base ni `.env`. Para arrancar la API,
configurar `DATABASE_URL` hacia una base de desarrollo, `JWT_SECRET`, `PORT=3001`
y `CORS_ORIGINS=http://localhost:4200`. Una base nueva necesita las migraciones
**ya versionadas** (`npx prisma migrate deploy`) antes de `npm run start:dev`.
No se requiere un dump ni una base particular de esta máquina. No usar los
scripts históricos `scripts/seed-admin.js` / `scripts/import-pacientes.js`:
aún importan el cliente anterior a Prisma 7; mantenimiento pendiente.

Meta, R2 y VAPID son opcionales para levantar/verificar localmente; sin sus
credenciales las integraciones externas quedan deshabilitadas. La plantilla
`.env.example` contiene sus nombres, nunca credenciales reales. Los tests
sintéticos usan exclusivamente `crm_test` local; la receta descartable está en
[crm-backend-arquitectura §8](.claude/skills/crm-backend-arquitectura/SKILL.md).
`test:integracion:preparar` **borra crm_test**: solo ejecutarlo sobre el servidor
descartable propio, nunca sobre una base con datos que se quieran conservar.

## Comandos

```bash
npm run build          # check:skills + check:flows + nest build + check:build — la compuerta real
npm run test:build     # verificador + builds limpio/consecutivo y fallo sin emisión, sin base
npm test               # unitarias (rápidas, sin base)
npm run test:integracion:preparar && npm run test:integracion   # necesitan Postgres
npx prisma migrate dev --name <nombre> --create-only            # revisar el SQL antes
```

Las recetas de integración usan **5433** y `crm_test`; el puerto de desarrollo
lo fija `DATABASE_URL`. No asumir que una base existente es descartable.

El build guarda su `tsBuildInfoFile` dentro de `dist`: `deleteOutDir` debe
eliminar la caché junto con los artefactos. Con la caché fuera, un segundo
build podía terminar con exit 0 sin reemitir `dist/main.js`. `check:build`
rechaza un entrypoint ausente, vacío o que no sea archivo. No sustituye la
prueba de arranque/DI ni los curls post-despliegue. Al cambiar el compilador,
verificar un build limpio y otro consecutivo, y arrancar el artefacto real.

`test:build` compila una copia temporal del código actual usando las dependencias
ya instaladas (incluido el cliente Prisma generado). No copia `.env`, `dist` ni
cachés previas. Comprueba también que `npm run build` falla si TypeScript termina
sin errores pero no emite JavaScript (`noEmit`). No arranca la aplicación ni usa
PostgreSQL; el arranque/DI se comprueba aparte con `node dist/main.js`, una base
temporal y `NODE_ENV=test` para desactivar los trabajos periódicos. Verificar
`GET /health` → 200, login vacío con JSON → 400 y periodos sin token → 401.

**No uses el navegador en este proyecto.** Para probar un endpoint, `curl` contra
la base local.


## Qué demuestra una comprobación

`build` comprueba reglas automáticas y compilación, no producción ni todos los
contratos. `check:tests` comprueba los tipos de los tests. Las suites unitarias
no sustituyen PostgreSQL/MySQL real ni pruebas autorizadas con proveedores.
Los casos que requieren Excel privados pueden omitir sus aserciones: declarar
esa limitación aunque el runner cuente el caso como aprobado.

Para operar el VPS, conservar el procedimiento completo de
[despliegue](.claude/skills/crm-backend-arquitectura/SKILL.md#4-cómo-desplegar):
respaldo verificado, migración revisada, build, reinicio y salud/autorización.
No ejecutar ese procedimiento como parte de la preparación local.
