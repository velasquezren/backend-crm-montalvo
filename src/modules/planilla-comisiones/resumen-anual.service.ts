import { Injectable } from '@nestjs/common';
import { AreaVendedora, EstadoPeriodo, TipoVendedora } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { redondear } from './clasificador';
import { ConfiguracionComisionesService } from './configuracion-comisiones.service';
import { bonoTrimestralUsd, cierraTrimestre } from './reglas-calculo';
import { PARAM } from './configuracion-por-defecto';

/** Un mes de una vendedora dentro del año. */
export interface MesVendedora {
  mes: number;
  /** Bruto en USD, tal como viene del Excel. */
  montoVendido: number;
  comisionUsd: number;
  bonoTrimestralUsd: number;
  totalBob: number;
  /** false = ese mes no está importado todavía. */
  importado: boolean;
  /** false = importado pero sin liquidar; el vendido sí es fiable. */
  liquidado: boolean;
}

/** Un trimestre, con el promedio que decide el bono. */
export interface TrimestreVendedora {
  trimestre: 1 | 2 | 3 | 4;
  meses: readonly number[];
  /** Suma de los meses del trimestre que estén importados. */
  vendido: number;
  /** Promedio sobre los meses IMPORTADOS, no sobre 3 fijo. */
  promedio: number;
  mesesConDatos: number;
  objetivoUsd: number;
  cumple: boolean;
  bonoUsd: number;
  bonoBob: number;
}

export interface FilaAnual {
  vendedoraId: string;
  codigo: string;
  nombre: string;
  tipo: TipoVendedora;
  area: AreaVendedora;
  meses: readonly MesVendedora[];
  trimestres: readonly TrimestreVendedora[];
  totalVendido: number;
  totalComisionUsd: number;
  totalBonoTrimestralUsd: number;
  totalBob: number;
}

const TRIMESTRES: ReadonlyArray<{ trimestre: 1 | 2 | 3 | 4; meses: readonly number[] }> = [
  { trimestre: 1, meses: [1, 2, 3] },
  { trimestre: 2, meses: [4, 5, 6] },
  { trimestre: 3, meses: [7, 8, 9] },
  { trimestre: 4, meses: [10, 11, 12] },
];

/**
 * Vista de un año entero: cada vendedora, sus doce meses y sus cuatro trimestres.
 *
 * Existe porque todo lo demás del módulo es **por periodo**: para saber si una
 * vendedora venía creciendo, o por qué cobró bono trimestral en marzo y no en
 * junio, había que abrir los meses de uno en uno y comparar a mano. Es la misma
 * tabla que administración arma en su hoja `CALCULO BONOS`.
 *
 * **Lo vendido sale de las ventas importadas, no de los resultados liquidados.**
 * Un mes puede estar importado y sin calcular —pasa siempre con los meses en
 * curso—, y en ese caso el vendido ya es correcto aunque no haya comisión. Si se
 * leyera de `ResultadoComision`, esos meses aparecerían en cero y el promedio
 * del trimestre saldría mal, que es exactamente el fallo que tuvo el cálculo del
 * bono hasta agosto de 2026.
 */
@Injectable()
export class ResumenAnualService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configuracion: ConfiguracionComisionesService,
  ) {}

  async porAnio(anio: number, soloVendedoraId?: string): Promise<{
    anio: number;
    filas: FilaAnual[];
    totalesPorMes: number[];
  }> {
    const periodos = await this.prisma.periodoComision.findMany({
      where: { anio },
      select: { id: true, mes: true, tipoCambio: true, estado: true },
      orderBy: { mes: 'asc' },
    });

    const vendedoras = await this.prisma.vendedoraComision.findMany({
      where: { activa: true, configurada: true, ...(soloVendedoraId ? { id: soloVendedoraId } : {}) },
      orderBy: [{ tipo: 'asc' }, { nombre: 'asc' }],
    });

    if (periodos.length === 0 || vendedoras.length === 0) {
      return { anio, filas: [], totalesPorMes: Array.from({ length: 12 }, () => 0) };
    }

    const idsPeriodo = periodos.map(p => p.id);
    const mesDePeriodo = new Map(periodos.map(p => [p.id, p.mes]));
    const tcDePeriodo = new Map(periodos.map(p => [p.id, Number(p.tipoCambio) || 1]));

    /* Dos agregados, ambos resueltos en la base: lo vendido (siempre disponible)
       y lo liquidado (solo si el mes se calculó). Nada se suma en memoria salvo
       el pivote final, que son 12 × N celdas. */
    const [vendidoPorMes, liquidadoPorMes] = await Promise.all([
      this.prisma.ventaImportada.groupBy({
        by: ['periodoId', 'vendedoraId'],
        where: { periodoId: { in: idsPeriodo }, comisionable: true, vendedoraId: { not: null } },
        _sum: { precio: true },
      }),
      this.prisma.resultadoComision.findMany({
        where: { periodoId: { in: idsPeriodo } },
        select: {
          periodoId: true,
          vendedoraId: true,
          comisionA: true,
          comisionB: true,
          comisionC: true,
          bonoTrimestral: true,
          totalBob: true,
        },
      }),
    ]);

    const clave = (vendedoraId: string, mes: number) => `${vendedoraId}|${mes}`;

    const vendido = new Map<string, number>();
    for (const fila of vendidoPorMes) {
      if (!fila.vendedoraId) continue;
      const mes = mesDePeriodo.get(fila.periodoId);
      if (!mes) continue;
      vendido.set(clave(fila.vendedoraId, mes), Number(fila._sum.precio ?? 0));
    }

    const liquidado = new Map<string, { comision: number; trimestral: number; totalBob: number }>();
    for (const fila of liquidadoPorMes) {
      const mes = mesDePeriodo.get(fila.periodoId);
      if (!mes) continue;
      liquidado.set(clave(fila.vendedoraId, mes), {
        comision: Number(fila.comisionA) + Number(fila.comisionB) + Number(fila.comisionC),
        trimestral: Number(fila.bonoTrimestral),
        totalBob: Number(fila.totalBob),
      });
    }

    const config = await this.configuracion.cargarConfiguracion();
    const factorTrimestral = config.parametros.get(PARAM.FACTOR_BONO_TRIMESTRAL) ?? 0.005;
    const mesesImportados = new Set(periodos.map(p => p.mes));
    /* BORRADOR = importado pero sin calcular. CALCULADO y CERRADO sí tienen
       resultados; el vendido, en cambio, es fiable en los tres estados. */
    const mesesLiquidados = new Set(
      periodos.filter(p => p.estado !== EstadoPeriodo.BORRADOR).map(p => p.mes),
    );
    /* Un TC por año para lo que se estima: el de diciembre, o el último que haya. */
    const tcReferencia = tcDePeriodo.get(periodos[periodos.length - 1].id) ?? 1;

    const totalesPorMes = Array.from({ length: 12 }, () => 0);

    const filas: FilaAnual[] = vendedoras.map(v => {
      const meses: MesVendedora[] = Array.from({ length: 12 }, (_, i) => {
        const mes = i + 1;
        const montoVendido = redondear(vendido.get(clave(v.id, mes)) ?? 0);
        const liq = liquidado.get(clave(v.id, mes));
        totalesPorMes[i] += montoVendido;
        return {
          mes,
          montoVendido,
          comisionUsd: redondear(liq?.comision ?? 0),
          bonoTrimestralUsd: redondear(liq?.trimestral ?? 0),
          totalBob: redondear(liq?.totalBob ?? 0),
          importado: mesesImportados.has(mes),
          liquidado: mesesLiquidados.has(mes) && liq !== undefined,
        };
      });

      const objetivo = config.objetivosPorTipo.get(v.tipo);
      const objetivoUsd = Number(objetivo?.montoTrimestralUsd ?? 0);

      const trimestres = TRIMESTRES.map(t => {
        const conDatos = t.meses.filter(m => meses[m - 1].importado);
        const vendidoTrimestre = conDatos.reduce((s, m) => s + meses[m - 1].montoVendido, 0);
        const promedio = conDatos.length > 0 ? vendidoTrimestre / conDatos.length : 0;

        /* Se recalcula en vez de leerlo del mes de cierre: así el trimestre en
           curso muestra a cuánto va, que es justo lo que se quiere ver para
           saber si a alguien le falta poco para alcanzarlo. Cuando el mes de
           cierre ya está liquidado, manda ese valor —es el que se pagó—. */
        const mesCierre = t.meses[t.meses.length - 1];
        const yaPagado = meses[mesCierre - 1].bonoTrimestralUsd;
        const estimado = bonoTrimestralUsd(promedio, objetivoUsd, factorTrimestral);
        const bonoUsd = redondear(cierraTrimestre(mesCierre) && yaPagado > 0 ? yaPagado : estimado);

        return {
          trimestre: t.trimestre,
          meses: t.meses,
          vendido: redondear(vendidoTrimestre),
          promedio: redondear(promedio),
          mesesConDatos: conDatos.length,
          objetivoUsd,
          cumple: promedio > objetivoUsd,
          bonoUsd,
          bonoBob: redondear(bonoUsd * tcReferencia),
        };
      });

      return {
        vendedoraId: v.id,
        codigo: v.codigo,
        nombre: v.nombre,
        tipo: v.tipo,
        area: v.area,
        meses,
        trimestres,
        totalVendido: redondear(meses.reduce((s, m) => s + m.montoVendido, 0)),
        totalComisionUsd: redondear(meses.reduce((s, m) => s + m.comisionUsd, 0)),
        totalBonoTrimestralUsd: redondear(meses.reduce((s, m) => s + m.bonoTrimestralUsd, 0)),
        totalBob: redondear(meses.reduce((s, m) => s + m.totalBob, 0)),
      };
    });

    return { anio, filas, totalesPorMes: totalesPorMes.map(redondear) };
  }
}
