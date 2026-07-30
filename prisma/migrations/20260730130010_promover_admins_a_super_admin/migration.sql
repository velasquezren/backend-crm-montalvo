-- Los administradores que ya existían pasan a SUPER_ADMIN para que nadie pierda
-- acceso al desplegar: sin esto no quedaría NINGÚN super admin y nadie podría
-- gestionar agentes ni asignar códigos (bloqueo total del sistema).
-- Va en su propia migración porque Postgres no permite usar un valor de enum
-- en la misma transacción en la que se creó.
UPDATE "Usuario" SET "rol" = 'SUPER_ADMIN' WHERE "rol" = 'ADMIN';
