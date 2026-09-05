import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Configuración del CLI de Prisma (migrate, generate, studio).
 *
 * Existe desde Prisma 7: el bloque `datasource` del `schema.prisma` ya no puede
 * llevar `url`. La URL que usa **el CLI** para migrar vive acá; la que usa la
 * **aplicación** en runtime va en el adaptador que arma `PrismaService`. Son dos
 * caminos distintos a propósito, y conviene no confundirlos: `migrate deploy`
 * del despliegue lee esta, y las pruebas de integración apuntan el adaptador a
 * `crm_test` sin tocar nada de acá.
 *
 * `dotenv/config` carga el `.env` local. En el servidor la variable ya viene del
 * `EnvironmentFile` de systemd, así que `env()` la encuentra igual.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    /**
     * `process.env` y NO el helper `env()` de `prisma/config`, que resuelve
     * **al cargar el archivo** y lanza si la variable falta. Con `env()`,
     * `prisma generate` —que no toca la base para nada— moría sin
     * `DATABASE_URL`; y como `postinstall` lo ejecuta en cada `npm install`,
     * eso rompía la cadena de despliegue entera en su primer paso, con un
     * mensaje que no menciona ni generate ni el despliegue.
     *
     * Con la cadena vacía, `generate` funciona siempre y solo falla lo que de
     * verdad necesita conexión (`migrate`, `studio`), diciendo lo que pasa.
     */
    url: process.env['DATABASE_URL'] ?? '',
  },
});
