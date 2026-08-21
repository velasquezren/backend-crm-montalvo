import { ConflictException, Injectable, Logger } from '@nestjs/common';
import {
  AreaVendedora,
  Prisma,
  CanalVenta,
  ClasifComision,
  EstadoPeriodo,
  TipoVendedora,
  UnidadNegocio,
  VendedoraComision,
} from '@prisma/client';

import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AnaliticaComisionesService } from './analitica-comisiones.service';
import { ResumenAnualService } from './resumen-anual.service';
import { redondear } from './clasificador';
import {
  aporteAlPoteJefatura,
  bonoTrimestralUsd,
  cierraTrimestre,
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
  /** Correlativo de registro: es lo que decide cuáles son los ÚLTIMOS planes. */
  codOrigen: string | null;
  fecha: Date | null;
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
 * Foto de las reglas con las que se liquidó un mes.
 *
 * Se guarda en el periodo porque las tarifas, los niveles y los parámetros son
 * globales: cambiarlos hoy cambiaría lo que daría recalcular enero. Los números
 * ya liquidados no se mueven —están en `ResultadoComision`—, pero sin esta foto
 * nadie puede explicar de dónde salieron.
 *
 * Se guarda solo lo que DECIDE el pago. El diccionario de clasificación y los
 * mapeos de captación quedan fuera a propósito: ya están aplicados fila por fila
 * en `VentaImportada`, que también se congela al importar.
 */
export interface FotoConfiguracion {
  readonly calculadoEn: string;
  readonly tipoCambio: number;
  readonly parametros: Record<string, number>;
  readonly objetivos: ReadonlyArray<{
    tipo: string;
    planpaqMinimos: number;
    planninMinimos: number;
    montoMensualUsd: number;
    montoTrimestralUsd: number;
  }>;
  readonly tarifasServicio: ReadonlyArray<{
    clasif: string;
    pctEmpresa: number;
    pctPropio: number;
  }>;
  readonly tarifasPlan: ReadonlyArray<{ clave: string; pctEmpresa: number; pctPropio: number }>;
  readonly nivelesCirugia: ReadonlyArray<{
    nivel: number;
    montoDesde: number;
    montoHasta: number;
    pctEmpresa: number;
    pctPropio: number;
  }>;
}

/** Arma la foto a partir de la configuración que acaba de usar el cálculo. */
function fotografiarConfiguracion(
  config: ConfiguracionCompleta,
  tipoCambio: number,
): FotoConfiguracion {
  return {
    calculadoEn: new Date().toISOString(),
    tipoCambio,
    parametros: Object.fromEntries(config.parametros),
    objetivos: config.objetivos.map(o => ({
      tipo: String(o.tipo),
      planpaqMinimos: o.planpaqMinimos,
      planninMinimos: o.planninMinimos,
      montoMensualUsd: Number(o.montoMensualUsd),
      montoTrimestralUsd: Number(o.montoTrimestralUsd),
    })),
    tarifasServicio: config.tarifasServicio.map(t => ({
      clasif: String(t.clasif),
      pctEmpresa: Number(t.pctEmpresa),
      pctPropio: Number(t.pctPropio),
    })),
    tarifasPlan: config.tarifasPlan.map(t => ({
      clave: t.clave,
      pctEmpresa: Number(t.pctEmpresa),
      pctPropio: Number(t.pctPropio),
    })),
    nivelesCirugia: config.nivelesCirugia.map(n => ({
      nivel: n.nivel,
      montoDesde: Number(n.montoDesde),
      montoHasta: Number(n.montoHasta),
      pctEmpresa: Number(n.pctEmpresa),
      pctPropio: Number(n.pctPropio),
    })),
  };
}

/** Los planes de una clasificación, en el formato que espera la regla pura. */
function candidatos(filas: readonly FilaCalculo[], clasif: ClasifComision): PlanCandidato[] {
  return filas
    .filter(f => f.clasif === clasif)
    .map(f => ({
      id: f.id,
      codOrigen: f.codOrigen,
      fecha: f.fecha,
      comisionaPlan: f.comisionaPlan,
    }));
}

/**
 * Motor de liquidación de la planilla.
 *
 * **Todo el cálculo ocurre en la moneda del Excel, que es el DÓLAR.** El tipo de
 * cambio se aplica UNA sola vez, al final, para saber cuánto se paga en Bs.
 *
 * No es una suposición. En la hoja `COMISIONES (COORD)` de la planilla conviven
 * en la misma columna una tarifa fija y un porcentaje sobre la base:
 *
 *   Laparoscopia-Histeroscopia · 2 procedimientos · base 6.632,96
 *     COMISION USD = 20      (2 × la tarifa fija de 10 USD)
 *     COMISION BOB = 139,40  (20 × 6,97)
 *
 *   By pass Gástrico · base 6.204,83
 *     COMISION USD = 62,05   (6.204,83 × 1 %)
 *     COMISION BOB = 432,48  (62,05 × 6,97)
 *
 * Que 10 USD fijos y `base × 1 %` se sumen en la misma columna solo cuadra si la
 * base YA está en dólares. Y las dos filas convierten a Bs con el mismo TC.
 *
 * Hubo una versión que dividía la base entre el TC antes de aplicar el
 * porcentaje: partía de que el Excel venía en bolivianos. Con eso las comisiones
 * salían siete veces más bajas y, peor, quedaban en otra unidad que los bonos
 * —que sí se calculaban sin dividir—, así que el total sumaba dólares con
 * bolivianos y luego multiplicaba todo por el TC otra vez.
 */
@Injectable()
export class CalculoComisionesService {
  private readonly logger = new Logger(CalculoComisionesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configuracion: ConfiguracionComisionesService,
    private readonly audit: AuditService,
    private readonly analitica: AnaliticaComisionesService,
    private readonly resumenAnual: ResumenAnualService,
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
          codOrigen: true,
          fecha: true,
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
      codOrigen: f.codOrigen,
      fecha: f.fecha,
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

    /*
     * Solo liquida quien está en el equipo oficial (`configurada`). Las demás se
     * dan de alta solas al importar y quedan a la espera de que administración
     * les asigne tipo y área.
     *
     * Es lo que hace la planilla: Gizelle Praciano vendió 16.189,80 en noviembre
     * y 6.695,84 en diciembre, y no aparece en ninguna hoja de pago. Pagarle
     * porque su nombre salió en el Excel sería inventar una comisión.
     *
     * No es un descarte silencioso — cada una deja su aviso con lo que vendió,
     * para que se vea y se decida.
     */
    const resultados = [];
    for (const vendedora of vendedoras) {
      const suyas = porVendedora.get(vendedora.id) ?? [];
      if (suyas.length === 0) continue;

      if (!vendedora.configurada) {
        const vendido = redondear(suyas.reduce((s, f) => s + f.precio, 0));
        this.logger.warn(
          `"${vendedora.nombre}" (${vendedora.codigo}) tiene ${suyas.length} venta(s) por ` +
            `${vendido} USD y NO se liquida: falta que administración le asigne tipo y área.`,
        );
        continue;
      }

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
        data: {
          estado: EstadoPeriodo.CALCULADO,
          calculadoEn: new Date(),
          /* En la MISMA transacción que los resultados: si una falla no puede
             quedar una foto que describa unos números que no se guardaron. */
          configuracionUsada: fotografiarConfiguracion(
            config,
            tipoCambio,
          ) as unknown as Prisma.InputJsonValue,
        },
      }),
    ]);

    /* La analítica del periodo se sirve de una caché de 60 s. Sin esta línea,
       quien acaba de recalcular sigue viendo las cifras anteriores durante un
       minuto y concluye que el recálculo no hizo nada — es exactamente la
       confusión que costó descubrir por qué la columna Sueldo salía en 0.
       La vista anual lee estos mismos resultados: misma línea, mismo motivo. */
    this.analitica.invalidar(periodoId);
    this.resumenAnual.invalidar();

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
     * Qué planes CONCRETOS comisionan: los ÚLTIMOS vendidos, tantos como diga
     * el cupo. No se prorratea — en la planilla se marca el plan elegido y se
     * le paga su base completa con SU propia tarifa (hoja `BDEjecutivas`,
     * columna AR: `=SI(AQ="COMISIONA"; % de la fila × base de la fila; 0)`).
     * `seleccionarPlanesComisionables` respeta lo que administración marcó y
     * completa el resto por antigüedad inversa.
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
      let comisionUsd = 0;
      let tipo: 'A' | 'B' | 'C' = 'C';

      if (primera.clasif === ClasifComision.PLANPAQ || primera.clasif === ClasifComision.PLANNIN) {
        tipo = 'A';
        porcentaje = this.porcentajeTipoA(primera, config);
        // Solo los planes elegidos comisionan, y lo hacen por su base completa.
        const baseElegida = grupo
          .filter(f => planesElegidos.has(f.id))
          .reduce((s, f) => s + f.ingresoNeto, 0);
        comisionUsd = (baseElegida * porcentaje) / 100;
        comisionA += comisionUsd;
      } else if (primera.clasif === ClasifComision.CIRUGIA) {
        tipo = 'B';
        porcentaje = this.porcentajeTipoB(nivelCirugia, primera.canal, config);
        comisionUsd = (baseGrupo * porcentaje) / 100;
        comisionB += comisionUsd;
      } else {
        tipo = 'C';
        porcentaje = this.porcentajeTipoC(primera, config);
        comisionUsd = (baseGrupo * porcentaje) / 100;
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
  ): number {
    /* El área RA no comisiona, y punto.
     *
     * En la planilla de DICIEMBRE 2025, hoja PARAMETROS, las catorce filas del
     * área RA —RACONSULTA, RALAB, RAECOGRAFIA, RAOTROSS, RAFIV, RACIRUGIA,
     * RACAMPAÑA, RAPROMOCIÓN— están todas en 0, tanto EMPRESA como PROPIO.
     *
     * Antes había una excepción para el rol de coordinadora RA, que cobraba esos
     * ítems con una tarifa fija por procedimiento. Administración confirmó que
     * ese rol ya no existe, así que la excepción se retiró: hoy nadie cobra por
     * el área RA. Lo que hay en esas filas son análisis y consultas que pide la
     * unidad de reproducción y que FileMaker atribuye a la ejecutiva. */
    if (fila.unidadNegocio === UnidadNegocio.RA) {
      return config.parametros.get(PARAM.PCT_TIPO_C_RA) ?? 0;
    }
    const tarifa = config.tarifasServicioPorClasif.get(fila.clasif);
    if (!tarifa) return 0;
    return Number(fila.canal === CanalVenta.PROPIO ? tarifa.pctPropio : tarifa.pctEmpresa);
  }

  /** Ubica el acumulado de cirugías del mes en la escala; null si no llega al nivel 1. */

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
     * Pote de jefatura.
     *
     * **Los bonos se calculan sobre el PRECIO BRUTO, no sobre la base.** Es la
     * diferencia con las comisiones, que sí usan `precio × 0,87`. Aquí entra el
     * monto vendido tal cual.
     *
     * Cada vendedora aporta el EXCEDENTE sobre su propio objetivo por el factor,
     * y solo si lo supera. Verificado celda por celda contra la planilla de
     * DICIEMBRE 2025, hoja "CALCULO BONOS" filas 18-21, donde la columna MONTO
     * VENDIDO coincide con la suma de precios del export:
     *
     *   Viviana  (26.641,39 − 15.000) × 0,2% = 23,28
     *   Yelca    (20.759,43 − 12.000) × 0,2% = 17,52
     *   Zuany    (18.843,40 − 12.000) × 0,2% = 13,69
     *   Claudia  (18.098,82 − 12.000) × 0,2% = 12,20
     *   pote = 66,69, que es el "Total general" de la fila 22.
     *
     * Aquí hubo un comentario que afirmaba lo contrario —"es el neto completo,
     * no el excedente"— con cifras de la planilla de 2024. El código nunca hizo
     * eso, pero el comentario invitaba a "corregirlo" hasta romper la
     * reconciliación de diciembre. Las cifras de arriba son de 2025 y salen de
     * los tres export reales que usa `verificacion-diciembre`.
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
       * El objetivo se compara contra el monto vendido sin tocar el tipo de
       * cambio: ambos están en dólares, igual que el resto del cálculo. La
       * planilla de diciembre 2025 anota la resta directa —26.641,39 − 15.000 =
       * 11.641,39 para la jefa— y sobre esa diferencia aplica el factor.
       *
       * Dividir antes entre el TC hacía el umbral siete veces más exigente: con
       * los meses reales nadie lo alcanzaba nunca y el bono salía siempre en cero.
       */
      pote += aporteAlPoteJefatura(
        registro.montoVendido,
        Number(objetivo.montoMensualUsd),
        factorJefatura,
      );

      /*
       * Se paga el 0,5 % del PROMEDIO del trimestre, no del mes que se liquida.
       *
       * Verificado contra la planilla de diciembre 2025, hoja "CALCULO BONOS"
       * filas 71-74, reproducido desde los tres export de FileMaker:
       *   Viviana  (31.908,22+33.025,19+26.641,39)/3 = 30.524,93 × 0,5% = 152,62 → 1.063,76 Bs
       *   Claudia  27.610,24 × 0,5% = 138,05 → 962,21 Bs
       *   Zuany    17.541,34 × 0,5% =  87,71 →  611,34 Bs
       *   Yelca    16.529,95 × 0,5% =  82,65 →  576,07 Bs
       * Los cuatro coinciden con la planilla salvo ±0,03 Bs de redondeo.
       *
       * Antes se pagaba `montoVendido × 0,5 %` (el mes suelto) leyendo la
       * planilla de 2024. Con los datos de 2025 eso da 928 Bs a Viviana en vez
       * de 1.063,76: el promedio no es solo el requisito, es la base.
       */
      const promedio = promedios.get(vendedora.id) ?? 0;
      if (cierraTrimestre(mes)) {
        registro.bonoTrimestral = redondear(
          bonoTrimestralUsd(promedio, Number(objetivo.montoTrimestralUsd), factorTrimestral),
        );
      }
    }

    /*
     * El pote se paga DOS veces: íntegro a la jefatura, y otro tanto igual
     * repartido entre publicidad.
     *
     * Planilla de diciembre 2025, hoja "CALCULO BONOS": el pote que generan las
     * cuatro vendedoras con su excedente suma 66,69 USD —Viviana 23,28, Yelca
     * 17,52, Zuany 13,69, Claudia 12,20— y aparece dos veces en el pago:
     *   fila 23  JEFA Guzman Flores Viviana ......... 66,69 USD = 464,83 Bs
     *   filas 48-51  EQUIPO DE PUBLICIDAD ........... 33,34 + 33,34 = 66,69
     * En el resumen final Viviana cobra 464,83 de bono y Cristel y Araceli
     * 232,41 cada una. Las vendedoras que lo generan cobran CERO: por eso en la
     * planilla su columna de bonos está vacía.
     *
     * Antes el pote iba entero a publicidad y la jefa no cobraba nada, leyendo
     * la planilla de 2024 donde las dos jefas figuraban en cero.
     */
    if (pote > 0) {
      const jefas = resultados.filter(r => r.vendedora.tipo === TipoVendedora.JEFA);
      if (jefas.length > 0) {
        const porJefa = redondear(pote / jefas.length);
        for (const { registro } of jefas) {
          registro.bonoJefatura = porJefa;
        }
      }

      const publicidad = resultados.filter(r => r.vendedora.area === AreaVendedora.PUBLICIDAD);
      if (publicidad.length > 0) {
        const porPersona = redondear(pote / publicidad.length);
        for (const { registro } of publicidad) {
          registro.bonoPublicidad = porPersona;
        }
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
    /* En dólares, como todo el cálculo: es la unidad en la que la planilla
       compara contra el objetivo trimestral (15.000). Volver a dividir entre el
       TC hacía el umbral siete veces más alto y el bono no se pagaba nunca. */
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
        /*
         * Se suma lo IMPORTADO, no lo liquidado.
         *
         * Antes se leía `ResultadoComision`, que solo existe si ese mes se
         * calculó además de importarse. Quien subía los tres meses y procesaba
         * solo el último obtenía un "promedio" de un mes: a Viviana le salían
         * 133,21 (su diciembre × 0,5 %) en vez de 152,62 (el promedio de
         * octubre, noviembre y diciembre). Y en silencio.
         *
         * El monto vendido está en las ventas desde que se importan, con el
         * mismo filtro que usa la liquidación, así que el promedio sale igual
         * se haya calculado el mes o no.
         */
        const previos = await this.prisma.ventaImportada.groupBy({
          by: ['periodoId', 'vendedoraId'],
          where: {
            periodoId: { in: periodos.map(p => p.id) },
            comisionable: true,
            vendedoraId: { in: [...acumulado.keys()] },
          },
          _sum: { precio: true },
        });

        for (const fila of previos) {
          const actual = fila.vendedoraId ? acumulado.get(fila.vendedoraId) : undefined;
          if (!actual) continue;
          actual.total += Number(fila._sum.precio ?? 0);
          actual.meses += 1;
        }
      }
    }

    /* Un trimestre incompleto no es un error —puede ser una vendedora nueva—,
       pero sí algo que conviene ver: el bono sale más bajo de lo esperado. */
    for (const [id, { meses: n }] of acumulado) {
      if (n < meses) {
        const quien = resultados.find(r => r.vendedora.id === id)?.vendedora.nombre ?? id;
        this.logger.warn(
          `Bono trimestral de "${quien}": solo hay ${n} de ${meses} meses importados en la ventana. ` +
            'El promedio —y por tanto el bono— sale sobre lo que haya.',
        );
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
        planpaqVendidos: r.planpaqVendidos,
        planpaqComisionables: r.planpaqComisionables,
        planninVendidos: r.planninVendidos,
        planninComisionables: r.planninComisionables,
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
