import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../../common/audit/audit.service';
import { calcularPaginacion, paginar } from '../../common/dto/pagination.dto';
import { EstadoCampana, Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { EnvioPlantillasService } from '../conversaciones/envio-plantillas.service';
import { validarParametros } from '../conversaciones/plantillas-whatsapp';
import { TipoCambioService } from '../tipo-cambio/tipo-cambio.service';
import { AudienciasService } from './audiencias.service';
import {
  MAXIMO_DESTINATARIOS,
  parametrosPara,
  VariableCampana,
  VENTANA_COMPRA_DIAS,
  VENTANA_RESPUESTA_DIAS,
} from './campana';
import { CrearCampanaDto, VariableCampanaDto } from './dto/crear-campana.dto';
import { QueryCampanasDto, QueryDestinatariosDto } from './dto/query-campanas.dto';

/** Lo que pasó con una campaña, contado sobre sus destinatarias y sus mensajes. */
export interface MetricasCampana {
  total: number;
  pendientes: number;
  enviados: number;
  omitidos: number;
  fallidos: number;
  /** Lo que confirmó Meta. Lo que se cobra es esto, no lo enviado. */
  entregados: number;
  leidos: number;
  /** Meta lo rechazó después de salir; `limiteMeta` es el 131049 (tope por persona). */
  rechazadosMeta: number;
  limiteMeta: number;
  /** Escribieron en el chat dentro de `VENTANA_RESPUESTA_DIAS`. */
  respondieron: number;
  /** Pidieron la baja de promociones después de recibirla. */
  bajas: number;
  /** Compraron dentro de `VENTANA_COMPRA_DIAS` (FileMaker o CRM). Correlación, no prueba de causa. */
  compraron: number;
  ingresoUsd: number;
  costoEstimadoUsd: number;
}

interface FilaMetricas {
  campana_id: string;
  total: number;
  pendientes: number;
  enviados: number;
  omitidos: number;
  fallidos: number;
  entregados: number;
  leidos: number;
  rechazados_meta: number;
  limite_meta: number;
  respondieron: number;
  bajas: number;
  compraron: number;
  ingreso_usd: number;
}

const SELECT_CAMPANA = {
  id: true,
  nombre: true,
  plantilla: true,
  idioma: true,
  variables: true,
  filtro: true,
  tarifaUsd: true,
  estado: true,
  motivoPausa: true,
  programadaPara: true,
  createdAt: true,
  terminadaEn: true,
  linea: { select: { id: true, nombre: true } },
  creadaPor: { select: { id: true, nombre: true } },
} satisfies Prisma.CampanaSelect;

type FilaCampana = Prisma.CampanaGetPayload<{ select: typeof SELECT_CAMPANA }>;

/** Lo que se puede hacer desde cada estado. Un UPDATE condicionado lo hace cumplir. */
const SE_PUEDE_PAUSAR: EstadoCampana[] = ['PROGRAMADA', 'ENVIANDO'];
const SE_PUEDE_CANCELAR: EstadoCampana[] = ['PROGRAMADA', 'ENVIANDO', 'PAUSADA'];

/**
 * Campañas: mandar una plantilla de Marketing a una audiencia, y medir qué
 * pasó. El envío lo hace `CampanasEnvioService`, a ritmo y en horario; aquí se
 * crea, se controla y se lee.
 *
 * La audiencia se CONGELA al crearla (`CampanaDestinatario`): es la que se vio,
 * contó y aprobó en Audiencias, con la misma consulta. Las métricas no se
 * copian: se cuentan sobre los mensajes, que el webhook de Meta va marcando
 * entregados y leídos.
 */
@Injectable()
export class CampanasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly audiencias: AudienciasService,
    private readonly plantillas: EnvioPlantillasService,
    private readonly tipoCambio: TipoCambioService,
  ) {}

  async crear(dto: CrearCampanaDto, usuarioId: string, ahora = new Date()) {
    const variables = this.validarVariables(dto.variables);
    const plantilla = (await this.plantillas.listarPlantillas(false, dto.lineaId)).find(
      p => p.nombre === dto.plantilla && p.idioma === dto.idioma,
    );
    if (!plantilla) {
      throw new BadRequestException('Esa plantilla no está aprobada en esta línea. Actualízalas desde Meta y elige otra.');
    }
    if (plantilla.categoria !== 'MARKETING') {
      throw new BadRequestException('Una campaña solo manda plantillas de Marketing: una de Utilidad no puede llevar publicidad.');
    }
    /* Con un nombre de prueba: si un texto fijo trae un salto de línea o falta
       una variable, se dice ahora y no a la paciente 300. */
    validarParametros(plantilla, parametrosPara(variables, 'Prueba'));

    const programadaPara = dto.programadaPara ? new Date(dto.programadaPara) : ahora;
    if (programadaPara.getTime() > ahora.getTime() + 30 * 24 * 60 * 60 * 1000) {
      throw new BadRequestException('Una campaña se programa como mucho a 30 días: la audiencia de hoy no sería la de entonces.');
    }

    const ids = await this.audiencias.idsElegibles(dto.filtro, MAXIMO_DESTINATARIOS, ahora);
    if (ids.length === 0) throw new BadRequestException('Con ese filtro no queda ninguna paciente.');
    if (ids.length > MAXIMO_DESTINATARIOS) {
      throw new BadRequestException(
        `Son más de ${MAXIMO_DESTINATARIOS.toLocaleString('es-BO')} pacientes: acota la audiencia. Meta limita a cuántas personas puede escribirle una línea por día.`,
      );
    }
    if (ids.length !== dto.elegiblesVistas) {
      throw new ConflictException(
        `La audiencia cambió mientras la mirabas: ahora son ${ids.length}, no ${dto.elegiblesVistas}. Revísala y vuelve a crearla.`,
      );
    }

    const campana = await this.prisma.$transaction(async tx => {
      const creada = await tx.campana.create({
        data: {
          nombre: dto.nombre.trim(),
          lineaId: dto.lineaId,
          plantilla: dto.plantilla,
          idioma: dto.idioma,
          variables: variables as unknown as Prisma.InputJsonValue,
          filtro: { ...dto.filtro } as unknown as Prisma.InputJsonValue,
          tarifaUsd: dto.tarifaUsd,
          estado: programadaPara > ahora ? 'PROGRAMADA' : 'ENVIANDO',
          programadaPara,
          creadaPorId: usuarioId,
        },
        select: { id: true },
      });
      await tx.campanaDestinatario.createMany({
        data: ids.map((clienteId, orden) => ({ campanaId: creada.id, clienteId, orden })),
      });
      return creada;
    });

    await this.audit.registrar('Campana', campana.id, 'CREADA', usuarioId, {
      plantilla: dto.plantilla,
      destinatarios: ids.length,
      filtro: { ...dto.filtro },
    });
    return this.detalle(campana.id);
  }

  async listar(query: QueryCampanasDto) {
    const dto = { pagina: query.pagina, limite: query.limite };
    const { skip, take } = calcularPaginacion(dto);
    const [campanas, total] = await this.prisma.$transaction([
      this.prisma.campana.findMany({ select: SELECT_CAMPANA, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.campana.count(),
    ]);
    const metricas = await this.metricas(campanas);
    return paginar(
      campanas.map(c => ({ ...this.aRespuesta(c), metricas: metricas.get(c.id) ?? metricasVacias() })),
      total,
      dto,
    );
  }

  async detalle(id: string) {
    const campana = await this.prisma.campana.findUnique({ where: { id }, select: SELECT_CAMPANA });
    if (!campana) throw new NotFoundException(`Campaña ${id} no encontrada`);
    const metricas = await this.metricas([campana]);
    return { ...this.aRespuesta(campana), metricas: metricas.get(id) ?? metricasVacias() };
  }

  /** Las pacientes de la campaña, en el orden en que salen, con lo que pasó con cada una. */
  async destinatarios(id: string, query: QueryDestinatariosDto) {
    await this.detalleMinimo(id);
    const dto = { pagina: query.pagina, limite: query.limite };
    const { skip, take } = calcularPaginacion(dto);
    const where: Prisma.CampanaDestinatarioWhereInput = { campanaId: id, ...(query.estado ? { estado: query.estado } : {}) };
    const [filas, total] = await this.prisma.$transaction([
      this.prisma.campanaDestinatario.findMany({
        where,
        orderBy: { orden: 'asc' },
        skip,
        take,
        select: {
          id: true,
          estado: true,
          motivo: true,
          enviadoEn: true,
          cliente: { select: { id: true, nombre: true, telefono: true, categoria: true } },
          mensaje: { select: { estadoEnvio: true, codigoErrorEnvio: true, entregadoEn: true, leidoEn: true } },
        },
      }),
      this.prisma.campanaDestinatario.count({ where }),
    ]);
    return paginar(filas, total, dto);
  }

  async pausar(id: string, usuarioId: string) {
    return this.cambiarEstado(id, SE_PUEDE_PAUSAR, { estado: 'PAUSADA', motivoPausa: null }, usuarioId, 'PAUSADA',
      'Solo se pausa una campaña programada o enviándose.');
  }

  /** Vuelve a salir; si su hora no llegó, vuelve a quedar programada. */
  async reanudar(id: string, usuarioId: string, ahora = new Date()) {
    const { programadaPara } = await this.detalleMinimo(id);
    const estado: EstadoCampana = programadaPara > ahora ? 'PROGRAMADA' : 'ENVIANDO';
    return this.cambiarEstado(id, ['PAUSADA'], { estado, motivoPausa: null }, usuarioId, 'REANUDADA',
      'Solo se reanuda una campaña pausada.');
  }

  /** Detenida para siempre: las pendientes quedan omitidas, con el motivo. */
  async cancelar(id: string, usuarioId: string) {
    await this.detalleMinimo(id);
    const { count } = await this.prisma.$transaction(async tx => {
      const cambio = await tx.campana.updateMany({
        where: { id, estado: { in: SE_PUEDE_CANCELAR } },
        data: { estado: 'CANCELADA', terminadaEn: new Date() },
      });
      if (cambio.count) {
        await tx.campanaDestinatario.updateMany({
          where: { campanaId: id, estado: 'PENDIENTE' },
          data: { estado: 'OMITIDO', motivo: 'Campaña cancelada' },
        });
      }
      return cambio;
    });
    if (!count) throw new ConflictException('Esta campaña ya terminó o estaba cancelada.');
    await this.audit.registrar('Campana', id, 'CANCELADA', usuarioId);
    return this.detalle(id);
  }

  private async cambiarEstado(
    id: string,
    desde: EstadoCampana[],
    data: Prisma.CampanaUpdateManyMutationInput,
    usuarioId: string,
    accion: string,
    siNoSePuede: string,
  ) {
    await this.detalleMinimo(id);
    /* Condicionado en el UPDATE y no leído antes: si el barrido la termina o
       alguien la cancela a la vez, gana uno y el otro recibe el 409. */
    const { count } = await this.prisma.campana.updateMany({ where: { id, estado: { in: desde } }, data });
    if (!count) throw new ConflictException(siNoSePuede);
    await this.audit.registrar('Campana', id, accion, usuarioId);
    return this.detalle(id);
  }

  private async detalleMinimo(id: string) {
    const campana = await this.prisma.campana.findUnique({ where: { id }, select: { id: true, programadaPara: true } });
    if (!campana) throw new NotFoundException(`Campaña ${id} no encontrada`);
    return campana;
  }

  /** Las variables, normalizadas: un `NOMBRE` sin respaldo o un `TEXTO` vacío no llegan aquí (DTO). */
  private validarVariables(variables: readonly VariableCampanaDto[]): VariableCampana[] {
    return variables.map(v =>
      v.tipo === 'NOMBRE' ? { tipo: 'NOMBRE', respaldo: (v.respaldo ?? '').trim() } : { tipo: 'TEXTO', texto: (v.texto ?? '').trim() },
    );
  }

  private aRespuesta(c: FilaCampana) {
    return { ...c, tarifaUsd: Number(c.tarifaUsd) };
  }

  /**
   * Las métricas de varias campañas en una consulta. Respondió: un mensaje
   * de la paciente en ESE chat dentro de los 7 días; compró: una venta pagada
   * (FileMaker por PAC desde el día del envío, o el CRM) dentro de los 30. Es
   * atribución simple —compró después—, no prueba de que fue por la campaña.
   */
  private async metricas(campanas: readonly FilaCampana[]): Promise<Map<string, MetricasCampana>> {
    if (campanas.length === 0) return new Map();
    const { tipoCambio } = await this.tipoCambio.vigente();
    const ids = campanas.map(c => c.id);
    const filas = await this.prisma.$queryRaw<FilaMetricas[]>`
      SELECT d."campanaId" AS campana_id,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE d.estado IN ('PENDIENTE', 'ENVIANDO'))::int AS pendientes,
        COUNT(*) FILTER (WHERE d.estado = 'ENVIADO')::int AS enviados,
        COUNT(*) FILTER (WHERE d.estado = 'OMITIDO')::int AS omitidos,
        COUNT(*) FILTER (WHERE d.estado = 'FALLIDO')::int AS fallidos,
        COUNT(*) FILTER (WHERE m."entregadoEn" IS NOT NULL OR m."estadoEnvio" IN ('ENTREGADO', 'LEIDO'))::int AS entregados,
        COUNT(*) FILTER (WHERE m."leidoEn" IS NOT NULL OR m."estadoEnvio" = 'LEIDO')::int AS leidos,
        COUNT(*) FILTER (WHERE m."estadoEnvio" = 'FALLIDO')::int AS rechazados_meta,
        COUNT(*) FILTER (WHERE m."codigoErrorEnvio" = 131049)::int AS limite_meta,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM "Mensaje" r
          WHERE r."conversacionId" = m."conversacionId" AND r.direccion = 'ENTRANTE'
            AND r."createdAt" > m."createdAt"
            AND r."createdAt" <= m."createdAt" + make_interval(days => ${VENTANA_RESPUESTA_DIAS})))::int AS respondieron,
        COUNT(*) FILTER (WHERE c."bajaPromocionesEn" > d."enviadoEn")::int AS bajas,
        COUNT(*) FILTER (WHERE COALESCE(f.usd, 0) + COALESCE(v.usd, 0) > 0)::int AS compraron,
        COALESCE(SUM(COALESCE(f.usd, 0) + COALESCE(v.usd, 0)), 0)::float8 AS ingreso_usd
      FROM "CampanaDestinatario" d
      JOIN "Cliente" c ON c.id = d."clienteId"
      LEFT JOIN "Mensaje" m ON m.id = d."mensajeId"
      LEFT JOIN LATERAL (
        SELECT SUM(i.precio) AS usd FROM "VentaImportada" i
        WHERE d."enviadoEn" IS NOT NULL AND i.pac = c.pac AND i.precio > 0
          AND i.fecha >= date_trunc('day', d."enviadoEn")
          AND i.fecha < d."enviadoEn" + make_interval(days => ${VENTANA_COMPRA_DIAS})
      ) f ON true
      LEFT JOIN LATERAL (
        SELECT SUM(x.monto) / ${tipoCambio} AS usd FROM "Venta" x
        WHERE d."enviadoEn" IS NOT NULL AND x."clienteId" = c.id AND x.estado = 'GANADA'
          AND x."createdAt" >= d."enviadoEn"
          AND x."createdAt" < d."enviadoEn" + make_interval(days => ${VENTANA_COMPRA_DIAS})
      ) v ON true
      WHERE d."campanaId" = ANY(${ids})
      GROUP BY d."campanaId"`;

    const tarifas = new Map(campanas.map(c => [c.id, Number(c.tarifaUsd)]));
    return new Map(
      filas.map(f => [
        f.campana_id,
        {
          total: f.total,
          pendientes: f.pendientes,
          enviados: f.enviados,
          omitidos: f.omitidos,
          fallidos: f.fallidos,
          entregados: f.entregados,
          leidos: f.leidos,
          rechazadosMeta: f.rechazados_meta,
          limiteMeta: f.limite_meta,
          respondieron: f.respondieron,
          bajas: f.bajas,
          compraron: f.compraron,
          ingresoUsd: Math.round(f.ingreso_usd * 100) / 100,
          costoEstimadoUsd: Math.round(f.entregados * (tarifas.get(f.campana_id) ?? 0) * 100) / 100,
        },
      ]),
    );
  }
}

function metricasVacias(): MetricasCampana {
  return {
    total: 0, pendientes: 0, enviados: 0, omitidos: 0, fallidos: 0, entregados: 0, leidos: 0,
    rechazadosMeta: 0, limiteMeta: 0, respondieron: 0, bajas: 0, compraron: 0, ingresoUsd: 0, costoEstimadoUsd: 0,
  };
}
