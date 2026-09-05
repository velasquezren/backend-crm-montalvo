/**
 * Punto único desde el que el backend importa tipos y enums de Prisma.
 *
 * Desde Prisma 7 el cliente **se genera** (`src/generated/prisma/`, fuera de
 * git) en vez de vivir dentro del paquete `@prisma/client`. Importar la ruta
 * generada desde los 52 archivos que la necesitan ataría cada uno al valor de
 * `output` del `schema.prisma`: cambiarlo obligaría a un buscar-y-reemplazar
 * por todo el repo. Con este archivo en medio, cambia una línea.
 *
 * Lo que se importa de acá son **tipos y enums**. El cliente en sí se inyecta
 * siempre como `PrismaService`, nunca instanciando `PrismaClient` a mano.
 */
export * from '../generated/prisma/client';
