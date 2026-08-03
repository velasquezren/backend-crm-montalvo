import { Injectable } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

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
      this.contarDistintos('pac', where),
      this.contarDistintos('medicoPk', where),
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
      this.cobertura(where),
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

    // Se agrupa por el paciente del propio Excel: así también salen los que
    // todavía no tienen ficha en el CRM, que hoy son la mayoría.
    const filtro = Prisma.sql`
      ${busqueda ? Prisma.sql`AND (v."paciente" ILIKE ${'%' + busqueda + '%'} OR v."pac" ILIKE ${'%' + busqueda + '%'})` : Prisma.empty}
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
        SELECT v."pac", max(v."paciente") AS paciente, count(*) AS servicios,
               sum(v."precio") AS gastado, max(v."fecha") AS ultima,
               max(c."id") AS "clienteId"
        FROM "VentaImportada" v
        LEFT JOIN "Cliente" c ON c."pac" = v."pac"
        WHERE v."pac" IS NOT NULL ${filtro}
        GROUP BY v."pac"
        ORDER BY max(v."fecha") DESC NULLS LAST
        LIMIT ${take} OFFSET ${skip}
      `,
      this.prisma.$queryRaw<Array<{ total: bigint }>>`
        SELECT count(DISTINCT v."pac") AS total FROM "VentaImportada" v
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
        select: {
          id: true, fecha: true, modulo: true, detalle: true, precio: true,
          medico: true, medicoPk: true, seguro: true, clasif: true,
          vendedoraNombre: true, periodo: { select: { anio: true, mes: true } },
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
      /** Del Excel cuando no hay ficha: el historial no depende del CRM. */
      nombre: ficha?.nombre ?? servicios[0]?.detalle ?? codigo,
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
        ORDER BY count(*) DESC
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

  /** `COUNT(DISTINCT …)`, que Prisma no expresa con `groupBy`. */
  private async contarDistintos(
    campo: 'pac' | 'medicoPk',
    where: Prisma.VentaImportadaWhereInput,
  ): Promise<number> {
    const filas = await this.prisma.ventaImportada.findMany({
      where: { ...where, [campo]: { not: null } },
      distinct: [campo],
      select: { [campo]: true },
    });
    return filas.length;
  }

  /** Cuántos servicios encuentran la ficha del paciente en el CRM. */
  private async cobertura(where: Prisma.VentaImportadaWhereInput) {
    const [total, conPac] = await Promise.all([
      this.prisma.ventaImportada.count({ where }),
      this.prisma.ventaImportada.count({ where: { ...where, pac: { not: null } } }),
    ]);

    const enlazados = await this.prisma.$queryRaw<Array<{ total: bigint }>>`
      SELECT count(*) AS total FROM "VentaImportada" v
      JOIN "Cliente" c ON c."pac" = v."pac"
      WHERE v."pac" IS NOT NULL
    `;

    return {
      servicios: total,
      conCodigo: conPac,
      conFicha: Number(enlazados[0]?.total ?? 0),
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
