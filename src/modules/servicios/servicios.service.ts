import { Injectable } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '../../prisma/prisma-client';

import { calcularPaginacion, paginar } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  agruparNormalizado,
  departamentoDesdeCi,
  edadEnAnios,
  sexoLegible,
  SIN_DATO,
  TRAMOS_EDAD,
} from './normalizacion';
import { QueryMedicosDto, QueryPacientesDto, QueryServiciosDto } from './dto/query-servicios.dto';

/**
 * Cuántos servicios se muestran en la línea de tiempo de un paciente. No se
 * pagina porque la gracia es verla entera de un vistazo; el tope existe para que
 * un caso extremo no traiga miles de filas.
 */
const LIMITE_HISTORIAL = 500;

/**
 * Traducción de la clave que manda el cliente a la expresión SQL real.
 *
 * Los dos listados son `$queryRaw` con `GROUP BY`, así que el criterio de orden
 * acaba dentro de la consulta. **Nunca se interpola lo que llega por la URL**:
 * el DTO acota a estas claves con `@IsIn` y aquí se cambian por una expresión
 * escrita a mano. Un `ORDER BY ${req.query.orden}` es inyección SQL de manual, y
 * en estos endpoints no la salvaría ni Prisma, porque `$queryRaw` solo
 * parametriza VALORES, no fragmentos de consulta.
 */
const ORDEN_SQL_PACIENTES: Record<string, Prisma.Sql> = {
  paciente: Prisma.sql`max(v."paciente")`,
  servicios: Prisma.sql`count(*)`,
  gastado: Prisma.sql`sum(v."precio")`,
  ultima: Prisma.sql`max(v."fecha")`,
};

const ORDEN_SQL_MEDICOS: Record<string, Prisma.Sql> = {
  nombre: Prisma.sql`max(v."medico")`,
  servicios: Prisma.sql`count(*)`,
  pacientes: Prisma.sql`count(DISTINCT v."pac")`,
  ingreso: Prisma.sql`sum(v."precio")`,
  ultima: Prisma.sql`max(v."fecha")`,
};

/**
 * Arma el `ORDER BY` a partir de una clave ya validada.
 *
 * `NULLS LAST` siempre: una fila sin fecha o sin importe no es "la más pequeña",
 * es una fila incompleta del Excel, y ponerla arriba al ordenar ascendente
 * enterraría los datos reales bajo el ruido de la importación.
 */
function ordenSql(
  mapa: Record<string, Prisma.Sql>,
  clave: string | undefined,
  direccion: 'asc' | 'desc' | undefined,
  porDefecto: Prisma.Sql,
): Prisma.Sql {
  const expresion = clave ? mapa[clave] : undefined;
  if (!expresion) return porDefecto;
  return direccion === 'asc'
    ? Prisma.sql`${expresion} ASC NULLS LAST`
    : Prisma.sql`${expresion} DESC NULLS LAST`;
}

/** Fila de conteo por valor crudo, tal como la devuelve un GROUP BY. */
interface ConteoCrudo {
  valor: string | null;
  total: number | bigint;
}

/**
 * Historial de servicios de la clínica: qué se hizo, a quién y quién lo hizo.
 *
 * **Es de solo lectura.** No escribe en ninguna tabla, así que no puede alterar
 * comisiones ni fichas: se puede consultar sin miedo mientras administración
 * liquida un mes.
 *
 * La fuente es `VentaImportada`, o sea el mismo Excel mensual que alimenta la
 * planilla. Eso evita duplicar una tabla grande y mantener dos importadores,
 * pero acopla el historial al módulo de comisiones: **borrar un periodo borra
 * ese mes del historial**. La pantalla avisa de los meses cargados para que se
 * note si falta alguno.
 *
 * Sobre el cruce con la ficha del paciente: se hace por `pac`, el código de
 * FileMaker. Hoy solo cruza una parte —el maestro de pacientes está importado a
 * medias— y por eso la cobertura se expone como métrica en vez de esconderse:
 * un servicio sin ficha se sigue mostrando con el nombre que trae el Excel.
 */
@Injectable()
export class ServiciosService {
  constructor(private readonly prisma: PrismaService) {}

  /* ── Dashboard ──────────────────────────────────────────────────────── */

  async dashboard(query: QueryServiciosDto) {
    const where = this.filtroServicios(query);

    const [
      totales,
      pacientesDistintos,
      medicosDistintos,
      porModulo,
      porClasif,
      topServicios,
      porMedico,
      porMes,
      conFicha,
    ] = await Promise.all([
      this.prisma.ventaImportada.aggregate({ where, _count: true, _sum: { precio: true } }),
      this.contarDistintos('pac', query),
      this.contarDistintos('medicoPk', query),
      this.prisma.ventaImportada.groupBy({
        by: ['modulo'],
        where,
        _count: true,
        _sum: { precio: true },
      }),
      this.prisma.ventaImportada.groupBy({ by: ['clasif'], where, _count: true }),
      this.prisma.ventaImportada.groupBy({
        by: ['detalle'],
        where,
        _count: true,
        _sum: { precio: true },
        orderBy: { _count: { detalle: 'desc' } },
        take: 12,
      }),
      this.prisma.ventaImportada.groupBy({
        by: ['medicoPk', 'medico'],
        where,
        _count: true,
        _sum: { precio: true },
        orderBy: { _count: { medicoPk: 'desc' } },
        take: 12,
      }),
      this.serviciosPorMes(where),
      this.cobertura(query),
    ]);

    return {
      totales: {
        servicios: totales._count,
        pacientes: pacientesDistintos,
        medicos: medicosDistintos,
        ingreso: Number(totales._sum.precio ?? 0),
      },
      cobertura: conFicha,
      porModulo: porModulo
        .map(m => ({
          etiqueta: m.modulo ?? SIN_DATO,
          total: m._count,
          ingreso: Number(m._sum.precio ?? 0),
        }))
        .sort((a, b) => b.total - a.total),
      porClasif: porClasif
        .map(c => ({ etiqueta: c.clasif, total: c._count }))
        .sort((a, b) => b.total - a.total),
      topServicios: topServicios.map(s => ({
        etiqueta: s.detalle,
        total: s._count,
        ingreso: Number(s._sum.precio ?? 0),
      })),
      porMedico: porMedico.map(m => ({
        codigo: m.medicoPk ?? '',
        etiqueta: m.medico ?? SIN_DATO,
        total: m._count,
        ingreso: Number(m._sum.precio ?? 0),
      })),
      porMes,
    };
  }

  /**
   * Demografía de TODA la base de pacientes, no solo de quienes tienen servicio
   * cargado: son 15.000+ fichas con datos ricos frente a unos cientos que
   * cruzan, y limitarlo al cruce daría una foto pobre y sesgada.
   */
  async demografia() {
    const [porSexo, porDepartamento, porTramo, totales] = await Promise.all([
      this.prisma.cliente.groupBy({ by: ['sexo'], _count: true }),
      this.prisma.cliente.groupBy({ by: ['ciLugar'], _count: true }),
      this.pacientesPorTramoDeEdad(),
      this.prisma.cliente.aggregate({
        _count: true,
        _avg: { visitasPrevias: true },
        _sum: { saldoTotal: true },
      }),
    ]);

    const aConteo = (filas: Array<{ _count: number }>, clave: 'sexo' | 'ciLugar'): ConteoCrudo[] =>
      filas.map(f => ({ valor: (f as never as Record<string, string | null>)[clave], total: f._count }));

    return {
      total: totales._count,
      visitasPromedio: Number(totales._avg.visitasPrevias ?? 0),
      saldoAcumulado: Number(totales._sum.saldoTotal ?? 0),
      porSexo: agruparNormalizado(aConteo(porSexo, 'sexo'), sexoLegible),
      porDepartamento: agruparNormalizado(aConteo(porDepartamento, 'ciLugar'), departamentoDesdeCi),
      porTramoEdad: porTramo,
    };
  }

  /* ── Pacientes ──────────────────────────────────────────────────────── */

  /** Pacientes que tienen al menos un servicio, con su resumen. */
  async pacientes(query: QueryPacientesDto) {
    const { skip, take } = calcularPaginacion(query);
    const busqueda = query.busqueda?.trim();

    const filtro = Prisma.sql`
      ${busqueda ? Prisma.sql`AND (v."paciente" ILIKE ${'%' + busqueda + '%'} OR v."pac" ILIKE ${'%' + busqueda + '%'} OR c."nombre" ILIKE ${'%' + busqueda + '%'} OR c."ci" ILIKE ${'%' + busqueda + '%'} OR c."telefono" ILIKE ${'%' + busqueda + '%'})` : Prisma.empty}
    `;

    const [filas, total] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          pac: string | null;
          paciente: string | null;
          servicios: bigint;
          gastado: Prisma.Decimal | null;
          ultima: Date | null;
          clienteId: string | null;
        }>
      >`
        SELECT v."pac", COALESCE(max(c."nombre"), max(v."paciente")) AS paciente, count(*) AS servicios,
               sum(v."precio") AS gastado, max(v."fecha") AS ultima,
               max(c."id") AS "clienteId"
        FROM "VentaImportada" v
        LEFT JOIN "Cliente" c ON c."pac" = v."pac"
        WHERE v."pac" IS NOT NULL ${filtro}
        GROUP BY v."pac"
        ORDER BY ${ordenSql(ORDEN_SQL_PACIENTES, query.orden, query.direccion, Prisma.sql`max(v."fecha") DESC NULLS LAST`)}
        LIMIT ${take} OFFSET ${skip}
      `,
      this.prisma.$queryRaw<Array<{ total: bigint }>>`
        SELECT count(DISTINCT v."pac") AS total FROM "VentaImportada" v
        LEFT JOIN "Cliente" c ON c."pac" = v."pac"
        WHERE v."pac" IS NOT NULL ${filtro}
      `,
    ]);

    const datos = filas.map(f => ({
      pac: f.pac,
      paciente: f.paciente,
      servicios: Number(f.servicios),
      gastado: Number(f.gastado ?? 0),
      ultimaVisita: f.ultima,
      /** null = el paciente aún no tiene ficha en el CRM. */
      clienteId: f.clienteId,
    }));

    return paginar(datos, Number(total[0]?.total ?? 0), query);
  }

  /** Ficha del paciente (si existe) y su línea de tiempo de servicios. */
  async historialPaciente(pac: string) {
    const codigo = pac.toUpperCase();

    const [ficha, servicios] = await Promise.all([
      this.prisma.cliente.findUnique({
        where: { pac: codigo },
        select: {
          id: true, nombre: true, telefono: true, email: true, pac: true,
          fechaNacimiento: true, sexo: true, ocupacion: true, ciLugar: true,
          estadoCivil: true, direccion: true, nacionalidad: true,
          empresaTrabajo: true, visitasPrevias: true, saldoTotal: true,
          categoria: true, agente: { select: { id: true, nombre: true } },
        },
      }),
      this.prisma.ventaImportada.findMany({
        where: { pac: codigo },
        orderBy: [{ fecha: 'desc' }, { detalle: 'asc' }],
        // Tope duro: un paciente con años de historial no debe poder tumbar la
        // pantalla ni traerse miles de filas. Hoy el máximo real son 20.
        take: LIMITE_HISTORIAL,
        select: {
          id: true, fecha: true, modulo: true, detalle: true, precio: true,
          medico: true, medicoPk: true, seguro: true, clasif: true,
          paciente: true, vendedoraNombre: true,
          periodo: { select: { anio: true, mes: true } },
        },
      }),
    ]);

    if (!ficha && servicios.length === 0) {
      throw new NotFoundException(`No hay historial para el paciente ${pac}`);
    }

    const gastado = servicios.reduce((s, v) => s + Number(v.precio), 0);
    const edad = edadEnAnios(ficha?.fechaNacimiento ?? null);

    return {
      pac: codigo,
      /**
       * Del Excel cuando no hay ficha: el historial no depende de que el CRM
       * conozca al paciente. Es `paciente`, NO `detalle` — este último es el
       * nombre del servicio, y usarlo mostraba "Internación" como si fuera la
       * persona.
       */
      nombre: ficha?.nombre ?? servicios.find(s => s.paciente)?.paciente ?? codigo,
      ficha: ficha ? { ...ficha, edad, saldoTotal: Number(ficha.saldoTotal ?? 0) } : null,
      resumen: {
        servicios: servicios.length,
        gastado,
        primeraVisita: servicios.at(-1)?.fecha ?? null,
        ultimaVisita: servicios[0]?.fecha ?? null,
        medicos: new Set(servicios.map(s => s.medicoPk).filter(Boolean)).size,
      },
      servicios: servicios.map(s => ({ ...s, precio: Number(s.precio) })),
    };
  }

  /** Historial de servicios de un paciente por su código PAC de FileMaker (para otros dominios). */
  async historialPorPac(pac: string) {
    const codigo = pac.toUpperCase();
    return this.prisma.ventaImportada.findMany({
      where: { pac: codigo },
      orderBy: { fecha: 'desc' },
      select: {
        id: true,
        fecha: true,
        modulo: true,
        detalle: true,
        clasif: true,
        precio: true,
        medico: true,
        vendedoraNombre: true,
        periodo: { select: { anio: true, mes: true } },
      },
      take: 200,
    });
  }

  /* ── Médicos ────────────────────────────────────────────────────────── */

  async medicos(query: QueryMedicosDto) {
    const { skip, take } = calcularPaginacion(query);
    const busqueda = query.busqueda?.trim();
    const filtro = busqueda
      ? Prisma.sql`AND (v."medico" ILIKE ${'%' + busqueda + '%'} OR v."medicoPk" ILIKE ${'%' + busqueda + '%'})`
      : Prisma.empty;

    const [filas, total] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          codigo: string | null;
          nombre: string | null;
          servicios: bigint;
          pacientes: bigint;
          ingreso: Prisma.Decimal | null;
          ultima: Date | null;
        }>
      >`
        SELECT v."medicoPk" AS codigo, max(v."medico") AS nombre, count(*) AS servicios,
               count(DISTINCT v."pac") AS pacientes, sum(v."precio") AS ingreso,
               max(v."fecha") AS ultima
        FROM "VentaImportada" v
        WHERE v."medicoPk" IS NOT NULL ${filtro}
        GROUP BY v."medicoPk"
        ORDER BY ${ordenSql(ORDEN_SQL_MEDICOS, query.orden, query.direccion, Prisma.sql`count(*) DESC`)}
        LIMIT ${take} OFFSET ${skip}
      `,
      this.prisma.$queryRaw<Array<{ total: bigint }>>`
        SELECT count(DISTINCT v."medicoPk") AS total FROM "VentaImportada" v
        WHERE v."medicoPk" IS NOT NULL ${filtro}
      `,
    ]);

    const datos = filas.map(f => ({
      codigo: f.codigo,
      nombre: f.nombre,
      servicios: Number(f.servicios),
      pacientes: Number(f.pacientes),
      ingreso: Number(f.ingreso ?? 0),
      ultimaAtencion: f.ultima,
    }));

    return paginar(datos, Number(total[0]?.total ?? 0), query);
  }

  /**
   * Perfil de un médico: qué hace, a quién atiende y cuánto factura.
   *
   * Es el espejo de `historialPaciente`. El listado de médicos era un callejón
   * sin salida —se veía el total de cada uno y no se podía entrar—, así que la
   * pregunta natural de administración ("¿de qué se compone lo de este médico?")
   * no tenía respuesta en el CRM.
   *
   * Todo sale agregado de la base: ninguna de estas cifras se calcula trayendo
   * filas a memoria, porque `VentaImportada` crece un Excel por mes.
   */
  async perfilMedico(codigo: string) {
    const medicoPk = codigo.trim();
    /* El código de FileMaker es corto; un valor absurdo no es un médico, es
       ruido. Se corta aquí en vez de mandar a la base una consulta imposible. */
    if (!medicoPk || medicoPk.length > 40) {
      throw new NotFoundException(`No hay servicios del médico ${codigo}`);
    }

    const where: Prisma.VentaImportadaWhereInput = { medicoPk };

    const [totales, distintosYFechas, porModulo, topServicios, porMes, topPacientes] =
      await Promise.all([
        this.prisma.ventaImportada.aggregate({
          where,
          _count: true,
          _sum: { precio: true },
          _avg: { precio: true },
          _max: { fecha: true, medico: true },
          _min: { fecha: true },
        }),
        this.prisma.$queryRaw<Array<{ pacientes: bigint }>>`
          SELECT count(DISTINCT v."pac") AS pacientes
          FROM "VentaImportada" v WHERE v."medicoPk" = ${medicoPk}
        `,
        this.prisma.ventaImportada.groupBy({
          by: ['modulo'],
          where,
          _count: true,
          _sum: { precio: true },
        }),
        this.prisma.ventaImportada.groupBy({
          by: ['detalle'],
          where,
          _count: true,
          _sum: { precio: true },
          orderBy: { _count: { detalle: 'desc' } },
          take: 12,
        }),
        this.serviciosPorMes(where),
        /* Sus pacientes más frecuentes, con el enlace a la ficha del CRM cuando
           existe — el mismo LEFT JOIN por `pac` que usa el listado general. */
        this.prisma.$queryRaw<
          Array<{
            pac: string | null;
            paciente: string | null;
            servicios: bigint;
            gastado: Prisma.Decimal | null;
            clienteId: string | null;
          }>
        >`
          SELECT v."pac", max(v."paciente") AS paciente, count(*) AS servicios,
                 sum(v."precio") AS gastado, max(c."id") AS "clienteId"
          FROM "VentaImportada" v
          LEFT JOIN "Cliente" c ON c."pac" = v."pac"
          WHERE v."medicoPk" = ${medicoPk} AND v."pac" IS NOT NULL
          GROUP BY v."pac"
          ORDER BY count(*) DESC, sum(v."precio") DESC
          LIMIT 10
        `,
      ]);

    if (totales._count === 0) {
      throw new NotFoundException(`No hay servicios del médico ${codigo}`);
    }

    return {
      codigo: medicoPk,
      /* El nombre viaja repetido en cada fila del Excel; se toma el mayor por
         quedarnos con uno determinista sin una consulta aparte. */
      nombre: totales._max.medico ?? SIN_DATO,
      resumen: {
        servicios: totales._count,
        pacientes: Number(distintosYFechas[0]?.pacientes ?? 0),
        ingreso: Number(totales._sum.precio ?? 0),
        ticketPromedio: Number(totales._avg.precio ?? 0),
        primeraAtencion: totales._min.fecha,
        ultimaAtencion: totales._max.fecha,
      },
      porModulo: porModulo
        .map(m => ({
          etiqueta: m.modulo ?? SIN_DATO,
          total: m._count,
          ingreso: Number(m._sum.precio ?? 0),
        }))
        .sort((a, b) => b.total - a.total),
      topServicios: topServicios.map(s => ({
        etiqueta: s.detalle,
        total: s._count,
        ingreso: Number(s._sum.precio ?? 0),
      })),
      porMes,
      topPacientes: topPacientes.map(p => ({
        pac: p.pac,
        paciente: p.paciente,
        servicios: Number(p.servicios),
        gastado: Number(p.gastado ?? 0),
        /** null = ese paciente aún no tiene ficha en el CRM. */
        clienteId: p.clienteId,
      })),
    };
  }

  /* ── Ayudas privadas ────────────────────────────────────────────────── */

  private filtroServicios(query: QueryServiciosDto): Prisma.VentaImportadaWhereInput {
    return {
      periodoId: query.periodoId,
      modulo: query.modulo,
      ...(query.desde || query.hasta
        ? {
            fecha: {
              ...(query.desde ? { gte: new Date(query.desde) } : {}),
              ...(query.hasta ? { lte: new Date(query.hasta) } : {}),
            },
          }
        : {}),
    };
  }

  /**
   * `COUNT(DISTINCT …)`, que Prisma no expresa con `groupBy`.
   *
   * Va en SQL y no con `findMany({ distinct })`: eso último trae a Node una fila
   * por valor distinto solo para medir el array, y crece con cada paciente nuevo.
   */
  private async contarDistintos(
    campo: 'pac' | 'medicoPk',
    query: QueryServiciosDto,
  ): Promise<number> {
    const columna = campo === 'pac' ? Prisma.sql`v."pac"` : Prisma.sql`v."medicoPk"`;
    const filas = await this.prisma.$queryRaw<Array<{ total: bigint }>>`
      SELECT count(DISTINCT ${columna}) AS total
      FROM "VentaImportada" v
      WHERE ${columna} IS NOT NULL ${this.condicionesSql(query)}
    `;
    return Number(filas[0]?.total ?? 0);
  }

  /**
   * El mismo filtro del dashboard, expresado en SQL para las consultas crudas.
   *
   * Convive con `filtroServicios()`, que es su gemelo para Prisma. Son dos
   * escrituras del MISMO criterio y hay que cambiarlas juntas: la alternativa
   * era pasar todo el dashboard a SQL crudo y perder el tipado de `groupBy`.
   */
  private condicionesSql(query: QueryServiciosDto): Prisma.Sql {
    const partes: Prisma.Sql[] = [];
    if (query.periodoId) partes.push(Prisma.sql`AND v."periodoId" = ${query.periodoId}`);
    if (query.modulo) partes.push(Prisma.sql`AND v."modulo" = ${query.modulo}`);
    if (query.desde) partes.push(Prisma.sql`AND v."fecha" >= ${new Date(query.desde)}`);
    if (query.hasta) partes.push(Prisma.sql`AND v."fecha" <= ${new Date(query.hasta)}`);
    return partes.length > 0 ? Prisma.join(partes, ' ') : Prisma.empty;
  }

  /**
   * Cuántos servicios encuentran la ficha del paciente en el CRM.
   *
   * Las tres cifras salen de UNA consulta y con EL MISMO filtro que el resto del
   * dashboard. Antes el conteo de enlazados iba sin filtro: al acotar por módulo,
   * la insignia comparaba los enlazados de todo el historial contra los servicios
   * del módulo, y el porcentaje salía inventado.
   */
  private async cobertura(query: QueryServiciosDto) {
    const filas = await this.prisma.$queryRaw<
      Array<{ servicios: bigint; con_codigo: bigint; con_ficha: bigint }>
    >`
      SELECT count(*) AS servicios,
             count(v."pac") AS con_codigo,
             count(c."id") AS con_ficha
      FROM "VentaImportada" v
      LEFT JOIN "Cliente" c ON c."pac" = v."pac"
      WHERE TRUE ${this.condicionesSql(query)}
    `;

    const fila = filas[0];
    return {
      servicios: Number(fila?.servicios ?? 0),
      conCodigo: Number(fila?.con_codigo ?? 0),
      conFicha: Number(fila?.con_ficha ?? 0),
    };
  }

  private async serviciosPorMes(where: Prisma.VentaImportadaWhereInput) {
    const filas = await this.prisma.ventaImportada.groupBy({
      by: ['periodoId'],
      where,
      _count: true,
      _sum: { precio: true },
    });

    const periodos = await this.prisma.periodoComision.findMany({
      where: { id: { in: filas.map(f => f.periodoId) } },
      select: { id: true, anio: true, mes: true },
    });
    const porId = new Map(periodos.map(p => [p.id, p]));

    return filas
      .map(f => {
        const p = porId.get(f.periodoId);
        return {
          anio: p?.anio ?? 0,
          mes: p?.mes ?? 0,
          total: f._count,
          ingreso: Number(f._sum.precio ?? 0),
        };
      })
      .sort((a, b) => a.anio - b.anio || a.mes - b.mes);
  }

  /**
   * Reparte los pacientes en tramos de edad. Se agrupa por año de nacimiento en
   * SQL —son ~100 filas— y los tramos se arman aquí, para no repetir los cortes
   * en un `CASE` que habría que mantener sincronizado con `TRAMOS_EDAD`.
   */
  private async pacientesPorTramoDeEdad() {
    const filas = await this.prisma.$queryRaw<Array<{ anio: number | null; total: bigint }>>`
      SELECT EXTRACT(YEAR FROM "fechaNacimiento")::int AS anio, count(*) AS total
      FROM "Cliente"
      GROUP BY 1
    `;

    const hoy = new Date();
    const acumulado = new Map<string, number>(TRAMOS_EDAD.map(t => [t.etiqueta, 0]));
    acumulado.set(SIN_DATO, 0);

    for (const fila of filas) {
      // Se toma el 30 de junio como cumpleaños promedio: sin el día exacto, es
      // el punto que menos desvía a quien cae en el borde de un tramo.
      const edad = fila.anio ? edadEnAnios(new Date(fila.anio, 5, 30), hoy) : null;
      const etiqueta =
        edad === null
          ? SIN_DATO
          : (TRAMOS_EDAD.find(t => edad >= t.desde && edad <= t.hasta)?.etiqueta ?? SIN_DATO);
      acumulado.set(etiqueta, (acumulado.get(etiqueta) ?? 0) + Number(fila.total));
    }

    return [...acumulado].map(([etiqueta, total]) => ({ etiqueta, total }));
  }
}
