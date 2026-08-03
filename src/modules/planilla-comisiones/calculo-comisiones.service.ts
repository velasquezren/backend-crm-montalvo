import { ConflictException, Injectable, Logger } from '@nestjs/common';
import {
  AreaVendedora,
  CanalVenta,
  ClasifComision,
  EstadoPeriodo,
  UnidadNegocio,
  VendedoraComision,
} from '@prisma/client';

import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { redondear } from './clasificador';
import {
  cierraTrimestre,
  elegirTarifaRA,
  PlanCandidato,
  seleccionarPlanesComisionables,
  mesesAnteriores,
  planesComisionables,
  resolverNivelCirugia,
  sumaBonos,
} from './reglas-calculo';
import {
  ConfiguracionCompleta,
  ConfiguracionComisionesService,
} from './configuracion-comisiones.service';
import { PARAM } from './configuracion-por-defecto';

/** Una fila del periodo, con lo mínimo que el cálculo necesita. */
interface FilaCalculo {
  id: string;
  /** Decisión manual de administración sobre si este plan comisiona. */
  comisionaPlan: boolean | null;
  vendedoraId: string;
  canal: CanalVenta;
  clasif: ClasifComision;
  unidadNegocio: UnidadNegocio;
  nivel: string | null;
  detalle: string;
  ingresoNeto: number;
  precio: number;
}

/** Desglose que se guarda en `ResultadoComision.desglose` para el reporte. */
export interface LineaDesglose {
  clasif: ClasifComision;
  canal: CanalVenta;
  unidadNegocio: UnidadNegocio;
  cantidad: number;
  montoVendido: number;
  baseCalculo: number;
  porcentaje: number;
  comisionUsd: number;
  tipo: 'A' | 'B' | 'C';
}

/**
 * Motor de liquidación de la planilla.
 *
 * Convenciones de moneda, explícitas porque el documento de negocio mezcla:
 *  • La base de cálculo y los montos vendidos vienen del Excel, en **BOB**.
 *  • Los porcentajes (A, B ejecutivas, C) se aplican sobre esa base en BOB y el
 *    resultado se convierte a **USD** con el TC del periodo.
 *  • Las tarifas RA son **USD fijos por procedimiento**, así que no se convierten.
 *  • Los objetivos y bonos se evalúan en **USD**.
 * Todo esto es configurable desde `ParametroComision` salvo el sentido de la
 * conversión, que es el del propio reporte final (Comisión USD → × TC → BOB).
 */
/** Los planes de una clasificación, en el formato que espera la regla pura. */
function candidatos(filas: readonly FilaCalculo[], clasif: ClasifComision): PlanCandidato[] {
  return filas
    .filter(f => f.clasif === clasif)
    .map(f => ({ id: f.id, base: f.ingresoNeto, comisionaPlan: f.comisionaPlan }));
}

@Injectable()
export class CalculoComisionesService {
  private readonly logger = new Logger(CalculoComisionesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configuracion: ConfiguracionComisionesService,
    private readonly audit: AuditService,
  ) {}

  /** Liquida el periodo completo y persiste un `ResultadoComision` por vendedora. */
  async calcular(periodoId: string, usuarioId: string) {
    const periodo = await this.prisma.periodoComision.findUnique({ where: { id: periodoId } });
    if (!periodo) {
      throw new ConflictException(`Periodo ${periodoId} no encontrado`);
    }
    if (periodo.estado === EstadoPeriodo.CERRADO) {
      throw new ConflictException('El periodo está CERRADO: reábrelo para recalcular');
    }

    // La config se pide POR PERIODO: trae ya resueltas las metas que rigen este
    // mes, sean las propias o las base.
    const config = await this.configuracion.cargarConfiguracion(periodoId);
    const tipoCambio = Number(periodo.tipoCambio) || 1;

    const [filasCrudas, vendedoras] = await Promise.all([
      this.prisma.ventaImportada.findMany({
        where: { periodoId, comisionable: true, vendedoraId: { not: null } },
        select: {
          id: true,
          comisionaPlan: true,
          vendedoraId: true,
          canal: true,
          clasif: true,
          unidadNegocio: true,
          nivel: true,
          detalle: true,
          ingresoNeto: true,
          precio: true,
        },
      }),
      this.prisma.vendedoraComision.findMany({ where: { activa: true } }),
    ]);

    const filas: FilaCalculo[] = filasCrudas.map(f => ({
      id: f.id,
      comisionaPlan: f.comisionaPlan,
      vendedoraId: f.vendedoraId as string,
      canal: f.canal,
      clasif: f.clasif,
      unidadNegocio: f.unidadNegocio,
      nivel: f.nivel,
      detalle: f.detalle,
      ingresoNeto: Number(f.ingresoNeto),
      precio: Number(f.precio),
    }));

    const porVendedora = new Map<string, FilaCalculo[]>();
    for (const fila of filas) {
      const lista = porVendedora.get(fila.vendedoraId);
      if (lista) lista.push(fila);
      else porVendedora.set(fila.vendedoraId, [fila]);
    }

    const resultados = [];
    for (const vendedora of vendedoras) {
      const suyas = porVendedora.get(vendedora.id) ?? [];
      if (suyas.length === 0) continue;
      resultados.push(this.liquidarVendedora(vendedora, suyas, config, tipoCambio));
    }

    // Los bonos dependen del total del equipo, así que van en una segunda pasada.
    await this.aplicarBonos(resultados, config, periodo.anio, periodo.mes, tipoCambio);

    await this.prisma.$transaction([
      this.prisma.resultadoComision.deleteMany({ where: { periodoId } }),
      this.prisma.resultadoComision.createMany({
        data: resultados.map(r => ({ ...r.registro, periodoId })),
      }),
      this.prisma.periodoComision.update({
        where: { id: periodoId },
        data: { estado: EstadoPeriodo.CALCULADO, calculadoEn: new Date() },
      }),
    ]);

    await this.audit.registrar('PeriodoComision', periodoId, 'CALCULAR', usuarioId, {
      vendedoras: resultados.length,
      totalUsd: redondear(resultados.reduce((s, r) => s + r.registro.totalUsd, 0)),
    });

    this.logger.log(`Planilla ${periodo.mes}/${periodo.anio} calculada: ${resultados.length} vendedoras`);

    return {
      periodoId,
      vendedorasLiquidadas: resultados.length,
      totalComisionUsd: redondear(resultados.reduce((s, r) => s + r.registro.totalUsd, 0)),
      totalComisionBob: redondear(resultados.reduce((s, r) => s + r.registro.totalBob, 0)),
    };
  }

  /* ── Liquidación de una vendedora ───────────────────────────────────── */

  private liquidarVendedora(
    vendedora: VendedoraComision,
    filas: readonly FilaCalculo[],
    config: ConfiguracionCompleta,
    tipoCambio: number,
  ) {
    const objetivo = config.objetivosPorTipo.get(vendedora.tipo);

    const montoVendido = filas.reduce((s, f) => s + f.precio, 0);
    const baseCalculo = filas.reduce((s, f) => s + f.ingresoNeto, 0);

    /*
     * Objetivo Tipo A — el objetivo no es un interruptor, es una franquicia.
     * Solo comisionan los planes que lo SUPERAN: con 5 paquetes y objetivo 4,
     * comisiona 1, no los 5. E igualar el objetivo paga cero (en diciembre 2024
     * una vendedora hizo 4 de 4 y no cobró Tipo A).
     *
     * Son dos objetivos independientes, uno por tipo de plan.
     */
    const planpaqVendidos = filas.filter(f => f.clasif === ClasifComision.PLANPAQ).length;
    const planninVendidos = filas.filter(f => f.clasif === ClasifComision.PLANNIN).length;
    const planpaqComisionables = planesComisionables(planpaqVendidos, objetivo?.planpaqMinimos ?? 0);
    const planninComisionables = planesComisionables(planninVendidos, objetivo?.planninMinimos ?? 0);

    const planesVendidos = planpaqVendidos + planninVendidos;
    const cumpleObjetivoPlanes = planpaqComisionables > 0 || planninComisionables > 0;

    /*
     * Qué planes CONCRETOS comisionan. No se prorratea: en la planilla se marca
     * el plan elegido y se le paga su base completa con la tarifa de su nivel
     * (hoja `Ejecutivas`, columna AR: `=SI(AQ="COMISIONA"; % × base; 0)`).
     * `seleccionarPlanesComisionables` respeta lo que administración marcó y
     * completa el resto con el criterio automático.
     */
    const seleccionPlanpaq = seleccionarPlanesComisionables(
      candidatos(filas, ClasifComision.PLANPAQ),
      objetivo?.planpaqMinimos ?? 0,
    );
    const seleccionPlannin = seleccionarPlanesComisionables(
      candidatos(filas, ClasifComision.PLANNIN),
      objetivo?.planninMinimos ?? 0,
    );
    const planesElegidos = new Set([...seleccionPlanpaq.elegidos, ...seleccionPlannin.elegidos]);

    // Nivel Tipo B: se fija con el acumulado de cirugías de TODO el mes.
    const acumuladoCirugias = filas
      .filter(f => f.clasif === ClasifComision.CIRUGIA)
      .reduce((s, f) => s + f.ingresoNeto, 0);
    const nivelCirugia = resolverNivelCirugia(acumuladoCirugias, config.nivelesCirugia);

    const esCoordinadoraRA = vendedora.area === AreaVendedora.RA;
    const desglose: LineaDesglose[] = [];

    let comisionA = 0;
    let comisionB = 0;
    let comisionC = 0;

    for (const [clave, grupo] of this.agrupar(filas)) {
      void clave;
      const primera = grupo[0];
      const montoGrupo = grupo.reduce((s, f) => s + f.precio, 0);
      const baseGrupo = grupo.reduce((s, f) => s + f.ingresoNeto, 0);

      let porcentaje = 0;
      let comisionBob = 0;
      let comisionUsd = 0;
      let tipo: 'A' | 'B' | 'C' = 'C';

      if (primera.clasif === ClasifComision.PLANPAQ || primera.clasif === ClasifComision.PLANNIN) {
        tipo = 'A';
        porcentaje = this.porcentajeTipoA(primera, config);
        // Solo los planes elegidos comisionan, y lo hacen por su base completa.
        const baseElegida = grupo
          .filter(f => planesElegidos.has(f.id))
          .reduce((s, f) => s + f.ingresoNeto, 0);
        comisionBob = (baseElegida * porcentaje) / 100;
        comisionUsd = comisionBob / tipoCambio;
        comisionA += comisionUsd;
      } else if (primera.clasif === ClasifComision.CIRUGIA) {
        tipo = 'B';
        if (esCoordinadoraRA) {
          // Tarifa fija en USD por procedimiento (ya en dólares).
          const { montoUnitario, esPorcentaje } = this.tarifaRA(grupo, primera.canal, config);
          if (esPorcentaje) {
            porcentaje = montoUnitario;
            comisionUsd = (baseGrupo * porcentaje) / 100 / tipoCambio;
          } else {
            comisionUsd = montoUnitario * grupo.length;
          }
        } else {
          porcentaje = this.porcentajeTipoB(nivelCirugia, primera.canal, config);
          comisionBob = (baseGrupo * porcentaje) / 100;
          comisionUsd = comisionBob / tipoCambio;
        }
        comisionB += comisionUsd;
      } else {
        tipo = 'C';
        porcentaje = this.porcentajeTipoC(primera, config, esCoordinadoraRA);
        comisionBob = (baseGrupo * porcentaje) / 100;
        comisionUsd = comisionBob / tipoCambio;
        comisionC += comisionUsd;
      }

      desglose.push({
        clasif: primera.clasif,
        canal: primera.canal,
        unidadNegocio: primera.unidadNegocio,
        cantidad: grupo.length,
        montoVendido: redondear(montoGrupo),
        baseCalculo: redondear(baseGrupo),
        porcentaje: redondear(porcentaje),
        comisionUsd: redondear(comisionUsd),
        tipo,
      });
    }

    const sueldoBase = Number(vendedora.sueldoBase);

    return {
      vendedora,
      desglose,
      registro: {
        vendedoraId: vendedora.id,
        montoVendido: redondear(montoVendido),
        baseCalculo: redondear(baseCalculo),
        planesVendidos,
        cumpleObjetivoPlanes,
        planpaqVendidos,
        planpaqComisionables,
        planninVendidos,
        planninComisionables,
        acumuladoCirugias: redondear(acumuladoCirugias),
        nivelCirugia,
        comisionA: redondear(comisionA),
        comisionB: redondear(comisionB),
        comisionC: redondear(comisionC),
        bonoJefatura: 0,
        bonoPublicidad: 0,
        bonoTrimestral: 0,
        totalUsd: redondear(comisionA + comisionB + comisionC),
        totalBob: redondear((comisionA + comisionB + comisionC) * tipoCambio),
        sueldoBase: redondear(sueldoBase),
        totalGanado: redondear((comisionA + comisionB + comisionC) * tipoCambio + sueldoBase),
        desglose: desglose as unknown as object,
      },
    };
  }

  /** Agrupa por clasificación + canal + unidad de negocio + nivel. */
  private agrupar(filas: readonly FilaCalculo[]): Map<string, FilaCalculo[]> {
    const mapa = new Map<string, FilaCalculo[]>();
    for (const fila of filas) {
      const clave = `${fila.clasif}|${fila.canal}|${fila.unidadNegocio}|${fila.nivel ?? '-'}`;
      const lista = mapa.get(clave);
      if (lista) lista.push(fila);
      else mapa.set(clave, [fila]);
    }
    return mapa;
  }

  /* ── Porcentajes por tipo ───────────────────────────────────────────── */

  private porcentajeTipoA(fila: FilaCalculo, config: ConfiguracionCompleta): number {
    // Los planes de maternidad cobran por nivel; los planes varios, por PLANNIN.
    let clave: string;
    if (fila.clasif === ClasifComision.PLANNIN) {
      clave = 'PLANNIN';
    } else if (fila.nivel) {
      clave = fila.nivel;
    } else {
      // Un paquete de maternidad sin nivel legible se paga como SILVER, que es
      // el tramo intermedio. Es una suposición sobre dinero, así que se avisa:
      // administración puede añadir una regla al diccionario para que el nivel
      // salga del catálogo en vez de adivinarse.
      clave = 'SILVER';
      this.logger.warn(
        `Paquete sin nivel detectado, se paga como SILVER: "${fila.detalle}". ` +
          'Añade una regla al diccionario para fijarle el nivel.',
      );
    }

    const tarifa = config.tarifasPlanPorClave.get(clave);
    if (!tarifa) return 0;
    return Number(fila.canal === CanalVenta.PROPIO ? tarifa.pctPropio : tarifa.pctEmpresa);
  }

  private porcentajeTipoB(
    nivel: number | null,
    canal: CanalVenta,
    config: ConfiguracionCompleta,
  ): number {
    if (nivel === null) return 0;
    const escala = config.nivelesPorNumero.get(nivel);
    if (!escala) return 0;
    return Number(canal === CanalVenta.PROPIO ? escala.pctPropio : escala.pctEmpresa);
  }

  private porcentajeTipoC(
    fila: FilaCalculo,
    config: ConfiguracionCompleta,
    esCoordinadoraRA: boolean,
  ): number {
    // Las ventas del área RA no comisionan Tipo C para ejecutivas: solo las
    // coordinadoras RA cobran por esos ítems (regla 5 de casos borde).
    if (fila.unidadNegocio === UnidadNegocio.RA && !esCoordinadoraRA) {
      return config.parametros.get(PARAM.PCT_TIPO_C_RA) ?? 0;
    }
    const tarifa = config.tarifasServicioPorClasif.get(fila.clasif);
    if (!tarifa) return 0;
    return Number(fila.canal === CanalVenta.PROPIO ? tarifa.pctPropio : tarifa.pctEmpresa);
  }

  /** Ubica el acumulado de cirugías del mes en la escala; null si no llega al nivel 1. */

  /** Tarifa RA que corresponde al procedimiento, cruzando por nombre. */
  private tarifaRA(
    grupo: readonly FilaCalculo[],
    canal: CanalVenta,
    config: ConfiguracionCompleta,
  ): { montoUnitario: number; esPorcentaje: boolean } {
    const detalle = grupo[0].detalle;

    // Gana la tarifa que cruce con MÁS texto, no la primera de la lista. Varios
    // procedimientos comparten palabras ("Histeroscopia" está dentro de
    // "Laparoscopia + Histeroscopia"), y con `find` el resultado dependía del
    // orden en que la base devolviera las filas: la misma venta podía pagar
    // distinto entre dos cálculos.
    const tarifa = elegirTarifaRA(detalle, config.tarifasRA);
    if (!tarifa) return { montoUnitario: 0, esPorcentaje: false };

    return {
      montoUnitario: Number(canal === CanalVenta.PROPIO ? tarifa.montoPropio : tarifa.montoEmpresa),
      esPorcentaje: tarifa.esPorcentaje,
    };
  }

  /* ── Bonos ──────────────────────────────────────────────────────────── */

  /**
   * Bono de jefatura (sobre el excedente del objetivo del equipo), bono
   * trimestral (promedio de los últimos meses) y reparto al equipo de publicidad.
   * Muta los registros ya liquidados y recalcula sus totales.
   */
  private async aplicarBonos(
    resultados: ReturnType<CalculoComisionesService['liquidarVendedora']>[],
    config: ConfiguracionCompleta,
    anio: number,
    mes: number,
    tipoCambio: number,
  ): Promise<void> {
    if (resultados.length === 0) return;

    const factorJefatura = config.parametros.get(PARAM.FACTOR_BONO_JEFATURA) ?? 0.002;
    const factorTrimestral = config.parametros.get(PARAM.FACTOR_BONO_TRIMESTRAL) ?? 0.005;
    const mesesTrimestre = Math.max(1, config.parametros.get(PARAM.MESES_BONO_TRIMESTRAL) ?? 3);

    /*
     * Pote de jefatura. Contra lo que sugiere el nombre, no lo cobra la jefa:
     * es una bolsa que genera el equipo comercial y que termina íntegra en el
     * área de publicidad. En la planilla de diciembre 2024 la columna
     * "BONO A PAGAR" de TODAS las vendedoras —incluidas las dos jefas, Viviana
     * y Maricela— está en cero, y el total aparece repartido en partes iguales
     * entre las tres personas de publicidad.
     *
     * Cada vendedora aporta al pote `su ingreso neto × factor`, y solo si ella
     * superó SU propio objetivo de monto (la jefa 15.000, las vendedoras
     * 12.000). No es el excedente sobre el objetivo: es el neto completo.
     *
     *   Viviana  31.568,42 × 0,2% = 63,14
     *   Zuany    14.005,37 × 0,2% = 28,01
     *   Claudia  13.015,66 × 0,2% = 26,03   (Yelca no llegó a 12.000 → 0)
     *   pote = 117,18 → 39,06 para cada una de las 3 de publicidad
     */
    // Una sola consulta para todo el equipo, en vez de dos por vendedora dentro
    // del bucle. Con 5 vendedoras eran 10 viajes a la base, uno detrás de otro.
    const promedios = await this.promediosDelTrimestre(resultados, anio, mes, mesesTrimestre);

    let pote = 0;

    for (const resultado of resultados) {
      const { vendedora, registro } = resultado;
      const objetivo = config.objetivosPorTipo.get(vendedora.tipo);
      if (!objetivo) continue;

      /*
       * Los objetivos se comparan contra el monto EN BOLIVIANOS, sin convertir.
       * Verificado en la planilla ("CALCULO BONOS", fila 15): a Viviana le
       * contrastan 36.285,54 contra el objetivo 15.000 y la diferencia que
       * anotan es 21.285,54 — resta directa, sin tipo de cambio. Y el aporte al
       * pote es el neto por el factor: 31.568,42 × 0,002 = 63,14.
       *
       * Dividir antes entre el TC hacía el umbral siete veces más exigente: con
       * los tres meses reales de 2026 nadie lo alcanzaba nunca y el bono salía
       * siempre en cero.
       */
      if (registro.montoVendido > Number(objetivo.montoMensualUsd)) {
        pote += registro.baseCalculo * factorJefatura;
      }

      /*
       * El promedio del trimestre es solo el requisito; lo que se paga es el
       * 0,5 % del MES que se liquida. En el consolidado de la planilla Viviana
       * cobró 181,43 = 36.285,54 × 0,005 (su diciembre), no el promedio.
       */
      const promedio = promedios.get(vendedora.id) ?? 0;
      if (cierraTrimestre(mes) && promedio > Number(objetivo.montoTrimestralUsd)) {
        registro.bonoTrimestral = redondear(registro.montoVendido * factorTrimestral);
      }
    }

    /* El pote completo va a publicidad, en partes iguales. */
    const publicidad = resultados.filter(r => r.vendedora.area === AreaVendedora.PUBLICIDAD);
    if (publicidad.length > 0 && pote > 0) {
      const porPersona = redondear(pote / publicidad.length);
      for (const { registro } of publicidad) {
        registro.bonoPublicidad = porPersona;
      }
    }

    // Recalcular totales ya con los bonos incluidos.
    for (const { registro } of resultados) {
      registro.totalUsd = redondear(
        registro.comisionA +
          registro.comisionB +
          registro.comisionC +
          registro.bonoJefatura +
          registro.bonoPublicidad +
          registro.bonoTrimestral,
      );
      registro.totalBob = redondear(registro.totalUsd * tipoCambio);
      registro.totalGanado = redondear(registro.totalBob + registro.sueldoBase);
    }
  }

  /**
   * Promedio de venta mensual (USD) de una vendedora en los últimos N meses,
   * incluyendo el actual. Usa el histórico ya liquidado de periodos anteriores.
   */
  /**
   * Promedio de ventas mensuales (USD) del trimestre, por vendedora.
   *
   * Dos cosas que no son obvias y que la planilla deja claras:
   *
   *  1. **Cuenta el mes que se está liquidando.** Sus resultados todavía no
   *     están en la base —se guardan al final de `calcular()`— así que se toman
   *     de memoria. Antes se leían de `ResultadoComision` y el mes en curso
   *     quedaba fuera: en la primera liquidación el promedio salía de los dos
   *     meses anteriores, y al recalcular usaba las cifras viejas.
   *
   *  2. **Divide entre los meses CON datos, no siempre entre tres.** Quien
   *     empezó a mitad del trimestre no debe ver su promedio partido por meses
   *     en los que no existía: en diciembre 2024 una vendedora con un solo mes
   *     cargado promedió ese mes completo, no un tercio.
   */
  private async promediosDelTrimestre(
    resultados: ReturnType<CalculoComisionesService['liquidarVendedora']>[],
    anio: number,
    mes: number,
    meses: number,
  ): Promise<Map<string, number>> {
    /* Todo en bolivianos: es la moneda en la que la planilla compara contra el
       objetivo trimestral (15.000). Convertir a dólares hacía el umbral siete
       veces más alto y el bono no se pagaba nunca. */
    const acumulado = new Map<string, { total: number; meses: number }>();

    // El mes en curso, desde memoria.
    for (const { vendedora, registro } of resultados) {
      acumulado.set(vendedora.id, { total: registro.montoVendido, meses: 1 });
    }

    // Los meses anteriores de la ventana, en una sola pasada.
    const anteriores = mesesAnteriores(anio, mes, meses);
    if (anteriores.length > 0) {
      const periodos = await this.prisma.periodoComision.findMany({
        where: { OR: anteriores },
        select: { id: true, tipoCambio: true },
      });

      if (periodos.length > 0) {
        const previos = await this.prisma.resultadoComision.findMany({
          where: {
            periodoId: { in: periodos.map(p => p.id) },
            vendedoraId: { in: [...acumulado.keys()] },
          },
          select: { vendedoraId: true, montoVendido: true },
        });

        for (const fila of previos) {
          const actual = acumulado.get(fila.vendedoraId);
          if (!actual) continue;
          actual.total += Number(fila.montoVendido);
          actual.meses += 1;
        }
      }
    }

    return new Map(
      [...acumulado].map(([id, { total, meses: n }]) => [id, n > 0 ? total / n : 0]),
    );
  }


  /* ── Reportes ───────────────────────────────────────────────────────── */

  /** Consolidado del periodo: una fila por vendedora + totales del equipo. */
  async reporteConsolidado(periodoId: string) {
    const [periodo, resultados] = await Promise.all([
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

    const totales = resultados.reduce(
      (acc, r) => ({
        montoVendido: acc.montoVendido + Number(r.montoVendido),
        baseCalculo: acc.baseCalculo + Number(r.baseCalculo),
        comisionA: acc.comisionA + Number(r.comisionA),
        comisionB: acc.comisionB + Number(r.comisionB),
        comisionC: acc.comisionC + Number(r.comisionC),
        bonos: acc.bonos + sumaBonos(r),
        totalUsd: acc.totalUsd + Number(r.totalUsd),
        totalBob: acc.totalBob + Number(r.totalBob),
        totalGanado: acc.totalGanado + Number(r.totalGanado),
      }),
      {
        montoVendido: 0,
        baseCalculo: 0,
        comisionA: 0,
        comisionB: 0,
        comisionC: 0,
        bonos: 0,
        totalUsd: 0,
        totalBob: 0,
        totalGanado: 0,
      },
    );

    return {
      periodo,
      filas: resultados.map(r => ({
        vendedoraId: r.vendedoraId,
        nombre: r.vendedora.nombre,
        codigo: r.vendedora.codigo,
        tipo: r.vendedora.tipo,
        area: r.vendedora.area,
        montoVendido: Number(r.montoVendido),
        baseCalculo: Number(r.baseCalculo),
        planesVendidos: r.planesVendidos,
        cumpleObjetivoPlanes: r.cumpleObjetivoPlanes,
        acumuladoCirugias: Number(r.acumuladoCirugias),
        nivelCirugia: r.nivelCirugia,
        comisionA: Number(r.comisionA),
        comisionB: Number(r.comisionB),
        comisionC: Number(r.comisionC),
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
        comisionA: Number(resultado.comisionA),
        comisionB: Number(resultado.comisionB),
        comisionC: Number(resultado.comisionC),
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
