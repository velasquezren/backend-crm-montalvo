import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EstadoPeriodo, Prisma, VendedoraComision } from '@prisma/client';

import { AuditService } from '../../common/audit/audit.service';
import { calcularPaginacion, paginar } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  clasificarFila,
  determinarTipo,
  FilaExcel,
  nombresCoinciden,
  normalizar,
} from './clasificador';
import { ConfiguracionComisionesService } from './configuracion-comisiones.service';
import { ActualizarVendedoraDto } from './dto/configuracion.dto';
import { AjustarVentaDto, ImportarExcelDto, QueryPeriodosDto, QueryVentasImportadasDto } from './dto/planilla.dto';
import { deducirPeriodo, leerExcel } from './excel-parser';

/** Cuántas filas se insertan por lote (el VPS tiene poca RAM: no cargar todo de golpe). */
const TAMANO_LOTE = 500;

/**
 * Planilla de comisiones — importación del Excel de FileMaker y clasificación.
 *
 * Dominio separado del de `Ventas`/`Comisiones` del CRM: aquí no se toca ninguna
 * de esas tablas. El flujo es importar → revisar clasificación → calcular.
 */
@Injectable()
export class PlanillaComisionesService {
  private readonly logger = new Logger(PlanillaComisionesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configuracion: ConfiguracionComisionesService,
    private readonly audit: AuditService,
  ) {}

  /* ── Importación ────────────────────────────────────────────────────── */

  /**
   * Lee el Excel, clasifica cada fila y reemplaza el contenido del periodo.
   *
   * Reimportar el mismo mes es una operación normal (FileMaker se corrige y se
   * vuelve a exportar): las filas anteriores se borran, pero **los ajustes
   * manuales de clasificación se conservan** cruzándolos por servicio.
   */
  async importar(
    buffer: Buffer,
    nombreArchivo: string,
    dto: ImportarExcelDto,
    usuarioId: string,
  ) {
    await this.configuracion.asegurarConfiguracion();

    const { filas, filasVacias, columnasAusentes } = leerExcel(buffer);
    const deducido = deducirPeriodo(filas);

    const anio = dto.anio ?? deducido.anio;
    const mes = dto.mes ?? deducido.mes;
    const tipoCambio = dto.tipoCambio ?? deducido.tipoCambio;

    const existente = await this.prisma.periodoComision.findUnique({ where: { anio_mes: { anio, mes } } });
    if (existente?.estado === EstadoPeriodo.CERRADO) {
      throw new ConflictException(
        `El periodo ${mes}/${anio} está CERRADO. Reábrelo antes de volver a importar.`,
      );
    }

    const [reglas, iva] = await Promise.all([
      this.configuracion.cargarReglas(),
      this.configuracion.obtenerIva(),
    ]);

    // Ajustes manuales previos, para no perderlos al reimportar el mes.
    const ajustesPrevios = existente ? await this.leerAjustesManuales(existente.id) : new Map();

    const vendedoras = await this.sincronizarVendedoras(filas);

    const periodo = await this.prisma.periodoComision.upsert({
      where: { anio_mes: { anio, mes } },
      create: {
        anio,
        mes,
        tipoCambio,
        archivoNombre: nombreArchivo,
        filasTotales: filas.length,
        importadoPor: usuarioId,
        estado: EstadoPeriodo.BORRADOR,
      },
      update: {
        tipoCambio,
        archivoNombre: nombreArchivo,
        filasTotales: filas.length,
        importadoPor: usuarioId,
        estado: EstadoPeriodo.BORRADOR,
        calculadoEn: null,
      },
    });

    // Reemplazo completo: fuera las filas y resultados del periodo anterior.
    await this.prisma.$transaction([
      this.prisma.ventaImportada.deleteMany({ where: { periodoId: periodo.id } }),
      this.prisma.resultadoComision.deleteMany({ where: { periodoId: periodo.id } }),
    ]);

    let filasValidas = 0;
    let sinClasificar = 0;
    const lote: Prisma.VentaImportadaCreateManyInput[] = [];

    for (const fila of filas) {
      const resultado = clasificarFila(fila, reglas, iva);
      if (resultado.requiereRevision) sinClasificar++;
      if (resultado.comisionable) filasValidas++;

      const ajuste = ajustesPrevios.get(this.claveAjuste(fila));

      lote.push({
        periodoId: periodo.id,
        fecha: fila.fecha,
        modulo: fila.modulo,
        codOrigen: fila.codOrigen,
        estadoPlan: fila.estadoPlan,
        codItem: fila.codItem,
        detalle: fila.detalle.slice(0, 300),
        pac: fila.pac,
        paciente: fila.paciente,
        medicoPk: fila.medicoPk,
        medico: fila.medico,
        vendedoraPk: fila.vendedoraPk,
        vendedoraNombre: fila.vendedoraNombre,
        captacion: fila.captacion,
        seguro: fila.seguro,
        promocion: fila.promocion,
        precio: fila.precio,
        anticipoPlan: fila.anticipoPlan,
        tc: fila.tc,
        obs: fila.obs,
        clasificacionPlan: fila.clasificacionPlan,
        // El ajuste manual previo gana sobre lo que deduzca el clasificador.
        canal: ajuste?.canal ?? resultado.canal,
        ingresoNeto: resultado.ingresoNeto,
        unidadNegocio: ajuste?.unidadNegocio ?? resultado.unidadNegocio,
        clasif: ajuste?.clasif ?? resultado.clasif,
        tipo: ajuste?.tipo ?? resultado.tipo,
        nivel: ajuste?.nivel ?? resultado.nivel,
        comisionable: ajuste?.comisionable ?? resultado.comisionable,
        motivoExclusion: resultado.motivoExclusion,
        // Un ajuste manual previo ya resolvió la duda: deja de pedir revisión.
        requiereRevision: ajuste ? false : resultado.requiereRevision,
        ajustadaManual: Boolean(ajuste),
        vendedoraId: this.resolverVendedoraId(fila, vendedoras),
      });

      if (lote.length >= TAMANO_LOTE) {
        await this.prisma.ventaImportada.createMany({ data: lote.splice(0, lote.length) });
      }
    }

    if (lote.length > 0) {
      await this.prisma.ventaImportada.createMany({ data: lote });
    }

    const actualizado = await this.prisma.periodoComision.update({
      where: { id: periodo.id },
      data: { filasValidas },
    });

    await this.audit.registrar('PeriodoComision', periodo.id, 'IMPORTAR', usuarioId, {
      archivo: nombreArchivo,
      anio,
      mes,
      filas: filas.length,
      filasValidas,
    });

    this.logger.log(
      `Planilla ${mes}/${anio}: ${filas.length} filas (${filasValidas} comisionables, ${sinClasificar} sin clasificar)`,
    );

    return {
      periodo: actualizado,
      resumen: {
        filasLeidas: filas.length,
        filasVacias,
        filasComisionables: filasValidas,
        filasSinClasificar: sinClasificar,
        vendedorasDetectadas: vendedoras.size,
        columnasAusentes,
        ajustesConservados: ajustesPrevios.size,
      },
    };
  }

  /** Clave estable de una fila para reaplicar ajustes al reimportar el mes. */
  private claveAjuste(fila: FilaExcel): string {
    return [normalizar(fila.detalle), fila.codOrigen ?? '', fila.pac ?? ''].join('|');
  }

  /** Lee los ajustes manuales de un periodo, indexados por la clave de fila. */
  private async leerAjustesManuales(periodoId: string) {
    const ajustadas = await this.prisma.ventaImportada.findMany({
      where: { periodoId, ajustadaManual: true },
      select: {
        detalle: true,
        codOrigen: true,
        pac: true,
        canal: true,
        clasif: true,
        tipo: true,
        nivel: true,
        unidadNegocio: true,
        comisionable: true,
      },
    });

    return new Map(
      ajustadas.map(a => [
        [normalizar(a.detalle), a.codOrigen ?? '', a.pac ?? ''].join('|'),
        a,
      ]),
    );
  }

  /**
   * Da de alta las vendedoras que aparezcan en el archivo y aún no existan.
   * Quedan con `configurada = false` para que salgan en las alertas hasta que
   * administración les fije tipo, área y sueldo.
   */
  private async sincronizarVendedoras(
    filas: readonly FilaExcel[],
  ): Promise<Map<string, VendedoraComision>> {
    const detectadas = new Map<string, string>();
    for (const fila of filas) {
      const codigo = fila.vendedoraPk?.trim();
      if (!codigo) continue;
      if (!detectadas.has(codigo)) {
        detectadas.set(codigo, fila.vendedoraNombre?.trim() || codigo);
      }
    }

    if (detectadas.size === 0) return new Map();

    // createMany + skipDuplicates: alta masiva sin chocar contra el único de `codigo`.
    await this.prisma.vendedoraComision.createMany({
      data: Array.from(detectadas, ([codigo, nombre]) => ({ codigo, nombre: nombre.slice(0, 200) })),
      skipDuplicates: true,
    });

    const vendedoras = await this.prisma.vendedoraComision.findMany({
      where: { codigo: { in: Array.from(detectadas.keys()) } },
    });

    await this.enlazarConAgentes(vendedoras);

    return new Map(vendedoras.map(v => [v.codigo, v]));
  }

  /**
   * Enlaza cada vendedora con el agente del CRM que sea la misma persona.
   *
   * Dos vías, en orden de fiabilidad:
   *   1. `Usuario.codigo` == `vendedora.codigo` (el identificador de la empresa).
   *   2. El nombre, solo si hay **exactamente un** agente candidato — con dos o
   *      más no se adivina: se deja sin enlazar para que lo resuelva un humano.
   *
   * Solo rellena huecos: nunca pisa un enlace hecho a mano desde el panel.
   */
  private async enlazarConAgentes(vendedoras: readonly VendedoraComision[]): Promise<void> {
    const pendientes = vendedoras.filter(v => !v.usuarioId);
    if (pendientes.length === 0) return;

    // Agentes que aún no están enlazados a ninguna vendedora.
    const agentes = await this.prisma.usuario.findMany({
      where: { activo: true, vendedoraComision: { is: null } },
      select: { id: true, nombre: true, codigo: true },
    });
    if (agentes.length === 0) return;

    const yaUsados = new Set<string>();

    for (const vendedora of pendientes) {
      const libres = agentes.filter(a => !yaUsados.has(a.id));

      const porCodigo = libres.find(a => a.codigo && a.codigo === vendedora.codigo);
      let elegido = porCodigo ?? null;

      if (!elegido) {
        const porNombre = libres.filter(a => nombresCoinciden(a.nombre, vendedora.nombre));
        // Ambiguo (dos homónimos) → no se enlaza, lo decide administración.
        if (porNombre.length === 1) {
          elegido = porNombre[0];
        } else if (porNombre.length > 1) {
          this.logger.warn(
            `"${vendedora.nombre}" cruza con ${porNombre.length} agentes; enlazar a mano.`,
          );
        }
      }

      if (!elegido) continue;

      try {
        await this.prisma.vendedoraComision.update({
          where: { id: vendedora.id },
          data: { usuarioId: elegido.id },
        });
        yaUsados.add(elegido.id);
        this.logger.log(
          `Vendedora "${vendedora.nombre}" enlazada al agente "${elegido.nombre}" ` +
            `(${porCodigo ? 'por código' : 'por nombre'})`,
        );
      } catch (error) {
        // El único de usuarioId puede rebotar si otra importación simultánea
        // ganó la carrera: no es motivo para tumbar toda la importación.
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
          throw error;
        }
      }
    }
  }

  private resolverVendedoraId(
    fila: FilaExcel,
    vendedoras: Map<string, VendedoraComision>,
  ): string | null {
    const codigo = fila.vendedoraPk?.trim();
    return codigo ? (vendedoras.get(codigo)?.id ?? null) : null;
  }

  /* ── Consulta de periodos ───────────────────────────────────────────── */

  async listarPeriodos(query: QueryPeriodosDto) {
    const where: Prisma.PeriodoComisionWhereInput = query.anio ? { anio: query.anio } : {};
    const { skip, take } = calcularPaginacion(query);

    const [datos, total] = await this.prisma.$transaction([
      this.prisma.periodoComision.findMany({
        where,
        orderBy: [{ anio: 'desc' }, { mes: 'desc' }],
        skip,
        take,
        include: { _count: { select: { ventas: true, resultados: true } } },
      }),
      this.prisma.periodoComision.count({ where }),
    ]);

    return paginar(datos, total, query);
  }

  async obtenerPeriodo(id: string) {
    const periodo = await this.prisma.periodoComision.findUnique({
      where: { id },
      include: { _count: { select: { ventas: true, resultados: true } } },
    });
    if (!periodo) {
      throw new NotFoundException(`Periodo ${id} no encontrado`);
    }
    return periodo;
  }

  async eliminarPeriodo(id: string, usuarioId: string) {
    const periodo = await this.obtenerPeriodo(id);
    if (periodo.estado === EstadoPeriodo.CERRADO) {
      throw new ConflictException('No se puede eliminar un periodo CERRADO');
    }
    // Las ventas y resultados caen por onDelete: Cascade.
    await this.prisma.periodoComision.delete({ where: { id } });
    await this.audit.registrar('PeriodoComision', id, 'ELIMINAR', usuarioId, {
      anio: periodo.anio,
      mes: periodo.mes,
    });
    return { eliminado: true };
  }

  /** Cierra el periodo para que no se pueda reimportar ni recalcular por accidente. */
  async cambiarEstado(id: string, estado: EstadoPeriodo, usuarioId: string) {
    await this.obtenerPeriodo(id);
    const periodo = await this.prisma.periodoComision.update({ where: { id }, data: { estado } });
    await this.audit.registrar('PeriodoComision', id, `ESTADO_${estado}`, usuarioId);
    return periodo;
  }

  /* ── Vista previa de la clasificación ───────────────────────────────── */

  async listarVentas(periodoId: string, query: QueryVentasImportadasDto) {
    await this.obtenerPeriodo(periodoId);

    const where: Prisma.VentaImportadaWhereInput = {
      periodoId,
      ...(query.clasif ? { clasif: query.clasif } : {}),
      ...(query.canal ? { canal: query.canal } : {}),
      ...(query.vendedoraId ? { vendedoraId: query.vendedoraId } : {}),
      ...(query.modulo ? { modulo: query.modulo } : {}),
      ...(query.soloExcluidas ? { comisionable: false } : {}),
      ...(query.soloSinClasificar ? { requiereRevision: true } : {}),
      ...(query.buscar
        ? {
            OR: [
              { detalle: { contains: query.buscar, mode: 'insensitive' } },
              { paciente: { contains: query.buscar, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const { skip, take } = calcularPaginacion(query);

    const [datos, total] = await this.prisma.$transaction([
      this.prisma.ventaImportada.findMany({
        where,
        orderBy: [{ fecha: 'asc' }, { detalle: 'asc' }],
        skip,
        take,
        include: { vendedora: { select: { id: true, nombre: true, codigo: true } } },
      }),
      this.prisma.ventaImportada.count({ where }),
    ]);

    return paginar(datos, total, query);
  }

  /** Corrige a mano la clasificación de una fila; queda marcada como ajustada. */
  async ajustarVenta(id: string, dto: AjustarVentaDto, usuarioId: string) {
    const venta = await this.prisma.ventaImportada.findUnique({ where: { id } });
    if (!venta) {
      throw new NotFoundException(`Venta importada ${id} no encontrada`);
    }

    const periodo = await this.obtenerPeriodo(venta.periodoId);
    if (periodo.estado === EstadoPeriodo.CERRADO) {
      throw new ConflictException('El periodo está CERRADO: no admite ajustes');
    }

    if (dto.vendedoraId) {
      const existe = await this.prisma.vendedoraComision.count({ where: { id: dto.vendedoraId } });
      if (existe === 0) {
        throw new BadRequestException(`La vendedora ${dto.vendedoraId} no existe`);
      }
    }

    // Cambiar la clasificación cambia el tipo de comisión que le corresponde.
    const actualizada = await this.prisma.ventaImportada.update({
      where: { id },
      data: {
        ...dto,
        ...(dto.clasif ? { tipo: determinarTipo(dto.clasif) } : {}),
        // Corregirla a mano es, precisamente, haberla revisado.
        requiereRevision: false,
        ajustadaManual: true,
      },
    });

    await this.audit.registrar('VentaImportada', id, 'AJUSTAR', usuarioId, { ...dto });
    return actualizada;
  }

  /* ── Alertas ────────────────────────────────────────────────────────── */

  /**
   * Todo lo que administración debería revisar antes de calcular.
   * Se resuelve con agregados en SQL, no trayendo las filas a memoria.
   */
  async alertas(periodoId: string) {
    await this.obtenerPeriodo(periodoId);

    const [
      excluidas,
      vendedorasSinConfigurar,
      sinVendedora,
      porMotivo,
      planesSinEstado,
      sinClasificar,
    ] = await Promise.all([
      this.prisma.ventaImportada.count({ where: { periodoId, comisionable: false } }),
      this.prisma.vendedoraComision.count({
        where: { configurada: false, ventas: { some: { periodoId } } },
      }),
      this.prisma.ventaImportada.count({ where: { periodoId, vendedoraId: null } }),
      this.prisma.ventaImportada.groupBy({
        by: ['motivoExclusion'],
        where: { periodoId, comisionable: false },
        _count: { _all: true },
        _sum: { precio: true },
      }),
      this.prisma.ventaImportada.count({
        where: { periodoId, modulo: 'PLANES', comisionable: false },
      }),
      this.prisma.ventaImportada.count({ where: { periodoId, requiereRevision: true } }),
    ]);

    const [vendedorasPendientes, serviciosSinClasificar] = await Promise.all([
      this.prisma.vendedoraComision.findMany({
        where: { configurada: false, ventas: { some: { periodoId } } },
        select: { id: true, codigo: true, nombre: true },
        take: 50,
      }),
      // Un servicio nuevo aparece muchas veces en el mes: se agrupa para que
      // administración lo resuelva UNA vez creando la regla del diccionario.
      this.prisma.ventaImportada.groupBy({
        by: ['detalle', 'modulo'],
        where: { periodoId, requiereRevision: true },
        _count: { _all: true },
        _sum: { precio: true },
        orderBy: { _sum: { precio: 'desc' } },
        take: 50,
      }),
    ]);

    return {
      totales: {
        filasExcluidas: excluidas,
        vendedorasSinConfigurar,
        filasSinVendedora: sinVendedora,
        planesSinEstadoValido: planesSinEstado,
        filasSinClasificar: sinClasificar,
      },
      motivosExclusion: porMotivo.map(m => ({
        motivo: m.motivoExclusion ?? 'Sin motivo',
        filas: m._count._all,
        montoAfectado: Number(m._sum.precio ?? 0),
      })),
      serviciosSinClasificar: serviciosSinClasificar.map(s => ({
        detalle: s.detalle,
        modulo: s.modulo,
        veces: s._count._all,
        montoAfectado: Number(s._sum.precio ?? 0),
      })),
      vendedorasPendientes,
    };
  }

  /* ── Vendedoras ─────────────────────────────────────────────────────── */

  async listarVendedoras() {
    return this.prisma.vendedoraComision.findMany({
      orderBy: [{ configurada: 'asc' }, { nombre: 'asc' }],
      include: { usuario: { select: { id: true, nombre: true, email: true, codigo: true } } },
    });
  }

  async actualizarVendedora(
    id: string,
    datos: ActualizarVendedoraDto,
    usuarioId: string,
  ) {
    const existe = await this.prisma.vendedoraComision.count({ where: { id } });
    if (existe === 0) {
      throw new NotFoundException(`Vendedora ${id} no encontrada`);
    }

    const { usuarioId: agenteId, ...resto } = datos;
    const enlace = await this.resolverEnlaceAgente(id, agenteId);

    const vendedora = await this.prisma.vendedoraComision.update({
      where: { id },
      // Editarla desde el panel es exactamente el acto de configurarla.
      data: { ...resto, ...enlace, configurada: true },
      include: { usuario: { select: { id: true, nombre: true, email: true, codigo: true } } },
    });

    await this.audit.registrar('VendedoraComision', id, 'ACTUALIZAR', usuarioId, {
      ...(datos as Record<string, unknown>),
    });
    return vendedora;
  }

  /**
   * Traduce el `usuarioId` que llega del panel a lo que Prisma debe escribir:
   * `undefined` = no tocar el enlace · `null`/'' = desvincular · id = vincular.
   */
  private async resolverEnlaceAgente(
    vendedoraId: string,
    agenteId: string | null | undefined,
  ): Promise<{ usuarioId?: string | null }> {
    if (agenteId === undefined) return {};
    if (agenteId === null || agenteId === '') return { usuarioId: null };

    const agente = await this.prisma.usuario.findUnique({
      where: { id: agenteId },
      select: { id: true, nombre: true, vendedoraComision: { select: { id: true, nombre: true } } },
    });
    if (!agente) {
      throw new BadRequestException(`El agente ${agenteId} no existe`);
    }

    // Sin este aviso el único de `usuarioId` daría un 500 opaco.
    const yaEnlazada = agente.vendedoraComision;
    if (yaEnlazada && yaEnlazada.id !== vendedoraId) {
      throw new ConflictException(
        `El agente "${agente.nombre}" ya está vinculado a "${yaEnlazada.nombre}". Desvincúlalo primero.`,
      );
    }

    return { usuarioId: agenteId };
  }

  /** Agentes activos del CRM, para el desplegable de vinculación del panel. */
  async listarAgentesVinculables() {
    return this.prisma.usuario.findMany({
      where: { activo: true },
      select: {
        id: true,
        nombre: true,
        email: true,
        codigo: true,
        vendedoraComision: { select: { id: true, nombre: true } },
      },
      orderBy: { nombre: 'asc' },
    });
  }
}
