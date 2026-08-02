import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  ClasifComision,
  NivelCirugia,
  ObjetivoComision,
  ReglaClasificacion,
  TarifaPlan,
  TarifaRA,
  TarifaServicio,
  CanalVenta,
  TipoVendedora,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { normalizar, ReglaDiccionario } from './clasificador';
import {
  CAPTACION_POR_DEFECTO,
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
  /** Valor de `captacion` del Excel → canal. Editable por administración. */
  mapeosCaptacion: Map<string, CanalVenta>;

  // Índices de los catálogos anteriores. El motor los consulta una vez por
  // grupo y por vendedora —cientos de veces en una liquidación— y con arrays
  // eso era una búsqueda lineal cada vez. Se arman aquí, una sola vez.
  objetivosPorTipo: Map<TipoVendedora, ObjetivoComision>;
  tarifasPlanPorClave: Map<string, TarifaPlan>;
  tarifasServicioPorClasif: Map<ClasifComision, TarifaServicio>;
  nivelesPorNumero: Map<number, NivelCirugia>;
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
    const [tarifasPlan, tarifasServicio, niveles, tarifasRA, objetivos, parametros, reglas, captacion] =
      await this.prisma.$transaction([
        this.prisma.tarifaPlan.count(),
        this.prisma.tarifaServicio.count(),
        this.prisma.nivelCirugia.count(),
        this.prisma.tarifaRA.count(),
        // Solo las metas POR DEFECTO: si existieran únicamente las de algún mes,
        // seguirían faltando las base y hay que sembrarlas igual.
        this.prisma.objetivoComision.count({ where: { periodoId: null } }),
        this.prisma.parametroComision.count(),
        this.prisma.reglaClasificacion.count(),
        this.prisma.mapeoCaptacion.count(),
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
    if (captacion === 0) {
      pendientes.push(
        this.prisma.mapeoCaptacion.createMany({ data: [...CAPTACION_POR_DEFECTO] }),
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

  /**
   * Lee de una sola vez todo lo que el motor de cálculo necesita.
   *
   * Con `periodoId` devuelve las metas que rigen ESE mes (las propias si
   * existen, si no las base). Sin él, solo las base — que es lo que quiere el
   * panel de configuración. Resolverlo aquí y no en el motor evita que alguien
   * reasigne `config.objetivos` después de haberlas leído, y que `listarTodo()`
   * termine exponiendo las de todos los meses mezcladas.
   */
  async cargarConfiguracion(periodoId?: string): Promise<ConfiguracionCompleta> {
    const [catalogos, objetivos] = await Promise.all([
      this.prisma.$transaction([
        this.prisma.tarifaPlan.findMany(),
        this.prisma.tarifaServicio.findMany(),
        this.prisma.nivelCirugia.findMany({ orderBy: { nivel: 'asc' } }),
        this.prisma.tarifaRA.findMany(),
        this.prisma.parametroComision.findMany(),
        this.prisma.mapeoCaptacion.findMany(),
      ]),
      periodoId
        ? this.objetivosParaPeriodo(periodoId)
        : this.prisma.objetivoComision.findMany({ where: { periodoId: null } }),
    ]);

    const [tarifasPlan, tarifasServicio, nivelesCirugia, tarifasRA, parametros, captacion] =
      catalogos;

    return {
      tarifasPlan,
      tarifasServicio,
      nivelesCirugia,
      tarifasRA,
      objetivos,
      parametros: new Map(parametros.map(p => [p.clave, Number(p.valor)])),
      mapeosCaptacion: new Map(captacion.map(m => [m.valor, m.canal])),
      objetivosPorTipo: new Map(objetivos.map(o => [o.tipo, o])),
      tarifasPlanPorClave: new Map(tarifasPlan.map(t => [t.clave, t])),
      tarifasServicioPorClasif: new Map(tarifasServicio.map(t => [t.clasif, t])),
      nivelesPorNumero: new Map(nivelesCirugia.map(n => [n.nivel, n])),
    };
  }

  /**
   * Metas que rigen para un periodo: las propias del mes si administración las
   * definió, y si no las de por defecto. Es lo que consume el motor de cálculo.
   *
   * Se resuelve aquí y no en el cálculo para que exista un solo lugar donde se
   * decide qué meta manda: si mañana se agrega una tercera capa (por vendedora,
   * por ejemplo), el motor no se entera.
   */
  async objetivosParaPeriodo(periodoId: string): Promise<ObjetivoComision[]> {
    const filas = await this.prisma.objetivoComision.findMany({
      where: { OR: [{ periodoId: null }, { periodoId }] },
    });

    const porTipo = new Map<TipoVendedora, ObjetivoComision>();
    for (const fila of filas) {
      // El del periodo pisa al de por defecto, llegue en el orden que llegue.
      if (fila.periodoId !== null || !porTipo.has(fila.tipo)) {
        porTipo.set(fila.tipo, fila);
      }
    }
    return [...porTipo.values()];
  }

  /** Define o cambia las metas propias de un mes. */
  async guardarObjetivoDePeriodo(
    periodoId: string,
    tipo: TipoVendedora,
    dto: ActualizarObjetivoDto,
  ): Promise<ObjetivoComision> {
    await this.exigirExistencia(
      this.prisma.periodoComision.count({ where: { id: periodoId } }),
      `Periodo ${periodoId}`,
    );
    return this.prisma.objetivoComision.upsert({
      where: { tipo_periodoId: { tipo, periodoId } },
      create: { tipo, periodoId, ...dto },
      update: dto,
    });
  }

  /** Quita las metas propias del mes: vuelve a regir la de por defecto. */
  async eliminarObjetivoDePeriodo(periodoId: string, tipo: TipoVendedora) {
    await this.exigirExistencia(
      this.prisma.objetivoComision.count({ where: { periodoId, tipo } }),
      `Meta ${tipo} del periodo`,
    );
    return this.prisma.objetivoComision.delete({
      where: { tipo_periodoId: { tipo, periodoId } },
    });
  }

  /** Alta o cambio de un valor de captación (el `valor` es la clave primaria). */
  async guardarMapeoCaptacion(valor: string, canal: CanalVenta) {
    const clave = normalizar(valor);
    if (!clave) {
      throw new NotFoundException('El valor de captación no puede ir vacío');
    }
    return this.prisma.mapeoCaptacion.upsert({
      where: { valor: clave },
      create: { valor: clave, canal },
      update: { canal },
    });
  }

  /** Quitar un valor lo devuelve al comportamiento por defecto: EMPRESA. */
  async eliminarMapeoCaptacion(valor: string) {
    // Se normaliza igual que al guardar: la clave de la tabla es texto
    // normalizado, así que sin esto una entrada creada como "Tik Tok" no se
    // podría borrar escribiendo lo mismo.
    const clave = normalizar(valor);
    await this.exigirExistencia(
      this.prisma.mapeoCaptacion.count({ where: { valor: clave } }),
      `Captación ${valor}`,
    );
    return this.prisma.mapeoCaptacion.delete({ where: { valor: clave } });
  }

  /**
   * Mapeo `captacion` → canal, para el importador. Se lee aparte de
   * `cargarConfiguracion()` porque la importación no necesita tarifas ni
   * objetivos: solo clasificar filas.
   */
  async cargarMapeosCaptacion(): Promise<Map<string, CanalVenta>> {
    const mapeos = await this.prisma.mapeoCaptacion.findMany();
    return new Map(mapeos.map(m => [m.valor, m.canal]));
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
      captacion: Array.from(config.mapeosCaptacion, ([valor, canal]) => ({ valor, canal })).sort(
        (a, b) => a.valor.localeCompare(b.valor),
      ),
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
