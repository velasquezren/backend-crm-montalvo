import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { enSegundoPlano } from '../../common/fiabilidad/en-segundo-plano';
import { PrismaService } from '../../prisma/prisma.service';
import { diasDeInactividad } from './estado-conversacion';

/** Cada cuánto se barre. El corte es en días: más seguido no cambiaría nada. */
const INTERVALO_MS = 6 * 60 * 60 * 1000;
/** Primera pasada un rato después de arrancar, no en medio del arranque. */
const PRIMERA_PASADA_MS = 60 * 1000;

/**
 * Cierra las conversaciones sin ningún mensaje en `CONVERSACIONES_CIERRE_DIAS`
 * días (30 si no se configura).
 *
 * A esa altura la ventana de 24 h de WhatsApp venció hace mucho: solo se le
 * puede escribir con una plantilla de pago. Dejarla abierta no la atiende; solo
 * infla «Sin responder» hasta que el número deja de significar nada. Cerrar es
 * reversible: si la paciente vuelve a escribir, la ingesta la reabre.
 *
 * Se mide por el ÚLTIMO MENSAJE y no por `updatedAt`, que también se mueve al
 * asignar, cerrar o reabrir: con él, reasignar un chat muerto lo daría por vivo.
 */
@Injectable()
export class CierreInactividadService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CierreInactividadService.name);
  private intervalo?: NodeJS.Timeout;
  private primera?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    /* Las pruebas instancian los services a mano; esto es por si algún día
       alguna arranca el módulo entero. Mismo criterio que Actividades. */
    if (process.env.NODE_ENV === 'test') return;
    const barrer = () => void enSegundoPlano('cierre de conversaciones inactivas', this.logger, () => this.cerrarInactivas());
    this.primera = setTimeout(barrer, PRIMERA_PASADA_MS);
    this.primera.unref();
    this.intervalo = setInterval(barrer, INTERVALO_MS);
    this.intervalo.unref();
  }

  onModuleDestroy(): void {
    clearTimeout(this.primera);
    clearInterval(this.intervalo);
  }

  /** Cierra las abiertas sin mensajes desde el corte. Devuelve cuántas cerró. */
  async cerrarInactivas(ahora = new Date()): Promise<number> {
    const dias = diasDeInactividad(process.env.CONVERSACIONES_CIERRE_DIAS);
    const corte = new Date(ahora.getTime() - dias * 24 * 60 * 60 * 1000);
    /* SQL y no `updateMany`: Prisma pondría `updatedAt` = ahora en todas, y
       el inbox —que muestra y ordena por esa hora— presentaría chats de hace
       meses como recién movidos. `cerradaPorId` queda nulo: la cerró el
       sistema, no una persona. Un chat recién creado sin mensajes todavía no
       es «inactivo», de ahí el `createdAt`. El NOT EXISTS usa el índice
       (conversacionId, createdAt) de Mensaje. */
    const count = await this.prisma.$executeRaw`
      UPDATE "Conversacion" c SET "cerradaEn" = ${ahora}
      WHERE c."cerradaEn" IS NULL
        AND c."atencionSolicitadaEn" IS NULL
        AND c."createdAt" < ${corte}
        AND NOT EXISTS (
          SELECT 1 FROM "Mensaje" m WHERE m."conversacionId" = c.id AND m."createdAt" >= ${corte}
        )`;
    if (count) this.logger.log(`Cerradas ${count} conversaciones sin mensajes en ${dias} días`);
    return count;
  }
}
