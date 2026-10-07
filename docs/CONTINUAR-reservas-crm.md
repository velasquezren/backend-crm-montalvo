# Continuar: pantalla «Reservas» del CRM — solo falta desplegar (7/10/2026)

El código está **terminado y probado** en las ramas `reservas-crm` del backend y del
frontend (no en `main`). Lo que queda es el despliegue, en este orden. Al terminarlo,
borrar este archivo; el resumen ya está en `ESTADO_ACTUAL.md`.

```bash
cd backend-crm-montalvo && git fetch && git switch reservas-crm
cd ../frontend-crm-montalvo && git fetch && git switch reservas-crm
```

## Qué hay en las ramas

| Pieza | Dónde |
| --- | --- |
| `GET /agenda/reservas`, `/conversacion/:id`, `/:id/comprobante` | backend `src/modules/agenda/agenda-reservas-crm.{controller,service}.ts` |
| Cuenta `crm_agenda_consulta` (`AgendaConsultaClient`, bandera `AGENDA_VPS_CONSULTA`) | backend `agenda-consulta.client.ts`, `.env.example` |
| Pantalla `/reservas` (recepción, asistencia, ADMIN+) | frontend `features/reservas/` |
| «Próximas reservas» en la ficha del chat | frontend `features/conversaciones/components/reservas-paciente/` |

Pruebas: backend 904 unitarias + 21 MySQL (`bash scripts/probar-agenda-mysql.sh`, con docker,
o sin él con `AGENDA_MYSQL_BASEDIR=<MySQL 8.0.44 descomprimido>`); frontend 639.

## Despliegue (orden obligatorio)

1. **Crear el usuario MySQL** (René, en la máquina que tiene `clave-casa` y el alias
   `montalvo-vps`; pide la clave root de MySQL): `bash scripts/agenda/crear-usuario-consulta.sh`.
   Deja `AGENDA_CONSULTA_USUARIO/PASSWORD` en el `.env` del CRM. Al final imprime los estados
   reales de `para_agendar`: si aparece uno que no sea PENDIENTE/PAGADO/ATENDIDO, añadirlo a
   `ESTADOS_RESERVA_AGENDA` (backend) y a `ESTADO_RESERVA` (frontend) antes de seguir.
2. **Backend**: merge de `reservas-crm` a `main`, push, y el despliegue de siempre
   (`crm-backend-arquitectura` §4: respaldo verificado → `git pull --ff-only` → `npm ci` →
   `prisma migrate deploy` (no hay migración nueva) → `npm run build` **sin tuberías que oculten
   el error** → `test -s dist/main.js`). Antes de reiniciar, en el `.env`:
   `AGENDA_VPS_CONSULTA=on`. Reiniciar y verificar `/health`, login vacío → 400, periodos → 401,
   y `GET /agenda/reservas` sin token → 401. Con un token de recepción: 200 con `porEstado`.
3. **Frontend**: merge de `reservas-crm` a `main` y push (Vercel publica solo). El schema no
   cambió: no hace falta tocar el SHA de `.github/workflows/calidad.yml`.

Si el paso 1 se demora, se puede desplegar el backend igual con `AGENDA_VPS_CONSULTA` apagada:
las rutas responden 503 y la ficha del chat dice «No pudimos consultar la agenda» con reintento.
Por eso el frontend va **después** de encender la bandera.

## Trampas (ya mordieron)

- **`npm run build | tail` oculta el fallo**: verificar siempre `date -r dist/main.js`.
- **`check:skills` exige que todo módulo esté en `PANORAMA.md`** (ya actualizado en la rama).
- **`validate_password`** del MySQL exige mayúscula, minúscula, número y símbolo (el script ya lo cumple).
- **Límite de 120 peticiones/min por IP**: no barrer la agenda desde el servidor.
- **Una clase que hereda el constructor de otra sin decorador queda sin inyección** en Nest
  (pasó con `AgendaVpsClient`): constructor explícito, y la prueba `agenda-reservas-crm.spec.ts`.
- **El pipe `moneda` asume dólares**: todo monto que ya viene en Bs lleva `moneda:'BOB'`.

## Después (fase aparte, ya ofrecida)

Importar al **Directorio médico del CRM** los 53 médicos / 25 especialidades / fotos de la
agenda, enlazando por código de FileMaker.

## Otros pendientes de René (no son de esta tarea)

- Hacer una reserva de prueba de punta a punta en la landing y pedir a recepción que la anule
  (verifica el paso a FileMaker/caja).
- Vercel: `CRM_REVALIDAR_SECRETO` (aviso instantáneo de promociones/directorio).
- Seguridad `montalvo-vps`: `/progs/prod040326.zip` público, phpMyAdmin y Webmin abiertos, sin
  respaldos de MySQL. Sin aprobar.
