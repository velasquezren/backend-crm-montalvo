import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  ClasifComision,
  NivelCirugia,
  ObjetivoComision,
  ReglaClasificacion,
  TarifaPlan,
  TarifaRA,
  TarifaServicio,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { ReglaDiccionario } from './clasificador';
import {
  NIVELES_CIRUGIA_POR_DEFECTO,
  OBJETIVOS_POR_DEFECTO,
  PARAM,
  PARAMETROS_POR_DEFECTO,
  REGLAS_POR_DEFECTO,
  TARIFAS_PLAN_POR_DEFECTO,
  TARIFAS_RA_POR_DEFECTO,
  TARIFAS_SERVICIO_POR_DEFECTO,
} from './configuracion-por-defecto';
import {
  ActualizarNivelCirugiaDto,
  ActualizarObjetivoDto,
  ActualizarParametroDto,
  ActualizarTarifaPlanDto,
  ActualizarTarifaRaDto,
  ActualizarTarifaServicioDto,
  CrearReglaDto,
} from './dto/configuracion.dto';

/** Toda la configuración que necesita el motor de cálculo, en una sola lectura. */
export interface ConfiguracionCompleta {
  tarifasPlan: TarifaPlan[];
  tarifasServicio: TarifaServicio[];
  nivelesCirugia: NivelCirugia[];
  tarifasRA: TarifaRA[];
  objetivos: ObjetivoComision[];
  parametros: Map<string, number>;
}

/**
 * Configuración de la planilla de comisiones: porcentajes, escalas, objetivos y
 * el diccionario de clasificación. Todo editable desde el panel de administración.
 *
 * La siembra inicial es idempotente y solo rellena lo que falta: nunca pisa un
 * valor que administración ya haya ajustado.
 */
@Injectable()
export class ConfiguracionComisionesService {
  private readonly logger = new Logger(ConfiguracionComisionesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Crea los valores por defecto que aún no existan. Se llama antes de cada
   * importación, así una instalación nueva queda operativa sin pasos manuales.
   */
  async asegurarConfiguracion(): Promise<void> {
    const [tarifasPlan, tarifasServicio, niveles, tarifasRA, objetivos, parametros, reglas] =
      await this.prisma.$transaction([
        this.prisma.tarifaPlan.count(),
        this.prisma.tarifaServicio.count(),
        this.prisma.nivelCirugia.count(),
        this.prisma.tarifaRA.count(),
        this.prisma.objetivoComision.count(),
        this.prisma.parametroComision.count(),
        this.prisma.reglaClasificacion.count(),
      ]);

    const pendientes: Promise<unknown>[] = [];

    if (tarifasPlan === 0) {
      pendientes.push(this.prisma.tarifaPlan.createMany({ data: [...TARIFAS_PLAN_POR_DEFECTO] }));
    }
    if (tarifasServicio === 0) {
      pendientes.push(
        this.prisma.tarifaServicio.createMany({ data: [...TARIFAS_SERVICIO_POR_DEFECTO] }),
      );
    }
    if (niveles === 0) {
      pendientes.push(
        this.prisma.nivelCirugia.createMany({ data: [...NIVELES_CIRUGIA_POR_DEFECTO] }),
      );
    }
    if (tarifasRA === 0) {
      pendientes.push(this.prisma.tarifaRA.createMany({ data: [...TARIFAS_RA_POR_DEFECTO] }));
    }
    if (objetivos === 0) {
      pendientes.push(
        this.prisma.objetivoComision.createMany({ data: [...OBJETIVOS_POR_DEFECTO] }),
      );
    }
    if (parametros === 0) {
      pendientes.push(
        this.prisma.parametroComision.createMany({ data: [...PARAMETROS_POR_DEFECTO] }),
      );
    }
    if (reglas === 0) {
      pendientes.push(
        this.prisma.reglaClasificacion.createMany({ data: [...REGLAS_POR_DEFECTO] }),
      );
    }

    if (pendientes.length > 0) {
      await Promise.all(pendientes);
      this.logger.log(`Configuración de comisiones sembrada (${pendientes.length} tablas)`);
    }
  }

  /** Lee de una sola vez todo lo que el motor de cálculo necesita. */
  async cargarConfiguracion(): Promise<ConfiguracionCompleta> {
    const [tarifasPlan, tarifasServicio, nivelesCirugia, tarifasRA, objetivos, parametros] =
      await this.prisma.$transaction([
        this.prisma.tarifaPlan.findMany(),
        this.prisma.tarifaServicio.findMany(),
        this.prisma.nivelCirugia.findMany({ orderBy: { nivel: 'asc' } }),
        this.prisma.tarifaRA.findMany(),
        this.prisma.objetivoComision.findMany(),
        this.prisma.parametroComision.findMany(),
      ]);

    return {
      tarifasPlan,
      tarifasServicio,
      nivelesCirugia,
      tarifasRA,
      objetivos,
      parametros: new Map(parametros.map(p => [p.clave, Number(p.valor)])),
    };
  }

  /** Diccionario activo, en el formato que espera el clasificador. */
  async cargarReglas(): Promise<ReglaDiccionario[]> {
    const reglas = await this.prisma.reglaClasificacion.findMany({
      where: { activa: true },
      orderBy: { prioridad: 'asc' },
    });

    return reglas.map(r => ({
      patron: r.patron,
      exacto: r.exacto,
      modulo: r.modulo,
      clasif: r.clasif,
      nivel: r.nivel,
      unidadNegocio: r.unidadNegocio,
      prioridad: r.prioridad,
    }));
  }

  /** El IVA vigente, con el 13% como respaldo si nadie lo configuró. */
  async obtenerIva(): Promise<number> {
    const parametro = await this.prisma.parametroComision.findUnique({
      where: { clave: PARAM.IVA },
    });
    return parametro ? Number(parametro.valor) : 0.13;
  }

  /* ── Lectura para el panel ──────────────────────────────────────────── */

  async listarTodo() {
    await this.asegurarConfiguracion();
    const config = await this.cargarConfiguracion();
    const reglas = await this.prisma.reglaClasificacion.findMany({
      orderBy: [{ prioridad: 'asc' }, { patron: 'asc' }],
    });

    return {
      tarifasPlan: config.tarifasPlan,
      tarifasServicio: config.tarifasServicio,
      nivelesCirugia: config.nivelesCirugia,
      tarifasRA: config.tarifasRA,
      objetivos: config.objetivos,
      parametros: Array.from(config.parametros, ([clave, valor]) => ({ clave, valor })),
      reglas,
    };
  }

  /* ── Mutaciones del panel ───────────────────────────────────────────── */

  async actualizarTarifaPlan(clave: string, dto: ActualizarTarifaPlanDto): Promise<TarifaPlan> {
    await this.exigirExistencia(this.prisma.tarifaPlan.count({ where: { clave } }), `Tarifa de plan ${clave}`);
    return this.prisma.tarifaPlan.update({ where: { clave }, data: dto });
  }

  async actualizarTarifaServicio(
    clasif: ClasifComision,
    dto: ActualizarTarifaServicioDto,
  ): Promise<TarifaServicio> {
    await this.exigirExistencia(
      this.prisma.tarifaServicio.count({ where: { clasif } }),
      `Tarifa de servicio ${clasif}`,
    );
    return this.prisma.tarifaServicio.update({ where: { clasif }, data: dto });
  }

  async actualizarNivelCirugia(
    nivel: number,
    dto: ActualizarNivelCirugiaDto,
  ): Promise<NivelCirugia> {
    await this.exigirExistencia(
      this.prisma.nivelCirugia.count({ where: { nivel } }),
      `Nivel de cirugía ${nivel}`,
    );
    return this.prisma.nivelCirugia.update({ where: { nivel }, data: dto });
  }

  async actualizarTarifaRa(id: string, dto: ActualizarTarifaRaDto): Promise<TarifaRA> {
    await this.exigirExistencia(this.prisma.tarifaRA.count({ where: { id } }), `Tarifa RA ${id}`);
    return this.prisma.tarifaRA.update({ where: { id }, data: dto });
  }

  async actualizarObjetivo(id: string, dto: ActualizarObjetivoDto): Promise<ObjetivoComision> {
    await this.exigirExistencia(
      this.prisma.objetivoComision.count({ where: { id } }),
      `Objetivo ${id}`,
    );
    return this.prisma.objetivoComision.update({ where: { id }, data: dto });
  }

  async actualizarParametro(clave: string, dto: ActualizarParametroDto) {
    await this.exigirExistencia(
      this.prisma.parametroComision.count({ where: { clave } }),
      `Parámetro ${clave}`,
    );
    return this.prisma.parametroComision.update({ where: { clave }, data: { valor: dto.valor } });
  }

  /* ── Diccionario de clasificación ───────────────────────────────────── */

  async crearRegla(dto: CrearReglaDto): Promise<ReglaClasificacion> {
    return this.prisma.reglaClasificacion.create({ data: dto });
  }

  async actualizarRegla(id: string, dto: Partial<CrearReglaDto>): Promise<ReglaClasificacion> {
    await this.exigirExistencia(
      this.prisma.reglaClasificacion.count({ where: { id } }),
      `Regla ${id}`,
    );
    return this.prisma.reglaClasificacion.update({ where: { id }, data: dto });
  }

  async eliminarRegla(id: string): Promise<{ eliminada: true }> {
    await this.exigirExistencia(
      this.prisma.reglaClasificacion.count({ where: { id } }),
      `Regla ${id}`,
    );
    await this.prisma.reglaClasificacion.delete({ where: { id } });
    return { eliminada: true };
  }

  /** 404 uniforme antes de escribir, para no filtrar si el registro existe o no. */
  private async exigirExistencia(consulta: Promise<number>, etiqueta: string): Promise<void> {
    if ((await consulta) === 0) {
      throw new NotFoundException(`${etiqueta} no encontrado`);
    }
  }
}
