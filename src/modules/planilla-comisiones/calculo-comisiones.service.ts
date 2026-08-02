import { ConflictException, Injectable, Logger } from '@nestjs/common';
import {
  AreaVendedora,
  CanalVenta,
  ClasifComision,
  EstadoPeriodo,
  TipoVendedora,
  UnidadNegocio,
  VendedoraComision,
} from '@prisma/client';

import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizar, redondear } from './clasificador';
import {
  ConfiguracionCompleta,
  ConfiguracionComisionesService,
} from './configuracion-comisiones.service';
import { PARAM } from './configuracion-por-defecto';

/** Una fila del periodo, con lo mínimo que el cálculo necesita. */
interface FilaCalculo {
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

    const config = await this.configuracion.cargarConfiguracion();
    // Las metas pueden ser propias de este mes; si no lo son, rigen las de por
    // defecto. Se resuelve antes de liquidar para que toda la pasada use las mismas.
    config.objetivos = await this.configuracion.objetivosParaPeriodo(periodoId);
    const tipoCambio = Number(periodo.tipoCambio) || 1;

    const [filasCrudas, vendedoras] = await Promise.all([
      this.prisma.ventaImportada.findMany({
        where: { periodoId, comisionable: true, vendedoraId: { not: null } },
        select: {
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
    const objetivo = config.objetivos.find(o => o.tipo === vendedora.tipo);

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
    const planpaqComisionables = Math.max(0, planpaqVendidos - (objetivo?.planpaqMinimos ?? 0));
    const planninComisionables = Math.max(0, planninVendidos - (objetivo?.planninMinimos ?? 0));

    const planesVendidos = planpaqVendidos + planninVendidos;
    const cumpleObjetivoPlanes = planpaqComisionables > 0 || planninComisionables > 0;

    /*
     * Qué parte de la base de un grupo llega a comisionar. Los planes de una
     * misma clasificación se reparten en varios grupos (por nivel y por canal),
     * así que el excedente se prorratea entre ellos en proporción a la cantidad.
     *
     * PENDIENTE DE ADMINISTRACIÓN: la planilla no dice QUÉ planes concretos son
     * los que comisionan cuando alguien supera el objetivo (¿los más caros?,
     * ¿los últimos del mes?). El prorrateo es la interpretación neutral y
     * reproduce exacto el caso de PLANNIN de diciembre 2024
     * (2 vendidos, objetivo 1, base 1747,48 → (1747,48/2) × 1 × 3% = 26,21).
     * Con planes de distinto nivel el total puede diferir de la planilla: si
     * administración define la regla, se cambia solo esta función.
     */
    const fraccionComisionable = (clasif: ClasifComision): number => {
      if (clasif === ClasifComision.PLANPAQ) {
        return planpaqVendidos > 0 ? planpaqComisionables / planpaqVendidos : 0;
      }
      return planninVendidos > 0 ? planninComisionables / planninVendidos : 0;
    };

    // Nivel Tipo B: se fija con el acumulado de cirugías de TODO el mes.
    const acumuladoCirugias = filas
      .filter(f => f.clasif === ClasifComision.CIRUGIA)
      .reduce((s, f) => s + f.ingresoNeto, 0);
    const nivelCirugia = this.resolverNivelCirugia(acumuladoCirugias, config);

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
        // La tarifa es la de la tabla; lo que se acota es la BASE, porque solo
        // comisionan los planes por encima del objetivo.
        comisionBob = (baseGrupo * fraccionComisionable(primera.clasif) * porcentaje) / 100;
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
    const clave = fila.clasif === ClasifComision.PLANNIN ? 'PLANNIN' : (fila.nivel ?? 'SILVER');
    const tarifa = config.tarifasPlan.find(t => t.clave === clave);
    if (!tarifa) return 0;
    return Number(fila.canal === CanalVenta.PROPIO ? tarifa.pctPropio : tarifa.pctEmpresa);
  }

  private porcentajeTipoB(
    nivel: number | null,
    canal: CanalVenta,
    config: ConfiguracionCompleta,
  ): number {
    if (nivel === null) return 0;
    const escala = config.nivelesCirugia.find(n => n.nivel === nivel);
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
    const tarifa = config.tarifasServicio.find(t => t.clasif === fila.clasif);
    if (!tarifa) return 0;
    return Number(fila.canal === CanalVenta.PROPIO ? tarifa.pctPropio : tarifa.pctEmpresa);
  }

  /** Ubica el acumulado de cirugías del mes en la escala; null si no llega al nivel 1. */
  private resolverNivelCirugia(acumulado: number, config: ConfiguracionCompleta): number | null {
    for (const escala of config.nivelesCirugia) {
      const desde = Number(escala.montoDesde);
      const hasta = Number(escala.montoHasta);
      if (acumulado >= desde && acumulado <= hasta) return escala.nivel;
    }
    // Por encima del último tramo se aplica el nivel más alto.
    const ultimo = config.nivelesCirugia[config.nivelesCirugia.length - 1];
    if (ultimo && acumulado > Number(ultimo.montoHasta)) return ultimo.nivel;
    return null;
  }

  /** Tarifa RA que corresponde al procedimiento, cruzando por nombre. */
  private tarifaRA(
    grupo: readonly FilaCalculo[],
    canal: CanalVenta,
    config: ConfiguracionCompleta,
  ): { montoUnitario: number; esPorcentaje: boolean } {
    const detalle = normalizar(grupo[0].detalle);
    const tarifa = config.tarifasRA.find(t => {
      // Se cruza por las palabras significativas del nombre del procedimiento.
      const claves = normalizar(t.procedimiento)
        .split(/[^A-ZÑ0-9]+/)
        .filter(p => p.length > 3);
      return claves.some(clave => detalle.includes(clave));
    });

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
    let pote = 0;

    for (const resultado of resultados) {
      const { vendedora, registro } = resultado;
      const objetivo = config.objetivos.find(o => o.tipo === vendedora.tipo);
      if (!objetivo) continue;

      const vendidoUsd = registro.montoVendido / tipoCambio;
      if (vendidoUsd > Number(objetivo.montoMensualUsd)) {
        pote += (registro.baseCalculo / tipoCambio) * factorJefatura;
      }

      /* Bono trimestral: promedio de ventas de los últimos meses, en USD. */
      const promedioUsd = await this.promedioVentasUsd(vendedora.id, anio, mes, mesesTrimestre);
      if (promedioUsd > Number(objetivo.montoTrimestralUsd)) {
        registro.bonoTrimestral = redondear(promedioUsd * factorTrimestral);
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
  private async promedioVentasUsd(
    vendedoraId: string,
    anio: number,
    mes: number,
    meses: number,
  ): Promise<number> {
    const desde = new Date(anio, mes - meses, 1);
    const periodos = await this.prisma.periodoComision.findMany({
      where: {
        OR: [
          { anio: { gt: desde.getFullYear() } },
          { anio: desde.getFullYear(), mes: { gte: desde.getMonth() + 1 } },
        ],
        AND: [{ OR: [{ anio: { lt: anio } }, { anio, mes: { lte: mes } }] }],
      },
      select: { id: true, tipoCambio: true },
    });

    if (periodos.length === 0) return 0;

    const resultados = await this.prisma.resultadoComision.findMany({
      where: { vendedoraId, periodoId: { in: periodos.map(p => p.id) } },
      select: { montoVendido: true, periodoId: true },
    });

    const tcPorPeriodo = new Map(periodos.map(p => [p.id, Number(p.tipoCambio) || 1]));
    const totalUsd = resultados.reduce(
      (s, r) => s + Number(r.montoVendido) / (tcPorPeriodo.get(r.periodoId) ?? 1),
      0,
    );

    return totalUsd / meses;
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
        bonos:
          acc.bonos +
          Number(r.bonoJefatura) +
          Number(r.bonoPublicidad) +
          Number(r.bonoTrimestral),
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
        totalBonos: redondear(f.bonoJefatura + f.bonoPublicidad + f.bonoTrimestral),
      })),
    };
  }
}
