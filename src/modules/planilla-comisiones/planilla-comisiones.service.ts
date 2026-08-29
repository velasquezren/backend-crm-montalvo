import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AreaVendedora,
  EstadoPeriodo,
  Prisma,
  ModoTipoCambio,
  Rol,
  TipoVendedora,
  VendedoraComision,
} from '@prisma/client';

import { AuditService } from '../../common/audit/audit.service';
import { terminoBusqueda } from '../../common/dto/busqueda';
import { calcularPaginacion, paginar } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  buscarRegla,
  clasificarFila,
  determinarTipo,
  FilaExcel,
  normalizar,
  ReglaDiccionario,
} from './clasificador';
import { CatalogoClinicoService } from './catalogo-clinico.service';
import { ConfiguracionComisionesService } from './configuracion-comisiones.service';
import { EQUIPO_OFICIAL, TIPO_CAMBIO_POR_DEFECTO } from './configuracion-por-defecto';
import {
  Aprobador,
  bloqueosParaRevision,
  calcularEstadoRevision,
  esEditable,
  MOTIVO_BLOQUEO,
  transicionPermitida,
} from './estados-periodo';
import { ActualizarVendedoraDto, CrearVendedoraDto } from './dto/configuracion.dto';
import { AjustarVentaDto, ImportarExcelDto, QueryPeriodosDto, QueryVentasImportadasDto } from './dto/planilla.dto';
import { deducirPeriodo, leerExcel } from './excel-parser';
import { ResumenAnualService } from './resumen-anual.service';
import { TipoCambioService } from '../tipo-cambio/tipo-cambio.service';

/** Cuántas filas se insertan por lote (el VPS tiene poca RAM: no cargar todo de golpe). */
const TAMANO_LOTE = 500;

/**
 * Techo del mes completo de una vendedora (`?mesCompleto=true`).
 *
 * **No es paginación, es un corte**: la vista de desempeño busca y filtra en
 * memoria sobre lo que recibe, así que una fila fuera del tope no está en la
 * página siguiente, sencillamente no existe para el buscador.
 *
 * Es el mismo patrón que tenía el inbox de Conversaciones (`LIMITE_INBOX`) y
 * que allí **terminó escondiendo chats en silencio**: se resolvió el 2026-08-27
 * moviendo orden, filtros y búsqueda a Postgres. Acá el corte se sostiene por
 * los números de abajo —un mes cabe de sobra en 500— pero si algún día dejan de
 * cumplirse, la salida es esa y no subir el número. Ver `crm-backend-module`.
 *
 * 500 sale de los datos, no de la intuición: el mes más cargado de las 67
 * combinaciones vendedora-mes importadas tiene 423 ventas, y la mediana 117.
 * Pesa poco —unos 3,8 KB comprimidos por cada 100 filas, o sea ~16 KB el mes
 * más grande— y a cambio el buscador deja de mentir.
 *
 * Si alguna vez se alcanza, queda un WARN en el log en vez de esconder ventas
 * en silencio.
 */
const LIMITE_MES_VENDEDORA = 500;

/** Totales del filtro completo, no de la página que se está viendo. */
export interface TotalesVentas {
  readonly ventas: number;
  readonly monto: number;
  readonly base: number;
}

/** Subtotal de una vendedora dentro del filtro actual. */
export interface SubtotalVendedora extends TotalesVentas {
  readonly vendedoraId: string;
  readonly nombre: string;
}

/** Reparto por canal de una vendedora, o `null` si no se pidió por vendedora. */
export interface RepartoCanal {
  readonly total: number;
  readonly propios: number;
  readonly empresa: number;
  readonly pctPropio: number;
}

/**
 * Planilla de comisiones — importación del Excel de FileMaker y clasificación.
 *
 * Dominio separado del de `Ventas`/`Comisiones` del CRM: aquí no se toca ninguna
 * de esas tablas. El flujo es importar → revisar clasificación → calcular.
 */
/**
 * Convierte el `groupBy` por canal en el reparto que pinta la vista.
 *
 * Todo lo que no es PROPIO cuenta como de la clínica: la pantalla solo contrapone
 * "yo la traje" contra "me la dio la clínica", y agrupar el resto evita que un
 * canal nuevo en FileMaker desaparezca de la cuenta sin avisar.
 */
/**
 * Fila cruda de un `groupBy` con conteo y sumas.
 *
 * Se declara a mano porque Prisma tipa `_count` como `true | objeto` aunque la
 * consulta pida `{ _all: true }`, y leerlo directo no compila. Es el mismo
 * rodeo que ya usaba `repartoPorCanal`: un tipo explícito en vez de un `any`.
 */
interface FilaAgrupada {
  readonly vendedoraId: string | null;
  readonly _count: { readonly _all: number };
  readonly _sum: { readonly precio: unknown; readonly ingresoNeto: unknown };
}

/** Subtotales por vendedora a partir del `groupBy`, de mayor a menor. */
function subtotalesPorVendedora(
  filas: readonly FilaAgrupada[],
  nombres: ReadonlyMap<string, string>,
): SubtotalVendedora[] {
  return filas
    .filter(f => f.vendedoraId)
    .map(f => ({
      vendedoraId: f.vendedoraId as string,
      nombre: nombres.get(f.vendedoraId as string) ?? 'Sin identificar',
      ventas: f._count._all,
      monto: Number(f._sum.precio ?? 0),
      base: Number(f._sum.ingresoNeto ?? 0),
    }))
    .sort((a, b) => b.monto - a.monto);
}

function repartoPorCanal(
  filas: { canal: string; _count: { _all: number } }[] | undefined,
): RepartoCanal | null {
  if (!filas) return null;
  const total = filas.reduce((t, f) => t + f._count._all, 0);
  const propios = filas.find(f => f.canal === 'PROPIO')?._count._all ?? 0;
  return {
    total,
    propios,
    empresa: total - propios,
    pctPropio: total > 0 ? Math.round((propios / total) * 100) : 0,
  };
}

@Injectable()
export class PlanillaComisionesService {
  private readonly logger = new Logger(PlanillaComisionesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configuracion: ConfiguracionComisionesService,
    private readonly audit: AuditService,
    private readonly catalogo: CatalogoClinicoService,
    private readonly resumenAnual: ResumenAnualService,
    private readonly tipoCambio: TipoCambioService,
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
    const tipoCambio = await this.resolverTipoCambio(dto.tipoCambio, deducido.tipoCambio, mes, anio);

    const existente = await this.prisma.periodoComision.findUnique({ where: { anio_mes: { anio, mes } } });
    if (existente && !esEditable(existente.estado)) {
      throw new ConflictException(
        `No se puede reimportar ${mes}/${anio}. ${MOTIVO_BLOQUEO[existente.estado]}`,
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
       como sugerencia. La vista anual lee estas mismas filas: mismo motivo,
       con TTL de 60 s en vez de una hora. */
    this.catalogo.invalidar();
    this.resumenAnual.invalidar();

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

  /**
   * Con qué tipo de cambio se liquida el mes que se está importando.
   *
   * Prioridad: lo que pida quien importa > el criterio vigente del CRM > lo que
   * traiga el Excel.
   *
   * **El Excel pasó de mandar a ser el último recurso**, y es el arreglo de un
   * problema real: el `tc` de FileMaker es una celda que alguien teclea cada
   * mes, y de ahí sale el número por el que se multiplica TODO lo que se paga.
   * Un dedazo ahí no da error —da una planilla entera mal, en silencio—. La
   * clínica opera a un valor pactado, así que ese valor lo decide el CRM, donde
   * está escrito una sola vez y cambiarlo queda auditado.
   *
   * En modo AUTOMATICO se respeta el Excel como antes: ahí el TC sí varía mes a
   * mes y el archivo es quien sabe con cuál se cerró.
   */
  private async resolverTipoCambio(
    pedido: number | undefined,
    delExcel: number,
    mes: number,
    anio: number,
  ): Promise<number> {
    /* Un valor explícito en la petición gana siempre: es alguien decidiendo a
       mano para este archivo concreto. */
    if (pedido) return pedido;

    const config = await this.tipoCambio.configuracion();
    if (config.modo !== ModoTipoCambio.FIJO) return delExcel;

    /* Que no coincidan no es un error —el Excel puede traer el oficial del día
       mientras la clínica liquida al pactado— pero tiene que verse: es la única
       señal de que el archivo dice una cosa y se está pagando con otra. */
    if (delExcel && Math.abs(delExcel - config.valorFijo) > 0.0001) {
      this.logger.warn(
        `El Excel de ${mes}/${anio} trae tc=${delExcel} y se liquidará a ${config.valorFijo}: ` +
          'el CRM está en modo de tipo de cambio FIJO.',
      );
    }

    return config.valorFijo;
  }

  private resolverVendedoraId(
    fila: FilaExcel,
    vendedoras: Map<string, VendedoraComision>,
  ): string | null {
    const codigo = fila.vendedoraPk?.trim();
    return codigo ? (vendedoras.get(codigo)?.id ?? null) : null;
  }

  /* ── Consulta de periodos ───────────────────────────────────────────── */

  /**
   * El tipo de cambio del periodo más reciente, que es el que rige hoy.
   *
   * Sale del último periodo importado y no de un parámetro aparte a propósito:
   * el TC ya vive en `PeriodoComision`, lo fija administración al importar y con
   * él se liquidó ese mes. Un segundo sitio donde escribirlo sería un sitio más
   * del que puede desviarse.
   *
   * Sin periodos todavía devuelve el de referencia de la clínica y lo dice en
   * `origen`, para que la interfaz no presente como oficial un número que nadie
   * ha configurado.
   */
  async tipoCambioVigente(): Promise<{
    tipoCambio: number;
    anio: number | null;
    mes: number | null;
    origen: 'periodo' | 'defecto';
  }> {
    const ultimo = await this.prisma.periodoComision.findFirst({
      orderBy: [{ anio: 'desc' }, { mes: 'desc' }],
      select: { tipoCambio: true, anio: true, mes: true },
    });

    if (!ultimo) {
      return { tipoCambio: TIPO_CAMBIO_POR_DEFECTO, anio: null, mes: null, origen: 'defecto' };
    }

    const tipoCambio = Number(ultimo.tipoCambio);
    return tipoCambio > 0
      ? { tipoCambio, anio: ultimo.anio, mes: ultimo.mes, origen: 'periodo' }
      : { tipoCambio: TIPO_CAMBIO_POR_DEFECTO, anio: null, mes: null, origen: 'defecto' };
  }

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
    if (!esEditable(periodo.estado)) {
      throw new ConflictException(`No se puede eliminar este periodo. ${MOTIVO_BLOQUEO[periodo.estado]}`);
    }
    // Las ventas y resultados caen por onDelete: Cascade.
    await this.prisma.periodoComision.delete({ where: { id } });
    /* El mes borrado desaparece del año: sin esto seguiría pintado hasta 60 s
       en una vista que ya no tiene respaldo en la base. */
    this.resumenAnual.invalidar();
    await this.audit.registrar('PeriodoComision', id, 'ELIMINAR', usuarioId, {
      anio: periodo.anio,
      mes: periodo.mes,
    });
    return { eliminado: true };
  }

  /* ── Ciclo de vida del mes ─────────────────────────────────────────────
   *
   * No hay un `cambiarEstado(estado)` genérico, y su ausencia es la mitad del
   * arreglo. El que había aceptaba el valor que llegara sin comprobar nada:
   * `CERRADO → BORRADOR` era un salto legal, así que el candado de un mes
   * pagado dependía de que nadie eligiera mal en un desplegable.
   *
   * Ahora cada salto es un método con su propia intención, sus permisos, los
   * datos que exige y su línea de auditoría. La tabla de `estados-periodo.ts`
   * los valida a todos por igual: el nombre del método dice qué se quiere
   * hacer, la tabla dice si se puede desde donde está.
   */

  /** Lo que la pantalla necesita para pintar el panel de cierre. */
  async revision(periodoId: string) {
    const periodo = await this.obtenerPeriodo(periodoId);
    const [superAdmins, aprobaciones] = await Promise.all([
      this.superAdminsActivos(),
      this.prisma.aprobacionPeriodo.findMany({ where: { periodoId } }),
    ]);

    /*
     * Los bloqueos se calculan ANTES de que alguien pulse —enterarse por un 409
     * obliga a adivinar dónde ir— pero solo donde significan algo: en CALCULADO,
     * que es el único estado desde el que se manda a revisar.
     *
     * No es una micro-optimización: `alertas()` son once consultas agregadas
     * sobre las ventas del mes, y en un mes ya cerrado la respuesta no cambiaría
     * ni un botón de la pantalla. Pedirlas igual sería trabajo para nadie.
     */
    const bloqueos =
      periodo.estado === EstadoPeriodo.CALCULADO
        ? bloqueosParaRevision({
            ...(await this.alertas(periodoId)).totales,
            vendedorasLiquidadas: periodo._count.resultados,
          })
        : [];

    return {
      estado: periodo.estado,
      ...calcularEstadoRevision(superAdmins, aprobaciones),
      bloqueos,
      cerradoEn: periodo.cerradoEn,
      cerradoPor: periodo.cerradoPor,
      pagadoEn: periodo.pagadoEn,
      pagadoPor: periodo.pagadoPor,
      enRevisionDesde: periodo.enRevisionDesde,
    };
  }

  /** CALCULADO → EN_REVISION. A partir de aquí el mes no se toca. */
  async enviarARevision(id: string, usuarioId: string) {
    const periodo = await this.exigirTransicion(id, EstadoPeriodo.EN_REVISION);

    const alertas = await this.alertas(id);
    const bloqueos = bloqueosParaRevision({
      ...alertas.totales,
      vendedorasLiquidadas: periodo._count.resultados,
    });
    if (bloqueos.length > 0) {
      /* La compuerta. Un flujo de aprobaciones que deja revisar un mes con
         filas sin clasificar no protege nada: solo reparte la firma de un
         número que ya estaba mal. */
      throw new ConflictException(
        `El periodo todavía no se puede revisar: ${bloqueos.map(b => b.detalle).join(' ')}`,
      );
    }

    const actualizado = await this.prisma.periodoComision.update({
      where: { id },
      data: {
        estado: EstadoPeriodo.EN_REVISION,
        enRevisionDesde: new Date(),
        enviadoARevisionPor: usuarioId,
      },
    });

    this.resumenAnual.invalidar();
    await this.audit.registrar('PeriodoComision', id, 'ENVIAR_A_REVISION', usuarioId);
    return actualizado;
  }

  /**
   * Registra el visto bueno de un SUPER_ADMIN y, si ya no falta nadie, cierra.
   *
   * El cierre NO es un botón aparte: es la consecuencia de que se complete el
   * conjunto. Si fuera un paso manual habría un hueco entre "todos aprobaron" y
   * "alguien pulsó cerrar" en el que el mes está aprobado y editable a la vez.
   */
  async aprobar(id: string, usuarioId: string, comentario?: string) {
    const periodo = await this.obtenerPeriodo(id);
    if (periodo.estado !== EstadoPeriodo.EN_REVISION) {
      throw new ConflictException(
        `Solo se puede aprobar un periodo EN REVISIÓN (este está ${periodo.estado}).`,
      );
    }

    await this.prisma.aprobacionPeriodo.upsert({
      where: { periodoId_usuarioId: { periodoId: id, usuarioId } },
      create: { periodoId: id, usuarioId, comentario: comentario?.trim() || null },
      update: { comentario: comentario?.trim() || null },
    });
    await this.audit.registrar('PeriodoComision', id, 'APROBAR', usuarioId, { comentario });

    const [superAdmins, aprobaciones] = await Promise.all([
      this.superAdminsActivos(),
      this.prisma.aprobacionPeriodo.findMany({ where: { periodoId: id } }),
    ]);
    const revision = calcularEstadoRevision(superAdmins, aprobaciones);

    if (!revision.completa) {
      this.resumenAnual.invalidar();
      return { cerrado: false, ...revision };
    }

    await this.prisma.periodoComision.update({
      where: { id },
      data: {
        estado: EstadoPeriodo.CERRADO,
        cerradoEn: new Date(),
        // Quien completó el conjunto: el último visto bueno que faltaba.
        cerradoPor: usuarioId,
      },
    });
    this.resumenAnual.invalidar();
    await this.audit.registrar('PeriodoComision', id, 'CERRAR', usuarioId, {
      aprobaron: revision.aprobaron.map(a => a.nombre),
    });

    return { cerrado: true, ...revision };
  }

  /** EN_REVISION → CALCULADO. Devuelve el mes a edición y borra las firmas. */
  async rechazar(id: string, usuarioId: string, motivo: string) {
    await this.exigirTransicion(id, EstadoPeriodo.CALCULADO, EstadoPeriodo.EN_REVISION);

    const actualizado = await this.prisma.$transaction(async tx => {
      /* Las aprobaciones se borran ENTERAS, también las de quien no rechazó.
         Una firma vale para las cifras que se firmaron: si el mes vuelve a
         edición, lo que aprobaron los demás ya no describe lo que va a
         cerrarse. Conservarlas sería arrastrar un visto bueno a números que
         esa persona nunca vio. */
      await tx.aprobacionPeriodo.deleteMany({ where: { periodoId: id } });
      return tx.periodoComision.update({
        where: { id },
        data: { estado: EstadoPeriodo.CALCULADO, enRevisionDesde: null, enviadoARevisionPor: null },
      });
    });

    this.resumenAnual.invalidar();
    await this.audit.registrar('PeriodoComision', id, 'RECHAZAR', usuarioId, { motivo });
    return actualizado;
  }

  /**
   * CERRADO → CALCULADO. Solo SUPER_ADMIN y con motivo.
   *
   * **Guarda la foto de configuración que está a punto de perderse.**
   * `configuracionUsada` se pisa en cada cálculo (ver el schema), así que
   * reabrir y recalcular borraba la única respuesta a "¿con qué reglas se pagó
   * este mes?". El schema ya dice dónde vive el historial de intentos —en
   * `AuditLog`—, así que la foto viaja con esta entrada en vez de en una
   * columna nueva.
   */
  async reabrir(id: string, usuarioId: string, motivo: string) {
    const periodo = await this.exigirTransicion(id, EstadoPeriodo.CALCULADO, EstadoPeriodo.CERRADO);

    const actualizado = await this.prisma.$transaction(async tx => {
      await tx.aprobacionPeriodo.deleteMany({ where: { periodoId: id } });
      return tx.periodoComision.update({
        where: { id },
        data: {
          estado: EstadoPeriodo.CALCULADO,
          cerradoEn: null,
          cerradoPor: null,
          enRevisionDesde: null,
          enviadoARevisionPor: null,
        },
      });
    });

    this.resumenAnual.invalidar();
    await this.audit.registrar('PeriodoComision', id, 'REABRIR', usuarioId, {
      motivo,
      cerradoEn: periodo.cerradoEn,
      cerradoPor: periodo.cerradoPor,
      configuracionConLaQueSeCerro: periodo.configuracionUsada,
    });
    return actualizado;
  }

  /** CERRADO → PAGADO. Terminal: desde aquí ya no se vuelve. */
  async registrarPago(id: string, usuarioId: string) {
    await this.exigirTransicion(id, EstadoPeriodo.PAGADO, EstadoPeriodo.CERRADO);

    const actualizado = await this.prisma.periodoComision.update({
      where: { id },
      data: { estado: EstadoPeriodo.PAGADO, pagadoEn: new Date(), pagadoPor: usuarioId },
    });

    this.resumenAnual.invalidar();
    await this.audit.registrar('PeriodoComision', id, 'PAGAR', usuarioId);
    return actualizado;
  }

  /**
   * Comprueba el salto contra la tabla y devuelve el periodo.
   *
   * `desdeEsperado` es una segunda cerradura para las acciones que solo tienen
   * sentido desde un estado concreto: sin ella, "reabrir" sobre un mes
   * EN_REVISION pasaría —EN_REVISION → CALCULADO es un salto legal— pero por la
   * puerta equivocada, sin borrar aprobaciones ni pedir el motivo que sí exige
   * un rechazo.
   */
  private async exigirTransicion(
    id: string,
    hasta: EstadoPeriodo,
    desdeEsperado?: EstadoPeriodo,
  ) {
    const periodo = await this.obtenerPeriodo(id);

    if (desdeEsperado && periodo.estado !== desdeEsperado) {
      throw new ConflictException(
        `Esta acción solo se puede hacer sobre un periodo ${desdeEsperado} ` +
          `(este está ${periodo.estado}).`,
      );
    }

    if (!transicionPermitida(periodo.estado, hasta)) {
      throw new ConflictException(
        `No se puede pasar de ${periodo.estado} a ${hasta}. ${MOTIVO_BLOQUEO[periodo.estado]}`.trim(),
      );
    }

    return periodo;
  }

  /**
   * Quién puede aprobar hoy.
   *
   * Se consulta en cada lectura y no se congela al abrir la revisión: un
   * SUPER_ADMIN puede bajar a ADMIN en cualquier momento, y una lista congelada
   * dejaría el mes esperando para siempre una firma que ya nadie puede dar.
   */
  private superAdminsActivos(): Promise<Aprobador[]> {
    return this.prisma.usuario.findMany({
      where: { rol: Rol.SUPER_ADMIN, activo: true },
      select: { id: true, nombre: true },
      orderBy: { nombre: 'asc' },
    });
  }

  /* ── Vista previa de la clasificación ───────────────────────────────── */

  async listarVentas(periodoId: string, query: QueryVentasImportadasDto) {
    await this.obtenerPeriodo(periodoId);

    const buscar = terminoBusqueda(query.buscar);
    /* Todos los filtros MENOS el de vendedora.
       El resumen por agente se calcula sobre esto y no sobre `where`: si
       respetara el filtro por vendedora, al pulsar a una la respuesta traería
       solo a ella, el resumen se quedaría con una tarjeta y no habría forma de
       saltar a otra sin deseleccionar antes. El resumen es el selector, así que
       no puede depender de lo seleccionado. */
    const whereSinVendedora: Prisma.VentaImportadaWhereInput = {
      periodoId,
      ...(query.clasif ? { clasif: query.clasif } : {}),
      ...(query.canal ? { canal: query.canal } : {}),
      ...(query.tipo ? { tipo: query.tipo } : {}),
      ...(query.unidadNegocio ? { unidadNegocio: query.unidadNegocio } : {}),
      ...(query.modulo ? { modulo: query.modulo } : {}),
      ...(query.soloExcluidas ? { comisionable: false } : {}),
      ...(query.soloSinClasificar ? { requiereRevision: true } : {}),
      /* Escapado de comodines: sin esto, buscar un "20%" de descuento en el
         detalle hacía match con cualquier venta que tuviera un "20". Es el
         mismo buscador que ya se arregló una vez por decir "no existe" a
         ventas que sí existen. */
      ...(buscar
        ? {
            OR: [
              { detalle: { contains: buscar, mode: 'insensitive' } },
              { paciente: { contains: buscar, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const where: Prisma.VentaImportadaWhereInput = {
      ...whereSinVendedora,
      ...(query.vendedoraId ? { vendedoraId: query.vendedoraId } : {}),
    };

    /* El mes entero de una vendedora, para que su buscador no mienta. Fuera de
       ese caso manda la paginación normal. */
    const mesCompleto = Boolean(query.mesCompleto && query.vendedoraId);
    const { skip, take } = mesCompleto
      ? { skip: 0, take: LIMITE_MES_VENDEDORA }
      : calcularPaginacion(query);

    /*
     * El reparto por canal viaja EN LA MISMA transacción que el listado, no en
     * una petición aparte.
     *
     * La vista de desempeño lo necesita para el mes completo —contarlo sobre la
     * página daba un porcentaje del último tramo—, y la primera versión lo
     * resolvía con un endpoint propio. Pero en este proyecto el 97% del tiempo
     * de una navegación es red (190 ms de ida y vuelta contra 6-27 ms de
     * consulta): un `groupBy` más aquí es gratis, mientras que una segunda
     * petición cuesta otro viaje completo cada vez que se cambia de vendedora.
     *
     * Lleva su propio `where`, no el del listado: el porcentaje de captación es
     * del mes de la vendedora, así que no puede depender de los filtros de la
     * interfaz —si respetara el filtro por canal, siempre daría 100%—. Y filtra
     * `comisionable: true` para cuadrar con lo que se liquida.
     */
    const conCanales = Boolean(query.vendedoraId);
    const whereCanales: Prisma.VentaImportadaWhereInput = {
      periodoId,
      vendedoraId: query.vendedoraId,
      comisionable: true,
    };

    const [datos, total, agregado, porVendedoraCrudo, porCanal] = await this.prisma.$transaction([
      this.prisma.ventaImportada.findMany({
        where,
        orderBy: [{ fecha: 'asc' }, { detalle: 'asc' }],
        skip,
        take,
        include: { vendedora: { select: { id: true, nombre: true, codigo: true } } },
      }),
      this.prisma.ventaImportada.count({ where }),
      /* Totales y subtotales del FILTRO ENTERO, no de la página.
         Sumarlos en el navegador sobre `datos` daría el total de 100 filas y lo
         presentaría como el del mes — es el mismo error que ya costó caro en el
         reparto por canal y en el buscador de desempeño. Van aquí dentro porque
         la transacción ya se hacía: no cuestan un viaje de red más. */
      this.prisma.ventaImportada.aggregate({
        where,
        _count: { _all: true },
        _sum: { precio: true, ingresoNeto: true },
      }),
      this.prisma.ventaImportada.groupBy({
        by: ['vendedoraId'],
        where: whereSinVendedora,
        _count: { _all: true },
        _sum: { precio: true, ingresoNeto: true },
        orderBy: { _sum: { precio: 'desc' } },
      }),
      ...(conCanales
        ? [
            this.prisma.ventaImportada.groupBy({
              by: ['canal'],
              where: whereCanales,
              _count: { _all: true },
            }),
          ]
        : []),
    ]);

    /* Alcanzar el techo significa que el buscador de esa vista vuelve a estar
       incompleto. Se avisa en vez de callar, que es lo que lo hizo tardar en
       descubrirse la primera vez. */
    if (mesCompleto && datos.length === LIMITE_MES_VENDEDORA) {
      this.logger.warn(
        `La vendedora ${query.vendedoraId} alcanzó el tope de ${LIMITE_MES_VENDEDORA} ventas ` +
          `en el periodo ${periodoId}: su buscador de desempeño no las ve todas. Toca subir ` +
          'LIMITE_MES_VENDEDORA o mover la búsqueda al servidor.',
      );
    }

    /* El sobre tiene que describir lo que de verdad se mandó. `paginar()`
       recalcula el límite desde el DTO, así que con el mes completo diría
       "página 1 de 17, 25 por página" mientras lleva las 418 filas: hoy no se
       nota porque esta vista no tiene paginador, pero el día que alguien lo
       añada vería 17 páginas de las que 16 no existen. */
    const sobre = mesCompleto
      ? { datos, total, pagina: 1, limite: LIMITE_MES_VENDEDORA, totalPaginas: 1 }
      : paginar(datos, total, query);

    /* Los nombres salen de las filas ya traídas cuando se puede, y solo se
       consulta la tabla si algún subtotal quedó fuera de la página — con el
       filtro por vendedora puesto, que es el caso normal, no se consulta nada. */
    const nombres = new Map<string, string>();
    for (const fila of datos) {
      if (fila.vendedoraId && fila.vendedora) nombres.set(fila.vendedoraId, fila.vendedora.nombre);
    }
    const faltantes = porVendedoraCrudo
      .map(f => f.vendedoraId)
      .filter((id): id is string => Boolean(id) && !nombres.has(id as string));
    if (faltantes.length > 0) {
      const encontradas = await this.prisma.vendedoraComision.findMany({
        where: { id: { in: faltantes } },
        select: { id: true, nombre: true },
      });
      for (const v of encontradas) nombres.set(v.id, v.nombre);
    }

    const porVendedora = subtotalesPorVendedora(
      porVendedoraCrudo as unknown as FilaAgrupada[],
      nombres,
    );

    const totales: TotalesVentas = {
      ventas: agregado._count._all,
      monto: Number(agregado._sum.precio ?? 0),
      base: Number(agregado._sum.ingresoNeto ?? 0),
    };

    return { ...sobre, canales: repartoPorCanal(porCanal), totales, porVendedora };
  }

  /** Corrige a mano la clasificación de una fila; queda marcada como ajustada. */
  async ajustarVenta(id: string, dto: AjustarVentaDto, usuarioId: string) {
    const venta = await this.prisma.ventaImportada.findUnique({ where: { id } });
    if (!venta) {
      throw new NotFoundException(`Venta importada ${id} no encontrada`);
    }

    const periodo = await this.obtenerPeriodo(venta.periodoId);
    if (!esEditable(periodo.estado)) {
      throw new ConflictException(`No se puede ajustar esta venta. ${MOTIVO_BLOQUEO[periodo.estado]}`);
    }

    if (dto.vendedoraId) {
      const existe = await this.prisma.vendedoraComision.count({ where: { id: dto.vendedoraId } });
      if (existe === 0) {
        throw new BadRequestException(`La vendedora ${dto.vendedoraId} no existe`);
      }
    }

    /*
     * Excluir a mano exige motivo, y volver a incluir lo borra.
     *
     * Sin esto la fila quedaba excluida sin explicación —o peor, arrastrando el
     * motivo que le puso el clasificador, que ya no es cierto— y dentro de tres
     * meses nadie sabe si fue un error del Excel, una devolución o un criterio
     * de administración. Es dinero de una persona: tiene que quedar por qué.
     */
    if (dto.comisionable === false && !dto.motivoExclusion?.trim()) {
      throw new BadRequestException(
        'Para excluir una venta del cálculo hay que indicar el motivo.',
      );
    }

    // Cambiar la clasificación o la unidad de negocio cambia el tipo de comisión.
    const actualizada = await this.prisma.ventaImportada.update({
      where: { id },
      data: {
        ...dto,
        ...(dto.clasif || dto.unidadNegocio
          ? { tipo: determinarTipo(dto.clasif ?? venta.clasif, dto.unidadNegocio ?? venta.unidadNegocio) }
          : {}),
        /* Al reincluir, el motivo deja de aplicar: dejarlo puesto haría que la
           fila apareciera comisionando y "excluida por X" a la vez. */
        ...(dto.comisionable === true ? { motivoExclusion: null } : {}),
        // Corregirla a mano es, precisamente, haberla revisado.
        requiereRevision: false,
        ajustadaManual: true,
      },
    });

    /* Incluir o excluir una fila mueve el vendido del mes —y con él el promedio
       del trimestre— en la vista anual. */
    this.resumenAnual.invalidar();

    await this.audit.registrar('VentaImportada', id, 'AJUSTAR', usuarioId, { ...dto });
    return actualizada;
  }

  /**
   * Aplica una regla del diccionario RECIÉN CREADA a las filas que ya están
   * importadas y siguen `requiereRevision: true` — no solo a la próxima
   * importación.
   *
   * **El bug que esto arregla:** "Clasificar como…" en el panel de alertas
   * (`crearReglaDesdeServicio`, frontend) solo creaba la regla y avisaba
   * "reimporta el mes para aplicarlo" — pero recalcular el MISMO periodo no
   * vuelve a leer el Excel ni a correr `clasificarFila`, así que la fila
   * seguía en OTROSS con `requiereRevision: true` para siempre, salvo que de
   * verdad se reimportara. Administración clasificaba y recalculaba sin que
   * cambiara nada, sin ningún error que lo explicara.
   *
   * No reclasifica desde cero (eso reabriría casos ya resueltos a mano por
   * otras vías): solo toca filas que HOY siguen sin clasificar y calzan con
   * ESTA regla. `canal`/`ingresoNeto` no dependen de la clasificación —ya
   * estaban bien desde la importación— así que se dejan intactos; solo se
   * tocan los campos que de verdad dependen de `clasif`.
   */
  async reclasificarConRegla(regla: ReglaDiccionario): Promise<number> {
    const candidatas = await this.prisma.ventaImportada.findMany({
      where: {
        requiereRevision: true,
        /* Solo meses todavía editables: reclasificar toca filas, y un mes en
           revisión o cerrado no puede cambiar bajo los pies de quien lo firma.
           Antes solo excluía CERRADO, así que EN_REVISION habría entrado. */
        periodo: { estado: { in: [EstadoPeriodo.BORRADOR, EstadoPeriodo.CALCULADO] } },
        ...(regla.modulo ? { modulo: regla.modulo } : {}),
      },
      select: {
        id: true,
        detalle: true,
        modulo: true,
        precio: true,
        promocion: true,
        vendedoraPk: true,
        vendedoraNombre: true,
        unidadNegocio: true,
      },
    });

    let actualizadas = 0;
    for (const fila of candidatas) {
      const filaExcel: FilaExcel = {
        fecha: null,
        modulo: fila.modulo,
        codOrigen: null,
        estadoPlan: null,
        codItem: null,
        detalle: fila.detalle,
        pac: null,
        paciente: null,
        medicoPk: null,
        medico: null,
        // No persistido en `VentaImportada` (el export tampoco lo trae hoy):
        // `determinarUnidadNegocio` solo lo mira si la regla no fuerza una,
        // y en ese caso se conserva la que ya tenía la fila, más abajo.
        area: null,
        vendedoraPk: fila.vendedoraPk,
        vendedoraNombre: fila.vendedoraNombre,
        captacion: null,
        seguro: null,
        promocion: fila.promocion,
        precio: Number(fila.precio),
        anticipoPlan: null,
        tc: null,
        obs: null,
        clasificacionPlan: null,
        clasificacionServicio: null,
      };

      // Mismo criterio de match que usaría una importación nueva — si esta
      // regla no es la que cruzaría, no se toca.
      if (!buscarRegla(filaExcel, [regla])) continue;

      const resultado = clasificarFila(filaExcel, [regla]);
      const unidadNegocio = regla.unidadNegocio ?? fila.unidadNegocio;

      await this.prisma.ventaImportada.update({
        where: { id: fila.id },
        data: {
          clasif: resultado.clasif,
          unidadNegocio,
          tipo: determinarTipo(resultado.clasif, unidadNegocio),
          nivel: resultado.nivel,
          comisionable: resultado.comisionable,
          motivoExclusion: resultado.motivoExclusion,
          requiereRevision: false,
        },
      });
      actualizadas++;
    }

    return actualizadas;
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
      vendedorasPendientes,
      serviciosSinClasificar,
      porUnidadNegocio,
      porClasif,
      porTipo,
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
      /* Los tres agregados de abajo alimentan los contadores de los chips de
         filtro (Unidad de Negocio, Clasificación, Tipo). Van SIN filtro de
         `comisionable` a propósito: administración necesita ver el total real
         del mes por RA/clasificación/tipo, excluidas incluidas, para poder
         encontrarlas — es la misma razón por la que "Excluidas" ya se cuenta
         aparte más arriba. Del período entero, no del filtro activo en
         pantalla: así el chip nunca cambia de número mientras se usa a sí
         mismo para decidir dónde hacer clic. */
      this.prisma.ventaImportada.groupBy({
        by: ['unidadNegocio'],
        where: { periodoId },
        _count: { _all: true },
      }),
      this.prisma.ventaImportada.groupBy({
        by: ['clasif'],
        where: { periodoId },
        _count: { _all: true },
      }),
      this.prisma.ventaImportada.groupBy({
        by: ['tipo'],
        where: { periodoId },
        _count: { _all: true },
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
      porUnidadNegocio: porUnidadNegocio.map(u => ({ unidadNegocio: u.unidadNegocio, filas: u._count._all })),
      porClasif: porClasif.map(c => ({ clasif: c.clasif, filas: c._count._all })),
      porTipo: porTipo.map(t => ({ tipo: t.tipo, filas: t._count._all })),
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
    /* Las ocultas van al final —no se esconden de ESTE endpoint— porque el
       directorio de configuración es el único sitio desde donde se las puede
       volver a mostrar: filtrarlas aquí las dejaría enterradas para siempre.
       Quien decide no pintarlas es la pantalla, y con un contador a la vista. */
    const vendedoras = await this.prisma.vendedoraComision.findMany({
      orderBy: [{ oculta: 'asc' }, { configurada: 'asc' }, { nombre: 'asc' }],
    });

    /* `foto` viaja porque la ficha de desempeño pone la cara de la ejecutiva en
       su avatar, y este endpoint es el único que ya cruza vendedora con usuario
       —`Usuario.codigo` ES el `vendedora_pk` del Excel—. Además está cacheado 60 s
       en el frontend, así que las fotos se piden una vez por sesión y no en cada
       cambio de periodo. Medido en producción: 3 fotos de ~10 KB, 30 KB en total. */
    const agentes = await this.prisma.usuario.findMany({
      where: { codigo: { in: vendedoras.map(v => v.codigo) } },
      select: { id: true, nombre: true, email: true, codigo: true, activo: true, foto: true },
    });
    const porCodigo = new Map(agentes.map(a => [a.codigo, a]));

    return vendedoras.map(v => ({ ...v, agente: porCodigo.get(v.codigo) ?? null }));
  }

  /**
   * Da de alta a alguien que cobra por planilla pero no vende.
   *
   * Nace `configurada: true` porque el alta manual ES el acto de configurarla:
   * quien la crea está eligiendo su tipo, su área y su sueldo en ese momento.
   * El `configurada: false` existe para las que se autocrean al importar, que
   * son las que nadie ha mirado todavía.
   */
  async crearVendedora(datos: CrearVendedoraDto, usuarioId: string) {
    const codigo = datos.codigo.trim();
    const yaExiste = await this.prisma.vendedoraComision.findUnique({ where: { codigo } });
    if (yaExiste) {
      /* Un 409 con el nombre de quien ocupa el código, no un choque de índice:
         el caso típico es teclear el código de alguien que ya está y no
         entender por qué falla. */
      throw new ConflictException(
        `El código ${codigo} ya lo tiene "${yaExiste.nombre}". Los códigos no se repiten.`,
      );
    }

    const vendedora = await this.prisma.vendedoraComision.create({
      data: {
        codigo,
        nombre: datos.nombre.trim().slice(0, 200),
        tipo: datos.tipo ?? TipoVendedora.VENDEDORA,
        area: datos.area ?? AreaVendedora.EJECUTIVA,
        sueldoBase: datos.sueldoBase ?? 0,
        configurada: true,
      },
    });

    this.resumenAnual.invalidar();
    await this.audit.registrar('VendedoraComision', vendedora.id, 'CREAR', usuarioId, {
      codigo,
      nombre: vendedora.nombre,
      area: vendedora.area,
    });
    return vendedora;
  }

  async actualizarVendedora(
    id: string,
    datos: ActualizarVendedoraDto,
    usuarioId: string,
  ) {
    const actual = await this.prisma.vendedoraComision.findUnique({ where: { id } });
    if (!actual) {
      throw new NotFoundException(`Vendedora ${id} no encontrada`);
    }

    /* `oculta`/`motivoOculta` NO se copian del DTO: los resuelve
       `cambiosDeVisibilidad()` entero, con su regla y su fecha. Dejarlos pasar
       por el spread permitiría escribir un motivo sin ocultar a nadie. */
    const { oculta: _oculta, motivoOculta: _motivo, ...resto } = datos;

    const vendedora = await this.prisma.vendedoraComision.update({
      where: { id },
      // Editarla desde el panel es exactamente el acto de configurarla.
      data: { ...resto, configurada: true, ...this.cambiosDeVisibilidad(actual, datos) },
    });

    /* Tipo y área deciden objetivo y bonos de la vista anual; `activa` y
       `oculta` deciden si la vendedora aparece en ella. */
    this.resumenAnual.invalidar();

    await this.audit.registrar('VendedoraComision', id, 'ACTUALIZAR', usuarioId, {
      ...(datos as Record<string, unknown>),
    });
    return vendedora;
  }

  /**
   * Los campos que acompañan a un cambio de `oculta`, y la regla que lo protege.
   *
   * Ocultar exige motivo por la misma razón que excluir una venta del cálculo
   * (ver `ajustarVenta`): el efecto es que una persona desaparece de la planilla
   * que administración firma, y meses después nadie recuerda si fue un despido,
   * una renuncia o un clic equivocado. El motivo y la fecha quedan en la propia
   * fila —no solo en la auditoría— para que la pantalla pueda explicarlo sin
   * cruzar tablas.
   *
   * Volver a mostrarla limpia los dos: dejarlos puestos haría que apareciera en
   * los informes y "oculta desde marzo por despido" a la vez, que es la misma
   * incoherencia que se arregló en las ventas reincluidas.
   */
  private cambiosDeVisibilidad(
    actual: VendedoraComision,
    datos: ActualizarVendedoraDto,
  ): Prisma.VendedoraComisionUpdateInput {
    if (datos.oculta === undefined || datos.oculta === actual.oculta) {
      /* Un PATCH que no toca la visibilidad no puede arrastrar `motivoOculta`
         suelto: sin `oculta` no significa nada. */
      return {};
    }

    if (datos.oculta) {
      const motivo = datos.motivoOculta?.trim();
      if (!motivo) {
        throw new BadRequestException(
          'Para ocultar una vendedora de los informes hay que indicar el motivo.',
        );
      }
      return { oculta: true, ocultaDesde: new Date(), motivoOculta: motivo };
    }

    return { oculta: false, ocultaDesde: null, motivoOculta: null };
  }
}
