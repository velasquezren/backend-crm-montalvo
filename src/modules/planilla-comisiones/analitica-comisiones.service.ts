import { Injectable, NotFoundException } from '@nestjs/common';
import { ClasifComision, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CacheMemoria } from '../../common/cache/cache-memoria';
import { redondear } from './clasificador';

/**
 * Analítica del periodo — todo lo que se puede leer del Excel importado.
 *
 * Alimenta el informe mensual de comisiones: qué se vendió, de qué categoría,
 * por qué canal, quién lo hizo y cómo se movió a lo largo del mes.
 *
 * Regla del módulo: los agregados se resuelven en SQL (`groupBy` / `$queryRaw`),
 * nunca trayendo las filas a memoria para sumarlas — un mes real ronda las 500
 * filas, pero el VPS tiene 1 core y esto se consulta en cada carga del panel.
 */

/** Una porción del total, ya con su peso relativo calculado. */
export interface Porcion {
  clave: string;
  etiqueta: string;
  cantidad: number;
  montoVendido: number;
  baseCalculo: number;
  /** % del monto vendido del periodo. */
  pctMonto: number;
}

const ETIQUETA_CLASIF: Record<ClasifComision, string> = {
  PLANPAQ: 'Plan Maternidad',
  PLANNIN: 'Plan Varios',
  CIRUGIA: 'Cirugía',
  CONSULTA: 'Consulta',
  LAB: 'Laboratorio',
  ECOGRAFIA: 'Ecografía',
  OTROSS: 'Otros Servicios',
  CAMPANA: 'Campaña',
  PROMOCION: 'Promoción',
};

const ETIQUETA_CANAL: Record<string, string> = {
  EMPRESA: 'Empresa (recursos de la clínica)',
  PROPIO: 'Propio (gestión de la vendedora)',
};

const ETIQUETA_UNIDAD: Record<string, string> = {
  MATERNIDAD: 'Maternidad',
  RA: 'Reproducción Asistida',
  VARIOS: 'Varios',
};

@Injectable()
export class AnaliticaComisionesService {
  /**
   * Caché en memoria de analíticas por periodo (TTL 60s, max 30).
   * Evita recalcular 10 agregados pesados de SQL en cada recarga de la vista.
   */
  private readonly cache = new CacheMemoria<Awaited<ReturnType<AnaliticaComisionesService['calcularAnalitica']>>>({
    ttlMs: 60_000,
    maxEntradas: 30,
  });

  constructor(private readonly prisma: PrismaService) {}

  /** Invalida la caché de un periodo cuando se recalcula o importa. */
  invalidar(periodoId?: string): void {
    this.cache.invalidar(periodoId);
  }

  /** Informe completo del periodo, listo para pintar en el panel. */
  async analitica(periodoId: string) {
    return this.cache.resolver(periodoId, () => this.calcularAnalitica(periodoId));
  }

  private async calcularAnalitica(periodoId: string) {
    const periodo = await this.prisma.periodoComision.findUnique({ where: { id: periodoId } });
    if (!periodo) {
      throw new NotFoundException(`Periodo ${periodoId} no encontrado`);
    }

    const soloComisionables: Prisma.VentaImportadaWhereInput = {
      periodoId,
      comisionable: true,
    };

    const [
      totales,
      excluidas,
      porClasif,
      porCanal,
      porModulo,
      porUnidad,
      porNivel,
      topServicios,
      topMedicos,
      pacientes,
      serviciosDistintos,
    ] = await Promise.all([
      this.prisma.ventaImportada.aggregate({
        where: soloComisionables,
        _count: { _all: true },
        _sum: { precio: true, ingresoNeto: true },
        _avg: { precio: true },
        _max: { precio: true },
      }),
      this.prisma.ventaImportada.count({ where: { periodoId, comisionable: false } }),
      this.prisma.ventaImportada.groupBy({
        by: ['clasif'],
        where: soloComisionables,
        _count: { _all: true },
        _sum: { precio: true, ingresoNeto: true },
        orderBy: { _sum: { precio: 'desc' } },
      }),
      this.prisma.ventaImportada.groupBy({
        by: ['canal'],
        where: soloComisionables,
        _count: { _all: true },
        _sum: { precio: true, ingresoNeto: true },
        orderBy: { _sum: { precio: 'desc' } },
      }),
      this.prisma.ventaImportada.groupBy({
        by: ['modulo'],
        where: soloComisionables,
        _count: { _all: true },
        _sum: { precio: true, ingresoNeto: true },
        orderBy: { _sum: { precio: 'desc' } },
      }),
      this.prisma.ventaImportada.groupBy({
        by: ['unidadNegocio'],
        where: soloComisionables,
        _count: { _all: true },
        _sum: { precio: true, ingresoNeto: true },
        orderBy: { _sum: { precio: 'desc' } },
      }),
      this.prisma.ventaImportada.groupBy({
        by: ['nivel'],
        where: { ...soloComisionables, nivel: { not: null } },
        _count: { _all: true },
        _sum: { precio: true, ingresoNeto: true },
        orderBy: { _sum: { precio: 'desc' } },
      }),
      this.prisma.ventaImportada.groupBy({
        by: ['detalle'],
        where: soloComisionables,
        _count: { _all: true },
        _sum: { precio: true },
        orderBy: { _sum: { precio: 'desc' } },
        take: 15,
      }),
      this.prisma.ventaImportada.groupBy({
        by: ['medico'],
        where: { ...soloComisionables, medico: { not: null } },
        _count: { _all: true },
        _sum: { precio: true },
        orderBy: { _sum: { precio: 'desc' } },
        take: 10,
      }),
      this.prisma.ventaImportada.findMany({
        where: { ...soloComisionables, pac: { not: null } },
        distinct: ['pac'],
        select: { pac: true },
      }),
      this.prisma.ventaImportada.findMany({
        where: soloComisionables,
        distinct: ['detalle'],
        select: { detalle: true },
      }),
    ]);

    const montoTotal = Number(totales._sum.precio ?? 0);
    const baseTotal = Number(totales._sum.ingresoNeto ?? 0);

    const [porDia, liquidacion] = await Promise.all([
      this.ventasPorDia(periodoId),
      this.resumenLiquidacion(periodoId),
    ]);

    return {
      periodo,
      resumen: {
        filasComisionables: totales._count._all,
        filasExcluidas: excluidas,
        montoVendido: redondear(montoTotal),
        baseCalculo: redondear(baseTotal),
        // Lo que se descuenta de impuestos antes de comisionar.
        impuestosDescontados: redondear(montoTotal - baseTotal),
        ticketPromedio: redondear(Number(totales._avg.precio ?? 0)),
        ventaMayor: redondear(Number(totales._max.precio ?? 0)),
        pacientesUnicos: pacientes.length,
        serviciosDistintos: serviciosDistintos.length,
        tipoCambio: Number(periodo.tipoCambio),
        ...liquidacion,
      },
      porClasificacion: porClasif.map(f => this.porcion(f.clasif, f, montoTotal, ETIQUETA_CLASIF)),
      porCanal: porCanal.map(f => this.porcion(f.canal, f, montoTotal, ETIQUETA_CANAL)),
      porModulo: porModulo.map(f => this.porcion(f.modulo, f, montoTotal)),
      porUnidadNegocio: porUnidad.map(f =>
        this.porcion(f.unidadNegocio, f, montoTotal, ETIQUETA_UNIDAD),
      ),
      porNivelPlan: porNivel.map(f => this.porcion(f.nivel, f, montoTotal)),
      topServicios: topServicios.map(s => ({
        etiqueta: s.detalle,
        cantidad: s._count._all,
        montoVendido: redondear(Number(s._sum.precio ?? 0)),
        pctMonto: this.porcentaje(Number(s._sum.precio ?? 0), montoTotal),
      })),
      topMedicos: topMedicos.map(m => ({
        etiqueta: m.medico ?? 'Sin médico',
        cantidad: m._count._all,
        montoVendido: redondear(Number(m._sum.precio ?? 0)),
        pctMonto: this.porcentaje(Number(m._sum.precio ?? 0), montoTotal),
      })),
      porDia,
    };
  }

  /**
   * Construye una porción a partir de una fila de `groupBy`.
   *
   * Los `groupBy` se escriben explícitos (uno por columna) en vez de con un
   * helper genérico: Prisma tipa `by` de forma literal y pasarle una variable
   * obliga a castear — más líneas, pero el compilador sigue validando.
   */
  private porcion(
    clave: string | null,
    fila: {
      _count: { _all: number };
      _sum: { precio: Prisma.Decimal | null; ingresoNeto: Prisma.Decimal | null };
    },
    montoTotal: number,
    etiquetas?: Record<string, string>,
  ): Porcion {
    const valor = clave ?? 'Sin dato';
    const monto = Number(fila._sum.precio ?? 0);
    return {
      clave: valor,
      etiqueta: etiquetas?.[valor] ?? valor,
      cantidad: fila._count._all,
      montoVendido: redondear(monto),
      baseCalculo: redondear(Number(fila._sum.ingresoNeto ?? 0)),
      pctMonto: this.porcentaje(monto, montoTotal),
    };
  }

  /** Evolución diaria del mes. Se agrupa por día en SQL, no por timestamp exacto. */
  private async ventasPorDia(periodoId: string) {
    const filas = await this.prisma.$queryRaw<
      Array<{ dia: Date; cantidad: bigint; monto: Prisma.Decimal }>
    >`
      SELECT date_trunc('day', "fecha") AS dia,
             COUNT(*)                   AS cantidad,
             SUM("precio")              AS monto
      FROM "VentaImportada"
      WHERE "periodoId" = ${periodoId} AND "comisionable" = true AND "fecha" IS NOT NULL
      GROUP BY 1
      ORDER BY 1
    `;

    return filas.map(f => ({
      dia: f.dia.toISOString().slice(0, 10),
      cantidad: Number(f.cantidad),
      montoVendido: redondear(Number(f.monto ?? 0)),
    }));
  }

  /**
   * Totales de la liquidación, si el periodo ya se calculó. Devuelve ceros
   * cuando todavía no: el panel se puede ver igual tras importar.
   */
  private async resumenLiquidacion(periodoId: string) {
    const total = await this.prisma.resultadoComision.aggregate({
      where: { periodoId },
      _count: { _all: true },
      _sum: {
        comisionA: true,
        comisionB: true,
        comisionC: true,
        bonoJefatura: true,
        bonoPublicidad: true,
        bonoTrimestral: true,
        totalUsd: true,
        totalBob: true,
      },
    });

    const num = (v: Prisma.Decimal | null) => redondear(Number(v ?? 0));
    return {
      vendedorasLiquidadas: total._count._all,
      comisionTipoAUsd: num(total._sum.comisionA),
      comisionTipoBUsd: num(total._sum.comisionB),
      comisionTipoCUsd: num(total._sum.comisionC),
      bonosUsd: redondear(
        Number(total._sum.bonoJefatura ?? 0) +
          Number(total._sum.bonoPublicidad ?? 0) +
          Number(total._sum.bonoTrimestral ?? 0),
      ),
      comisionTotalUsd: num(total._sum.totalUsd),
      comisionTotalBob: num(total._sum.totalBob),
    };
  }

  private porcentaje(parte: number, total: number): number {
    return total > 0 ? redondear((parte / total) * 100) : 0;
  }
}
