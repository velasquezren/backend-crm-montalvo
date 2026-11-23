# Migraciones: si `--create-only` trae cambios que no pediste, es drift

> Parte de la skill `crm-backend-module`: lee antes su [índice](../SKILL.md).

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
