import { Injectable, Optional, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client';

/**
 * Tamaño del pool de conexiones.
 *
 * Hasta Prisma 6 lo decidía el motor Rust con `núcleos × 2 + 1`, que en este
 * VPS de **un núcleo** daban **tres**: el barrido de recordatorios y las
 * peticiones de las agentes se peleaban por ellas (ver la nota de concurrencia
 * en `actividades.service.ts`). Con el adaptador el pool es un `pg.Pool` normal
 * y el número lo elegimos nosotros.
 *
 * Diez, no más: Postgres corre en la misma máquina con `max_connections = 100`
 * y ya hay ~16 conexiones de las otras aplicaciones del servidor. Diez sobran
 * para una API que espera en la red el 97 % del tiempo, y dejan sitio de
 * verdad para todo lo demás.
 */
const MAX_CONEXIONES = 10;

/**
 * Prisma 7 cambió los tiempos por defecto del adaptador y ninguno de los dos
 * sirve acá, así que van explícitos:
 *
 * - `connectionTimeoutMillis: 0` (su defecto) es esperar **para siempre** una
 *   conexión que no llega. Una petición colgada indefinidamente es peor que un
 *   error: la agente no sabe si mandó el mensaje.
 * - `idleTimeoutMillis: 10_000` (su defecto) recicla conexiones cada diez
 *   segundos. En una clínica con ratos muertos entre pacientes eso significa
 *   reabrir el TCP y volver a autenticar todo el tiempo, gratis.
 */
const ESPERA_CONEXION_MS = 5_000;
const OCIO_CONEXION_MS = 120_000;

/**
 * Cliente único de Prisma para toda la app — schema.prisma es la única
 * fuente de verdad del modelo de datos (CRM_MANIFESTO.md §1.1).
 *
 * Desde Prisma 7 el cliente no lleva motor Rust: habla con Postgres a través de
 * un **driver adapter** (`pg`), y por eso la URL ya no sale del `schema.prisma`
 * —que ni siquiera admite `url`— sino de acá. La del CLI para migrar vive
 * aparte, en `prisma.config.ts`.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  /**
   * @param url Solo lo pasan las pruebas de integración, que instancian el
   *   service a mano para apuntar a `crm_test` sin tocar el entorno. En la app
   *   real no lo pasa nadie y sale de `DATABASE_URL`.
   *
   * **`@Optional()` no es decorativo.** Con `emitDecoratorMetadata`, Nest lee el
   * tipo del parámetro y sale a buscar un proveedor `String` en el
   * `PrismaModule`; sin encontrarlo, la aplicación **no arranca**. El build
   * seguía en verde y las 709 pruebas también —instancian el service a mano,
   * sin pasar por el inyector—, así que esto solo aparece al levantar la app de
   * verdad. Con `@Optional()`, Nest inyecta `undefined` y sigue.
   */
  constructor(@Optional() url?: string) {
    super({
      adapter: new PrismaPg({
        connectionString: url ?? process.env['DATABASE_URL'],
        max: MAX_CONEXIONES,
        connectionTimeoutMillis: ESPERA_CONEXION_MS,
        idleTimeoutMillis: OCIO_CONEXION_MS,
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
