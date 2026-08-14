import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EstadoPeriodo, Prisma, VendedoraComision } from '@prisma/client';

import { AuditService } from '../../common/audit/audit.service';
import { calcularPaginacion, paginar } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { clasificarFila, determinarTipo, FilaExcel, normalizar } from './clasificador';
import { CatalogoClinicoService } from './catalogo-clinico.service';
import { ConfiguracionComisionesService } from './configuracion-comisiones.service';
import { EQUIPO_OFICIAL } from './configuracion-por-defecto';
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
    private readonly catalogo: CatalogoClinicoService,
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

    const [reglas, iva, mapeosCaptacion] = await Promise.all([
      this.configuracion.cargarReglas(),
      this.configuracion.obtenerIva(),
      this.configuracion.cargarMapeosCaptacion(),
    ]);

    // Ajustes manuales previos, para no perderlos al reimportar el mes.
    const ajustesPrevios = existente ? await this.leerAjustesManuales(existente.id) : new Map();

    /* Vendedoras y médicos se registran en paralelo: son tablas distintas y
       ninguna depende de la otra. */
    const [vendedoras] = await Promise.all([
      this.sincronizarVendedoras(filas),
      this.sincronizarMedicos(filas),
    ]);

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
      const resultado = clasificarFila(fila, reglas, iva, mapeosCaptacion);
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
        // En MAYÚSCULAS: el maestro de pacientes trae `Pac1897` y el de ventas
        // `PAC50660`. Sin normalizar, el mismo paciente no cruzaría con su ficha.
        pac: fila.pac ? fila.pac.toUpperCase() : null,
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

    /* El catálogo del modal de ventas sale de estas filas: si no se invalida,
       los servicios del mes recién importado tardarían una hora en aparecer
       como sugerencia. */
    this.catalogo.invalidar();

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
  /**
   * Registra a quien atendió, tomándolo de `medico_pk`.
   *
   * Mismo criterio que las vendedoras y por la misma razón: FileMaker identifica
   * a la PERSONA con ese código, así que es la única clave estable. El nombre no
   * lo es — `Dr1946` llega como "Azogue Rivera Claudia María" y como
   * "Claudia María Azogue Rivera" según el mes.
   *
   * Por eso el nombre se **actualiza** en cada importación y el código nunca: si
   * corrigen la grafía en FileMaker, el CRM la adopta sin duplicar a la persona.
   *
   * No crea usuarios: atender pacientes y entrar al sistema son cosas distintas.
   * Quedan con `configurado = false` hasta que administración los revise.
   */
  private async sincronizarMedicos(filas: readonly FilaExcel[]): Promise<void> {
    const detectados = new Map<string, string>();
    for (const fila of filas) {
      const codigo = fila.medicoPk?.trim();
      if (!codigo) continue;
      const nombre = fila.medico?.trim();
      // La última grafía del archivo gana: es la más reciente.
      if (nombre) detectados.set(codigo, nombre);
      else if (!detectados.has(codigo)) detectados.set(codigo, codigo);
    }

    if (detectados.size === 0) return;

    await this.prisma.medico.createMany({
      data: Array.from(detectados, ([codigo, nombre]) => ({ codigo, nombre: nombre.slice(0, 200) })),
      skipDuplicates: true,
    });

    /* A los que ya existían se les refresca el nombre. Son decenas, no miles:
       40 personas distintas en los tres meses de 2026. */
    const existentes = await this.prisma.medico.findMany({
      where: { codigo: { in: [...detectados.keys()] } },
      select: { id: true, codigo: true, nombre: true },
    });

    const renombrados = existentes.filter(m => m.nombre !== detectados.get(m.codigo));
    if (renombrados.length > 0) {
      await this.prisma.$transaction(
        renombrados.map(m =>
          this.prisma.medico.update({
            where: { id: m.id },
            data: { nombre: (detectados.get(m.codigo) as string).slice(0, 200) },
          }),
        ),
      );
    }
  }

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

    /*
     * Quien está en el equipo oficial entra ya con su tipo y su área —Viviana
     * es JEFA, Maricela coordinadora de RA— y marcada como revisada. El resto
     * entra con los valores por defecto y `configurada: false`, que es lo que
     * el cálculo usa para no pagarle sin que administración lo mire.
     */
    const oficiales = new Map(EQUIPO_OFICIAL.map(v => [v.codigo, v]));

    // createMany + skipDuplicates: alta masiva sin chocar contra el único de `codigo`.
    await this.prisma.vendedoraComision.createMany({
      data: Array.from(detectadas, ([codigo, nombre]) => {
        const oficial = oficiales.get(codigo);
        return oficial
          ? {
              codigo,
              nombre: oficial.nombre.slice(0, 200),
              tipo: oficial.tipo,
              area: oficial.area,
              configurada: true,
            }
          : { codigo, nombre: nombre.slice(0, 200) };
      }),
      skipDuplicates: true,
    });

    /* `skipDuplicates` no actualiza las que ya existían de importaciones
       anteriores, cuando aún no había lista oficial: se corrigen aquí. */
    for (const oficial of EQUIPO_OFICIAL) {
      if (!detectadas.has(oficial.codigo)) continue;
      await this.prisma.vendedoraComision.updateMany({
        where: { codigo: oficial.codigo, configurada: false },
        data: { tipo: oficial.tipo, area: oficial.area, configurada: true },
      });
    }

    const vendedoras = await this.prisma.vendedoraComision.findMany({
      where: { codigo: { in: Array.from(detectadas.keys()) } },
    });

    return new Map(vendedoras.map(v => [v.codigo, v]));
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

  /**
   * Vendedoras con el agente del CRM que les corresponde.
   *
   * El cruce es por `codigo` (el `vendedora_pk` del Excel es el mismo
   * identificador que lleva el agente), así que no hay ningún enlace que
   * mantener ni vincular a mano: si el agente tiene su código puesto, aparece.
   */
  async listarVendedoras() {
    const vendedoras = await this.prisma.vendedoraComision.findMany({
      orderBy: [{ configurada: 'asc' }, { nombre: 'asc' }],
    });

    const agentes = await this.prisma.usuario.findMany({
      where: { codigo: { in: vendedoras.map(v => v.codigo) } },
      select: { id: true, nombre: true, email: true, codigo: true, activo: true },
    });
    const porCodigo = new Map(agentes.map(a => [a.codigo, a]));

    return vendedoras.map(v => ({ ...v, agente: porCodigo.get(v.codigo) ?? null }));
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

    const vendedora = await this.prisma.vendedoraComision.update({
      where: { id },
      // Editarla desde el panel es exactamente el acto de configurarla.
      data: { ...datos, configurada: true },
    });

    await this.audit.registrar('VendedoraComision', id, 'ACTUALIZAR', usuarioId, {
      ...(datos as Record<string, unknown>),
    });
    return vendedora;
  }

}
