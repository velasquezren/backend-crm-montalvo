import { ConflictException, Injectable } from '@nestjs/common';
import { EstadoPeriodo, Prisma, Rol } from '../../prisma/prisma-client';

import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  Aprobador,
  bloqueosParaRevision,
  calcularEstadoRevision,
  esEditable,
  MOTIVO_BLOQUEO,
  transicionPermitida,
} from './estados-periodo';
import { PlanillaComisionesService } from './planilla-comisiones.service';
import { conPeriodoBloqueado, fotoFinanciera } from './transaccion-periodo';

/**
 * El ciclo de vida de un mes de liquidación: enviarlo a revisión, aprobarlo,
 * rechazarlo, reabrirlo, registrar el pago y eliminarlo.
 *
 * Vivía en `PlanillaComisionesService` junto a la importación y la
 * clasificación. Las transiciones legales siguen en `estados-periodo.ts`, y
 * la serialización por periodo (candado + REPEATABLE READ) en
 * `transaccion-periodo.ts`: este servicio solo las usa, igual que antes.
 *
 * Lee el periodo y sus alertas, e invalida las cachés, a través de
 * `PlanillaComisionesService`: `invalidarCachesDelPeriodo` sigue siendo el
 * único punto por el que pasan todas las mutaciones de un periodo.
 */
@Injectable()
export class CicloPeriodoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly planilla: PlanillaComisionesService,
  ) {}

  async eliminarPeriodo(id: string, usuarioId: string) {
    await conPeriodoBloqueado(this.prisma, id, async tx => {
      const periodo = await this.planilla.obtenerPeriodo(id, tx);
      if (!esEditable(periodo.estado)) {
        throw new ConflictException(`No se puede eliminar este periodo. ${MOTIVO_BLOQUEO[periodo.estado]}`);
      }
      await AuditService.registrarFinanciero(tx, 'PeriodoComision', id, 'ELIMINAR', usuarioId, {
        anterior: await fotoFinanciera(tx, id),
      });
      // Las ventas y resultados caen por onDelete: Cascade.
      await tx.periodoComision.delete({ where: { id } });
    });
    /* El mes borrado desaparece del año: sin esto seguiría pintado hasta 60 s
       en una vista que ya no tiene respaldo en la base. Y su analítica cacheada
       sobreviviría al periodo, respondiendo 200 con las cifras de un mes que ya
       no está en vez del 404 que corresponde. */
    this.planilla.invalidarCachesDelPeriodo(id);
    return { eliminado: true };
  }

  /* ── Ciclo de vida del mes ─────────────────────────────────────────────
   *
   * No hay un `cambiarEstado(estado)` genérico, y su ausencia es la mitad del
   * arreglo. El que había aceptaba el valor que llegara sin comprobar nada:
   * `CERRADO → BORRADOR` era un salto legal, así que el candado de un mes
   * pagado dependía de que nadie eligiera mal en un desplegable.
   *
   * Ahora cada salto es un método con su propia intención, sus permisos, los
   * datos que exige y su línea de auditoría. La tabla de `estados-periodo.ts`
   * los valida a todos por igual: el nombre del método dice qué se quiere
   * hacer, la tabla dice si se puede desde donde está.
   */

  /** Lo que la pantalla necesita para pintar el panel de cierre. */
  async revision(periodoId: string) {
    const periodo = await this.planilla.obtenerPeriodo(periodoId);
    const [superAdmins, aprobaciones] = await Promise.all([
      this.superAdminsActivos(),
      this.prisma.aprobacionPeriodo.findMany({ where: { periodoId } }),
    ]);

    /*
     * Los bloqueos se calculan ANTES de que alguien pulse —enterarse por un 409
     * obliga a adivinar dónde ir— pero solo donde significan algo: en CALCULADO,
     * que es el único estado desde el que se manda a revisar.
     *
     * No es una micro-optimización: `alertas()` son once consultas agregadas
     * sobre las ventas del mes, y en un mes ya cerrado la respuesta no cambiaría
     * ni un botón de la pantalla. Pedirlas igual sería trabajo para nadie.
     */
    const bloqueos =
      periodo.estado === EstadoPeriodo.CALCULADO
        ? bloqueosParaRevision({
            ...(await this.planilla.alertas(periodoId)).totales,
            vendedorasLiquidadas: periodo._count.resultados,
          })
        : [];

    return {
      estado: periodo.estado,
      ...calcularEstadoRevision(superAdmins, aprobaciones),
      bloqueos,
      cerradoEn: periodo.cerradoEn,
      cerradoPor: periodo.cerradoPor,
      pagadoEn: periodo.pagadoEn,
      pagadoPor: periodo.pagadoPor,
      enRevisionDesde: periodo.enRevisionDesde,
    };
  }

  /** CALCULADO → EN_REVISION. A partir de aquí el mes no se toca. */
  async enviarARevision(id: string, usuarioId: string) {
    const actualizado = await conPeriodoBloqueado(this.prisma, id, async tx => {
      const periodo = await this.exigirTransicion(id, EstadoPeriodo.EN_REVISION, undefined, tx);

      const alertas = await this.planilla.alertas(id, tx);
      const bloqueos = bloqueosParaRevision({
        ...alertas.totales,
        vendedorasLiquidadas: periodo._count.resultados,
      });
      if (bloqueos.length > 0) {
        /* La compuerta. Un flujo de aprobaciones que deja revisar un mes con
           filas sin clasificar no protege nada: solo reparte la firma de un
           número que ya estaba mal. */
        throw new ConflictException(
          `El periodo todavía no se puede revisar: ${bloqueos.map(b => b.detalle).join(' ')}`,
        );
      }

      const actualizado = await tx.periodoComision.update({
        where: { id },
        data: {
          estado: EstadoPeriodo.EN_REVISION,
          enRevisionDesde: new Date(),
          enviadoARevisionPor: usuarioId,
        },
      });
      await AuditService.registrarFinanciero(tx, 'PeriodoComision', id, 'ENVIAR_A_REVISION', usuarioId, {
        liquidacion: await fotoFinanciera(tx, id),
      });
      return actualizado;
    });
    this.planilla.invalidarCachesDelPeriodo(id);
    return actualizado;
  }

  /**
   * Registra el visto bueno de un SUPER_ADMIN y, si ya no falta nadie, cierra.
   *
   * El cierre NO es un botón aparte: es la consecuencia de que se complete el
   * conjunto. Si fuera un paso manual habría un hueco entre "todos aprobaron" y
   * "alguien pulsó cerrar" en el que el mes está aprobado y editable a la vez.
   */
  async aprobar(id: string, usuarioId: string, comentario?: string) {
    const respuesta = await conPeriodoBloqueado(this.prisma, id, async tx => {
      const periodo = await this.planilla.obtenerPeriodo(id, tx);
      const firma = await tx.aprobacionPeriodo.findUnique({ where: { periodoId_usuarioId: { periodoId: id, usuarioId } } });
      const texto = comentario?.trim() || null;
      const repetida = firma !== null && firma.comentario === texto;
      if (periodo.estado !== EstadoPeriodo.EN_REVISION && !(periodo.estado === EstadoPeriodo.CERRADO && repetida)) {
        throw new ConflictException(
          `Solo se puede aprobar un periodo EN REVISIÓN (este está ${periodo.estado}).`,
        );
      }

      if (!repetida) {
        await tx.aprobacionPeriodo.upsert({
          where: { periodoId_usuarioId: { periodoId: id, usuarioId } },
          create: { periodoId: id, usuarioId, comentario: texto },
          update: { comentario: texto },
        });
        await AuditService.registrarFinanciero(tx, 'PeriodoComision', id, 'APROBAR', usuarioId, {
          comentario: texto, calculadoEn: periodo.calculadoEn,
        });
      }

      const [superAdmins, aprobaciones] = await Promise.all([
        this.superAdminsActivos(tx),
        tx.aprobacionPeriodo.findMany({ where: { periodoId: id } }),
      ]);
      const revision = calcularEstadoRevision(superAdmins, aprobaciones);

      if (periodo.estado === EstadoPeriodo.CERRADO) return { cerrado: true, ...revision };
      if (!revision.completa) {
        return { cerrado: false, ...revision };
      }

      await tx.periodoComision.update({
        where: { id },
        data: {
          estado: EstadoPeriodo.CERRADO,
          cerradoEn: new Date(),
          // Quien completó el conjunto: el último visto bueno que faltaba.
          cerradoPor: usuarioId,
        },
      });
      await AuditService.registrarFinanciero(tx, 'PeriodoComision', id, 'CERRAR', usuarioId, {
        aprobaron: revision.aprobaron.map(a => a.nombre),
        liquidacion: await fotoFinanciera(tx, id),
      });

      return { cerrado: true, ...revision };
    });
    this.planilla.invalidarCachesDelPeriodo(id);
    return respuesta;
  }

  /** EN_REVISION → CALCULADO. Devuelve el mes a edición y borra las firmas. */
  async rechazar(id: string, usuarioId: string, motivo: string) {
    const actualizado = await conPeriodoBloqueado(this.prisma, id, async tx => {
      await this.exigirTransicion(id, EstadoPeriodo.CALCULADO, EstadoPeriodo.EN_REVISION, tx);
      await AuditService.registrarFinanciero(tx, 'PeriodoComision', id, 'RECHAZAR', usuarioId, {
        motivo, anterior: await fotoFinanciera(tx, id),
      });
      /* Las aprobaciones se borran ENTERAS, también las de quien no rechazó.
         Una firma vale para las cifras que se firmaron: si el mes vuelve a
         edición, lo que aprobaron los demás ya no describe lo que va a
         cerrarse. Conservarlas sería arrastrar un visto bueno a números que
         esa persona nunca vio. */
      await tx.aprobacionPeriodo.deleteMany({ where: { periodoId: id } });
      return tx.periodoComision.update({
        where: { id },
        data: { estado: EstadoPeriodo.CALCULADO, enRevisionDesde: null, enviadoARevisionPor: null },
      });
    });

    this.planilla.invalidarCachesDelPeriodo(id);
    return actualizado;
  }

  /**
   * CERRADO → CALCULADO. Solo SUPER_ADMIN y con motivo.
   *
   * **Guarda la foto de configuración que está a punto de perderse.**
   * `configuracionUsada` se pisa en cada cálculo (ver el schema), así que
   * reabrir y recalcular borraba la única respuesta a "¿con qué reglas se pagó
   * este mes?". El schema ya dice dónde vive el historial de intentos —en
   * `AuditLog`—, así que la foto viaja con esta entrada en vez de en una
   * columna nueva.
   */
  async reabrir(id: string, usuarioId: string, motivo: string) {
    const actualizado = await conPeriodoBloqueado(this.prisma, id, async tx => {
      const periodo = await this.exigirTransicion(id, EstadoPeriodo.CALCULADO, EstadoPeriodo.CERRADO, tx);
      await AuditService.registrarFinanciero(tx, 'PeriodoComision', id, 'REABRIR', usuarioId, {
        motivo, cerradoEn: periodo.cerradoEn, cerradoPor: periodo.cerradoPor,
        configuracionConLaQueSeCerro: periodo.configuracionUsada,
        anterior: await fotoFinanciera(tx, id),
      });
      await tx.aprobacionPeriodo.deleteMany({ where: { periodoId: id } });
      return tx.periodoComision.update({
        where: { id },
        data: {
          estado: EstadoPeriodo.CALCULADO,
          cerradoEn: null,
          cerradoPor: null,
          enRevisionDesde: null,
          enviadoARevisionPor: null,
        },
      });
    });

    this.planilla.invalidarCachesDelPeriodo(id);
    return actualizado;
  }

  /** CERRADO → PAGADO. Terminal: desde aquí ya no se vuelve. */
  async registrarPago(id: string, usuarioId: string) {
    const actualizado = await conPeriodoBloqueado(this.prisma, id, async tx => {
      await this.exigirTransicion(id, EstadoPeriodo.PAGADO, EstadoPeriodo.CERRADO, tx);
      const actualizado = await tx.periodoComision.update({
        where: { id },
        data: { estado: EstadoPeriodo.PAGADO, pagadoEn: new Date(), pagadoPor: usuarioId },
      });
      await AuditService.registrarFinanciero(tx, 'PeriodoComision', id, 'PAGAR', usuarioId, {
        liquidacion: await fotoFinanciera(tx, id),
      });
      return actualizado;
    });
    this.planilla.invalidarCachesDelPeriodo(id);
    return actualizado;
  }

  /**
   * Comprueba el salto contra la tabla y devuelve el periodo.
   *
   * `desdeEsperado` es una segunda cerradura para las acciones que solo tienen
   * sentido desde un estado concreto: sin ella, "reabrir" sobre un mes
   * EN_REVISION pasaría —EN_REVISION → CALCULADO es un salto legal— pero por la
   * puerta equivocada, sin borrar aprobaciones ni pedir el motivo que sí exige
   * un rechazo.
   */
  private async exigirTransicion(
    id: string,
    hasta: EstadoPeriodo,
    desdeEsperado?: EstadoPeriodo,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const periodo = await this.planilla.obtenerPeriodo(id, tx);

    if (desdeEsperado && periodo.estado !== desdeEsperado) {
      throw new ConflictException(
        `Esta acción solo se puede hacer sobre un periodo ${desdeEsperado} ` +
          `(este está ${periodo.estado}).`,
      );
    }

    if (!transicionPermitida(periodo.estado, hasta)) {
      throw new ConflictException(
        `No se puede pasar de ${periodo.estado} a ${hasta}. ${MOTIVO_BLOQUEO[periodo.estado]}`.trim(),
      );
    }

    return periodo;
  }

  /**
   * Quién puede aprobar hoy.
   *
   * Se consulta en cada lectura y no se congela al abrir la revisión: un
   * SUPER_ADMIN puede bajar a ADMIN en cualquier momento, y una lista congelada
   * dejaría el mes esperando para siempre una firma que ya nadie puede dar.
   */
  private superAdminsActivos(tx: Prisma.TransactionClient = this.prisma): Promise<Aprobador[]> {
    return tx.usuario.findMany({
      where: { rol: Rol.SUPER_ADMIN, activo: true },
      select: { id: true, nombre: true },
      orderBy: { nombre: 'asc' },
    });
  }
}
