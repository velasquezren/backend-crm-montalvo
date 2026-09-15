import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { OrigenLead, Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';

const MINUTO = 60_000;
const LOTE = 10;

export function proximoIntentoAlta(intentos: number, ahora: Date): Date {
  const minutos = [1, 5, 15, 60][Math.min(Math.max(intentos - 1, 0), 3)];
  return new Date(ahora.getTime() + minutos * MINUTO);
}

/** Solo códigos conocidos; mensajes SQL pueden contener datos de pacientes. */
export function errorAltaSanitizado(error: unknown): string {
  return error instanceof Prisma.PrismaClientKnownRequestError
    ? `POSTGRES_${error.code}`
    : 'ALTA_NO_COMPLETADA';
}

/** Identidad de primer contacto por conversación, independiente de sus oportunidades históricas. */
@Injectable()
export class PrimerContactoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrimerContactoService.name);
  private temporizador?: NodeJS.Timeout;
  private detenido = false;
  private barrido?: Promise<number>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clientes: ClientesService,
  ) {}

  protected ahora(): Date { return new Date(); }

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.programar(0);
  }

  async onModuleDestroy(): Promise<void> {
    this.detenido = true;
    if (this.temporizador) clearTimeout(this.temporizador);
    await this.barrido;
  }

  private programar(demora: number): void {
    if (this.detenido) return;
    this.temporizador = setTimeout(() => {
      void this.barrerPendientes()
        .catch(error => this.logger.error(`Barrido de altas: ${errorAltaSanitizado(error)}`))
        .finally(() => this.programar(MINUTO));
    }, demora);
    this.temporizador.unref();
  }

  /** Participa en la transacción del mensaje: si falla, tampoco se confirma el mensaje. */
  async preparar(
    tx: Prisma.TransactionClient,
    conversacionId: string,
    mensajeId: string,
    origen: OrigenLead,
    anuncioId?: string,
  ): Promise<void> {
    await tx.primerContactoWhatsapp.updateMany({
      where: { conversacionId, mensajeId: null },
      data: { mensajeId, origen, anuncioId: anuncioId || null, proximoIntento: this.ahora() },
    });
  }

  barrerPendientes(): Promise<number> {
    if (this.barrido) return this.barrido;
    this.barrido = this.ejecutarBarrido().finally(() => { this.barrido = undefined; });
    return this.barrido;
  }

  private async ejecutarBarrido(): Promise<number> {
    const pendientes = await this.prisma.primerContactoWhatsapp.findMany({
      where: { proximoIntento: { lte: this.ahora() }, leadId: null },
      orderBy: [{ proximoIntento: 'asc' }, { conversacionId: 'asc' }],
      select: { conversacionId: true },
      take: LOTE,
    });
    let completados = 0;
    for (const pendiente of pendientes) {
      if (this.detenido) break;
      if (await this.procesarUno(pendiente.conversacionId)) completados++;
    }
    if (pendientes.length) this.logger.log(
      `Altas iniciales: candidatos=${pendientes.length} completados=${completados} loteMaximo=${LOTE}`,
    );
    return completados;
  }

  /** La fila permanece bloqueada hasta confirmar el lead o el próximo intento. */
  async procesarUno(conversacionId: string): Promise<boolean> {
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '4s'");
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1s'");
        const filas = await tx.$queryRaw<Array<{ conversacionId: string }>>`
          SELECT "conversacionId" FROM "PrimerContactoWhatsapp"
          WHERE "conversacionId" = ${conversacionId}
            AND "leadId" IS NULL AND "proximoIntento" <= ${this.ahora()}
          FOR UPDATE SKIP LOCKED
        `;
        if (!filas.length) return false;
        const trabajo = await tx.primerContactoWhatsapp.findUniqueOrThrow({
          where: { conversacionId },
          include: { conversacion: { select: { clienteId: true } } },
        });
        // CHECK en PostgreSQL exige origen y mensaje para todo trabajo listo.
        if (!trabajo.origen || !trabajo.mensajeId) throw new Error('Alta sin mensaje');
        const intento = trabajo.intentos + 1;
        await tx.$executeRawUnsafe('SAVEPOINT alta_inicial');
        try {
          const agenteId = await this.clientes.agenteParaAltaInicial(tx, trabajo.conversacion.clienteId);
          const lead = await tx.lead.create({
            data: {
              clienteId: trabajo.conversacion.clienteId,
              origen: trabajo.origen,
              anuncioId: trabajo.anuncioId,
              agenteId,
              estado: 'NUEVO',
            },
          });
          await tx.primerContactoWhatsapp.update({
            where: { conversacionId },
            data: { leadId: lead.id, intentos: intento, proximoIntento: null, ultimoError: null },
          });
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT alta_inicial');
          return true;
        } catch (error) {
          // También revierte un INSERT exitoso cuyo enlace al trabajo haya fallado.
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT alta_inicial');
          const codigo = errorAltaSanitizado(error);
          const siguiente = proximoIntentoAlta(intento, this.ahora());
          await tx.primerContactoWhatsapp.update({
            where: { conversacionId },
            data: { intentos: intento, proximoIntento: siguiente, ultimoError: codigo },
          });
          this.logger.warn(
            `Alta inicial ${conversacionId}: intento=${intento} error=${codigo} proximo=${siguiente.toISOString()}`,
          );
          return false;
        }
      }, { maxWait: 2_000, timeout: 5_000 });
    } catch (error) {
      // Si la BD no permite ni anotar el error, la reserva confirmada sigue pendiente.
      this.logger.error(`Alta inicial ${conversacionId}: ${errorAltaSanitizado(error)}; trabajo conservado`);
      return false;
    }
  }
}
