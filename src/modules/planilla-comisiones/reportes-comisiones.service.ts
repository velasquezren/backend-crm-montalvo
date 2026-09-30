import { ConflictException, Injectable } from '@nestjs/common';
import { UnidadNegocio } from '../../prisma/prisma-client';

import { PrismaService } from '../../prisma/prisma.service';
import { LineaDesglose, LineaDesgloseVendedora } from './calculo-comisiones.service';
import { redondear } from './clasificador';
import { sumaBonos } from './reglas-calculo';

/**
 * Los reportes de un periodo ya liquidado: el consolidado por vendedora (con
 * o sin las ocultas), la ficha de una vendedora, el desglose por tipo, la
 * planilla y los bonos.
 *
 * Solo LEEN lo que `CalculoComisionesService.calcular()` dejó escrito en
 * `ResultadoComision`: no calculan nada ni tocan la configuración. Vivían en
 * el mismo archivo que el motor, que es donde se decide cuánto se paga; así
 * el motor se lee sin atravesar el formato de las respuestas, y quien pinta
 * o exporta un informe no depende del motor.
 *
 * `reporteConsolidado` es el origen de la planilla en pantalla, del Excel, del
 * Word y de las métricas: el filtro de las vendedoras ocultas vive ahí, en un
 * solo punto (crm-finanzas §9).
 */
@Injectable()
export class ReportesComisionesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Consolidado del periodo: una fila por vendedora + totales del equipo. */
  async reporteConsolidado(periodoId: string, incluirOcultas = false) {
    const [periodo, todos] = await Promise.all([
      this.prisma.periodoComision.findUnique({ where: { id: periodoId } }),
      this.prisma.resultadoComision.findMany({
        where: { periodoId },
        include: { vendedora: true },
        orderBy: { totalUsd: 'desc' },
      }),
    ]);

    if (!periodo) {
      throw new ConflictException(`Periodo ${periodoId} no encontrado`);
    }

    /*
     * Vendedoras dadas de baja: se quitan de la LISTA, no de la base.
     *
     * El filtro se aplica aquí y no en la consulta a propósito. Este método es
     * el único origen de las cuatro hojas del Excel que van por persona
     * (Liquidación, Tipo A (RA), Planes por Vendedora y la hoja de cada una) y
     * de la planilla en pantalla: filtrando en un solo punto, ninguna de esas
     * vistas se puede olvidar de hacerlo. Y trayéndolas igual se puede decir
     * CUÁNTAS y CUÁLES se dejaron fuera, que es lo que evita que un total
     * parezca cuadrar cuando en realidad falta gente.
     *
     * Los totales se recalculan sobre lo que de verdad se devuelve: un informe
     * cuyo pie no sea la suma de sus filas es peor que uno incompleto.
     *
     * `oculta` NO toca el cálculo (ver `calcular()`, que sigue liquidando a
     * todo el mundo activo): las liquidaciones de los meses en que sí trabajó
     * siguen guardadas y se pueden recuperar marcando "incluir ocultas".
     */
    const ocultas = todos
      .filter(r => r.vendedora.oculta)
      .map(r => ({
        vendedoraId: r.vendedoraId,
        nombre: r.vendedora.nombre,
        codigo: r.vendedora.codigo,
        motivoOculta: r.vendedora.motivoOculta,
        totalGanado: Number(r.totalGanado),
      }));

    const resultados = incluirOcultas ? todos : todos.filter(r => !r.vendedora.oculta);

    const totales = resultados.reduce(
      (acc, r) => ({
        montoVendido: acc.montoVendido + Number(r.montoVendido),
        baseCalculo: acc.baseCalculo + Number(r.baseCalculo),
        comisionA: acc.comisionA + Number(r.comisionA),
        comisionB: acc.comisionB + Number(r.comisionB),
        comisionC: acc.comisionC + Number(r.comisionC),
        comisionTipoARA: acc.comisionTipoARA + Number(r.comisionTipoARA),
        bonos: acc.bonos + sumaBonos(r),
        /* Aparte del total de bonos: es el que administración cuadra contra su
           tabla de promedios trimestrales, y sumado a los otros dos no se puede
           cotejar. */
        bonoTrimestral: acc.bonoTrimestral + Number(r.bonoTrimestral),
        totalUsd: acc.totalUsd + Number(r.totalUsd),
        totalBob: acc.totalBob + Number(r.totalBob),
        /* El sueldo CONGELADO en el resultado, no el actual de la vendedora.
           `ResultadoComision.sueldoBase` es la foto del momento en que se
           liquidó, y es con esa foto con la que se calculó cada `totalGanado`
           (ver más arriba: totalBob + sueldoBase). Sumar aquí
           `vendedora.sueldoBase` —el dato maestro, que administración puede
           cambiar cualquier día— hace que en cuanto alguien recibe un aumento
           el pie deje de cuadrar con la suma de las filas y con el total
           ganado, en un periodo ya cerrado y pagado. Las filas de este mismo
           reporte usan `r.sueldoBase`. */
        sueldoBase: acc.sueldoBase + Number(r.sueldoBase),
        totalGanado: acc.totalGanado + Number(r.totalGanado),
      }),
      {
        montoVendido: 0,
        baseCalculo: 0,
        comisionA: 0,
        comisionB: 0,
        comisionC: 0,
        comisionTipoARA: 0,
        bonos: 0,
        bonoTrimestral: 0,
        totalUsd: 0,
        totalBob: 0,
        sueldoBase: 0,
        totalGanado: 0,
      },
    );

    return {
      periodo,
      /** Las que están dadas de baja y tienen liquidación en ESTE periodo. */
      ocultas,
      /** true = las de arriba van incluidas en `filas` y en `totales`. */
      incluyeOcultas: incluirOcultas,
      filas: resultados.map(r => ({
        vendedoraId: r.vendedoraId,
        nombre: r.vendedora.nombre,
        codigo: r.vendedora.codigo,
        tipo: r.vendedora.tipo,
        area: r.vendedora.area,
        /** Solo puede venir en true si se pidió incluirlas. */
        oculta: r.vendedora.oculta,
        ocultaDesde: r.vendedora.ocultaDesde,
        motivoOculta: r.vendedora.motivoOculta,
        montoVendido: Number(r.montoVendido),
        baseCalculo: Number(r.baseCalculo),
        planesVendidos: r.planesVendidos,
        cumpleObjetivoPlanes: r.cumpleObjetivoPlanes,
        planpaqVendidos: r.planpaqVendidos,
        planpaqComisionables: r.planpaqComisionables,
        planninVendidos: r.planninVendidos,
        planninComisionables: r.planninComisionables,
        acumuladoCirugias: Number(r.acumuladoCirugias),
        nivelCirugia: r.nivelCirugia,
        ingresoMaternidadTipoARA: Number(r.ingresoMaternidadTipoARA),
        ingresoRATipoARA: Number(r.ingresoRATipoARA),
        excedenteTipoARA: Number(r.excedenteTipoARA),
        nivelTipoARA: r.nivelTipoARA,
        comisionA: Number(r.comisionA),
        comisionB: Number(r.comisionB),
        comisionC: Number(r.comisionC),
        comisionTipoARA: Number(r.comisionTipoARA),
        bonoJefatura: Number(r.bonoJefatura),
        bonoPublicidad: Number(r.bonoPublicidad),
        bonoTrimestral: Number(r.bonoTrimestral),
        /// Ya sumados: si cada plantilla los sumara por su cuenta, añadir un
        /// cuarto bono obligaría a acordarse de todas.
        totalBonos: redondear(sumaBonos(r)),
        totalUsd: Number(r.totalUsd),
        totalBob: Number(r.totalBob),
        sueldoBase: Number(r.sueldoBase),
        totalGanado: Number(r.totalGanado),
        // Porcentaje efectivo de comisión sobre lo vendido.
        pctComision:
          Number(r.montoVendido) > 0
            ? redondear((Number(r.totalBob) / Number(r.montoVendido)) * 100)
            : 0,
      })),
      totales: Object.fromEntries(
        Object.entries(totales).map(([k, v]) => [k, redondear(v)]),
      ),
    };
  }

  /** Detalle de una vendedora: su desglose por clasificación y canal. */
  async reportePorVendedora(periodoId: string, vendedoraId: string) {
    const resultado = await this.prisma.resultadoComision.findUnique({
      where: { periodoId_vendedoraId: { periodoId, vendedoraId } },
      include: { vendedora: true, periodo: true },
    });

    if (!resultado) {
      throw new ConflictException('Esa vendedora no tiene liquidación en este periodo');
    }

    return {
      vendedora: resultado.vendedora,
      periodo: resultado.periodo,
      resumen: {
        montoVendido: Number(resultado.montoVendido),
        baseCalculo: Number(resultado.baseCalculo),
        planesVendidos: resultado.planesVendidos,
        cumpleObjetivoPlanes: resultado.cumpleObjetivoPlanes,
        acumuladoCirugias: Number(resultado.acumuladoCirugias),
        nivelCirugia: resultado.nivelCirugia,
        nivelTipoARA: resultado.nivelTipoARA,
        comisionA: Number(resultado.comisionA),
        comisionB: Number(resultado.comisionB),
        comisionC: Number(resultado.comisionC),
        comisionTipoARA: Number(resultado.comisionTipoARA),
        bonoJefatura: Number(resultado.bonoJefatura),
        bonoPublicidad: Number(resultado.bonoPublicidad),
        bonoTrimestral: Number(resultado.bonoTrimestral),
        totalUsd: Number(resultado.totalUsd),
        totalBob: Number(resultado.totalBob),
        sueldoBase: Number(resultado.sueldoBase),
        totalGanado: Number(resultado.totalGanado),
      },
      desglose: (resultado.desglose ?? []) as unknown as LineaDesglose[],
    };
  }

  /**
   * Todas las líneas de desglose (por tipo/canal/unidad de negocio) de TODAS
   * las vendedoras liquidadas, en una sola lista — la misma fuente que la
   * hoja "Desglose por tipo y sección" del Excel (`exportacion-comisiones.
   * service.ts`), para que administración pueda filtrar por un cubo
   * concreto ("¿cuánto cobramos de Tipo B este mes?") y ver la sumatoria sin
   * abrir el archivo.
   *
   * `subtipo` resuelve aquí, no en el frontend, la ambigüedad real de
   * `LineaDesglose.tipo`: 'A' sale tanto de un plan de maternidad/varios
   * como de una consulta/lab/eco/otros del área RA — son dos bolsas con
   * reglas de tarifa distintas (por plan elegido vs. por nivel mensual) que
   * comparten letra porque así las marca `PARAMETROS` en la planilla de
   * administración (columna `TIPO COMISION`). Confundirlas al filtrar es
   * exactamente el tipo de error que esta lista existe para evitar.
   */
  async reporteDesglose(
    periodoId: string,
    incluirOcultas = false,
  ): Promise<{ filas: LineaDesgloseVendedora[] }> {
    /* Cada línea lleva el nombre de su vendedora, así que esta lista también es
       un informe "por persona" y respeta la baja igual que el consolidado. Si no
       lo hiciera, la vendedora oculta desaparecería de la planilla de arriba y
       seguiría apareciendo en el desglose de la misma pantalla. */
    const resultados = await this.prisma.resultadoComision.findMany({
      where: { periodoId, ...(incluirOcultas ? {} : { vendedora: { oculta: false } }) },
      include: { vendedora: true },
      orderBy: { vendedora: { nombre: 'asc' } },
    });

    const filas: LineaDesgloseVendedora[] = [];
    for (const r of resultados) {
      const desglose = (r.desglose ?? []) as unknown as LineaDesglose[];
      for (const d of desglose) {
        filas.push({
          ...d,
          vendedoraId: r.vendedoraId,
          vendedoraNombre: r.vendedora.nombre,
          vendedoraCodigo: r.vendedora.codigo,
          subtipo: d.tipo === 'A' && d.unidadNegocio === UnidadNegocio.RA ? 'A_RA' : d.tipo,
        });
      }
    }

    return { filas };
  }

  /** Planilla final lista para pagar: comisiones + bonos + sueldo, por persona. */
  async reportePlanilla(periodoId: string) {
    const consolidado = await this.reporteConsolidado(periodoId);
    return {
      periodo: consolidado.periodo,
      personas: consolidado.filas.map(f => ({
        nombre: f.nombre,
        codigo: f.codigo,
        tipo: f.tipo,
        area: f.area,
        comisionTipoAUsd: f.comisionA,
        comisionTipoBUsd: f.comisionB,
        comisionTipoCUsd: f.comisionC,
        comisionTipoARAUsd: f.comisionTipoARA,
        bonoJefaturaUsd: f.bonoJefatura,
        bonoPublicidadUsd: f.bonoPublicidad,
        bonoTrimestralUsd: f.bonoTrimestral,
        totalComisionUsd: f.totalUsd,
        totalComisionBob: f.totalBob,
        sueldoBaseBob: f.sueldoBase,
        totalGanadoBob: f.totalGanado,
      })),
      totales: consolidado.totales,
    };
  }

  /** Reporte de bonos: quién cumplió, quién no y cuánto le toca. */
  async reporteBonos(periodoId: string) {
    const consolidado = await this.reporteConsolidado(periodoId);
    return {
      periodo: consolidado.periodo,
      bonos: consolidado.filas.map(f => ({
        nombre: f.nombre,
        tipo: f.tipo,
        area: f.area,
        montoVendido: f.montoVendido,
        planesVendidos: f.planesVendidos,
        cumpleObjetivoPlanes: f.cumpleObjetivoPlanes,
        bonoJefatura: f.bonoJefatura,
        bonoPublicidad: f.bonoPublicidad,
        bonoTrimestral: f.bonoTrimestral,
        totalBonos: redondear(sumaBonos(f)),
      })),
    };
  }
}
