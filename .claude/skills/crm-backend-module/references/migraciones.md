# Migraciones

> Parte de la skill `crm-backend-module`: lee antes su [índice](../SKILL.md).

Al cambiar `schema.prisma`, **genera y commitea la migración** — si no, quien clone el repo
tendrá una base desincronizada:

```bash
npx prisma migrate dev --name descripcion_corta --create-only   # revisar el SQL
npx prisma migrate deploy                                        # aplicar
```

Con datos reales en la base, revisa siempre el SQL antes de aplicarlo (`--create-only`).
