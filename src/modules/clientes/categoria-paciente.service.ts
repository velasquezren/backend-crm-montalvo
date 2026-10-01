import { Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { AuditService } from '../../common/audit/audit.service';
import { enSegundoPlano } from '../../common/fiabilidad/en-segundo-plano';
import { CategoriaCliente, Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { TipoCambioService } from '../tipo-cambio/tipo-cambio.service';
import { categoriaPorValor, inicioDeVentana, valorDePacientesSql } from './categoria-paciente';

/** Cada cuánto se recalculan todas. Recoge las planillas importadas y la ventana que avanza. */
const INTERVALO_MS = 6 * 60 * 60 * 1000;
/** Primera pasada un rato después de arrancar: deja la categoría al día tras cada despliegue. */
const PRIMERA_PASADA_MS = 2 * 60 * 1000;

type Db = PrismaService | Prisma.TransactionClient;

interface FilaValor {
  id: string;
  categoria: CategoriaCliente;
  /** `numeric` de Postgres: llega como texto (o Decimal) y se convierte una vez. */
  gasto_reciente_usd: Prisma.Decimal | string | null;
  compras: bigint | number;
}

/**
 * Mantiene `Cliente.categoria` al día con su valor real (ver
 * `categoria-paciente.ts` para la regla).
 *
 * Se recalcula:
 *  - cada 6 h, todas: así entra lo que se importó de FileMaker sin que la
 *    planilla tenga que conocer a Clientes, y una Gold que dejó de comprar
 *    baja sola cuando su gasto sale de la ventana —antes no caducaba nunca—;
 *  - en el acto, una sola, cuando cambia lo que la define: una venta del CRM,
 *    o el PAC que la une a su historial de FileMaker.
 *
 * Una categoría FIJADA a mano (`categoriaFijadaEn`) no se toca nunca: el
 * UPDATE lo condiciona, también si la fijan mientras corre el barrido.
 */
@Injectable()
export class CategoriaPacienteService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CategoriaPacienteService.name);
  private intervalo?: NodeJS.Timeout;
  private primera?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tipoCambio: TipoCambioService,
  ) {}

  onModuleInit(): void {
    /* Las pruebas instancian los services a mano; mismo criterio que el
       cierre de conversaciones y Actividades. */
    if (process.env.NODE_ENV === 'test') return;
    const barrer = () =>
      void enSegundoPlano('recálculo de categorías de pacientes', this.logger, async () => {
        const cambiadas = await this.recalcular();
        if (cambiadas) this.logger.log(`Categoría recalculada: ${cambiadas} pacientes cambiaron`);
      });
    this.primera = setTimeout(barrer, PRIMERA_PASADA_MS);
    this.primera.unref();
    this.intervalo = setInterval(barrer, INTERVALO_MS);
    this.intervalo.unref();
  }

  onModuleDestroy(): void {
    clearTimeout(this.primera);
    clearInterval(this.intervalo);
  }

  /**
   * Recalcula las categorías automáticas —todas, o la de una paciente— y
   * devuelve cuántas cambiaron.
   *
   * `db`: Ventas la llama dentro de la transacción que guarda la venta, para
   * que la venta y su categoría se confirmen juntas o ninguna.
   *
   * El SQL solo AGREGA (gasto en la ventana y compras de cada fuente); la regla
   * la aplica `categoriaPorValor`, en TypeScript, para que viva en un sitio.
   * Las ventas del CRM están en bolivianos y se pasan a dólares con el tipo de
   * cambio vigente —el pactado de la clínica, el mismo que trae FileMaker—.
   * Solo cuentan las ventas pagadas: precio > 0 en FileMaker, GANADA en el CRM.
   *
   * Se escribe por SQL y no con `updateMany`: Prisma movería `updatedAt` en
   * miles de fichas, y Clientes ordena por esa fecha —recalcular no es editar—.
   */
  async recalcular(clienteId?: string, db: Db = this.prisma, ahora = new Date()): Promise<number> {
    const { tipoCambio } = await this.tipoCambio.vigente();
    const soloUna = clienteId ? Prisma.sql`AND c.id = ${clienteId}` : Prisma.empty;

    const filas = await db.$queryRaw<FilaValor[]>`
      WITH ${valorDePacientesSql(inicioDeVentana(ahora), tipoCambio)}
      SELECT c.id, c.categoria,
             COALESCE(f.reciente, 0) + COALESCE(r.reciente, 0) AS gasto_reciente_usd,
             COALESCE(f.compras, 0) + COALESCE(r.compras, 0) AS compras
      FROM "Cliente" c
      LEFT JOIN filemaker f ON f.pac = c.pac
      LEFT JOIN crm r ON r."clienteId" = c.id
      WHERE c."categoriaFijadaEn" IS NULL ${soloUna}`;

    const cambios = new Map<CategoriaCliente, string[]>();
    for (const fila of filas) {
      const nueva = categoriaPorValor({
        gastoRecienteUsd: Number(fila.gasto_reciente_usd ?? 0),
        compras: Number(fila.compras),
      });
      if (nueva !== fila.categoria) cambios.set(nueva, [...(cambios.get(nueva) ?? []), fila.id]);
    }

    let cambiadas = 0;
    for (const [categoria, ids] of cambios) {
      cambiadas += await db.$executeRaw`
        UPDATE "Cliente" SET categoria = ${categoria}::"CategoriaCliente"
        WHERE id = ANY(${ids}) AND "categoriaFijadaEn" IS NULL`;
    }
    return cambiadas;
  }

  /**
   * Fija la categoría a mano (`categoria`) o la devuelve al cálculo (`null`).
   * Solo SUPER_ADMIN: lo exige el controlador. Las agentes son ADMIN para
   * cooperar en el chat, y la categoría decide a quién va una campaña.
   */
  async fijar(clienteId: string, categoria: CategoriaCliente | null, usuarioId: string) {
    const existe = await this.prisma.cliente.findUnique({ where: { id: clienteId }, select: { categoria: true } });
    if (!existe) throw new NotFoundException(`Cliente ${clienteId} no encontrado`);

    if (categoria) {
      await this.prisma.cliente.update({
        where: { id: clienteId },
        data: { categoria, categoriaFijadaEn: new Date(), categoriaFijadaPorId: usuarioId },
      });
    } else {
      await this.prisma.cliente.update({
        where: { id: clienteId },
        data: { categoriaFijadaEn: null, categoriaFijadaPorId: null },
      });
      await this.recalcular(clienteId);
    }
    await this.audit.registrar('Cliente', clienteId, categoria ? 'CATEGORIA_FIJADA' : 'CATEGORIA_AUTOMATICA', usuarioId, {
      antes: existe.categoria,
      categoria,
    });
    return this.estadoDe(clienteId);
  }

  /** Lo que la ficha necesita para pintar el sello: la categoría y si es a mano. */
  private estadoDe(clienteId: string) {
    return this.prisma.cliente.findUniqueOrThrow({
      where: { id: clienteId },
      select: {
        id: true,
        categoria: true,
        categoriaFijadaEn: true,
        categoriaFijadaPor: { select: { id: true, nombre: true } },
      },
    });
  }
}
