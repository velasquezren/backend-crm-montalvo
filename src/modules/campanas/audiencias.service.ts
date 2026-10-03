import { Injectable } from '@nestjs/common';

import { calcularPaginacion, paginar, RespuestaPaginada } from '../../common/dto/pagination.dto';
import { CategoriaCliente, Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { inicioDeVentana, valorDePacientesSql } from '../clientes/categoria-paciente';
import { TipoCambioService } from '../tipo-cambio/tipo-cambio.service';
import { CATEGORIAS_POR_DEFECTO, DIAS_SIN_CAMPANA_POR_DEFECTO, QueryAudienciaDto } from './dto/query-audiencia.dto';

/** Quiénes forman la audiencia: lo de `QueryAudienciaDto` sin la paginación. */
export type FiltroAudiencia = Pick<QueryAudienciaDto, 'categorias' | 'diasSinCampana' | 'soloConversaron'>;

/**
 * Por qué una paciente de las categorías elegidas queda fuera de la audiencia,
 * en el orden en que se aplica: cuenta el PRIMER motivo, así los números del
 * embudo suman exactamente el total.
 */
export const MOTIVOS_EXCLUSION = ['BAJA_PROMOCIONES', 'SIN_CELULAR', 'CAMPANA_RECIENTE', 'SIN_CONVERSAR'] as const;
export type MotivoExclusion = (typeof MOTIVOS_EXCLUSION)[number];

/** Una paciente a la que hoy conviene escribirle. */
export interface PacienteDeAudiencia {
  id: string;
  nombre: string;
  telefono: string;
  pac: string | null;
  categoria: CategoriaCliente;
  /** Dólares gastados en los últimos 12 meses (FileMaker + CRM). */
  gastoRecienteUsd: number;
  ultimaCompra: Date | null;
  /** Nos escribió alguna vez por WhatsApp. */
  converso: boolean;
  /** El último mensaje que le mandamos lo leyó; `null` si nunca le escribimos. */
  leyoUltimo: boolean | null;
  agente: { id: string; nombre: string } | null;
}

export interface ResumenAudiencia {
  /** Pacientes en las categorías elegidas: el punto de partida del embudo. */
  enCategorias: number;
  excluidas: Record<MotivoExclusion, number>;
  elegibles: number;
  elegiblesPorCategoria: Record<CategoriaCliente, number>;
  /** Elegibles que ya conversaron: las más probables de leer. */
  elegiblesQueConversaron: number;
}

interface FilaResumen {
  categoria: CategoriaCliente;
  motivo: MotivoExclusion | null;
  converso: boolean;
  n: number;
}

interface FilaPaciente {
  id: string;
  nombre: string;
  telefono: string;
  pac: string | null;
  categoria: CategoriaCliente;
  gasto: number;
  /** ISO con zona, tal como sale de `json_agg`. */
  ultima_compra: string | null;
  converso: boolean;
  leyo_ultimo: boolean | null;
  agente_id: string | null;
  agente_nombre: string | null;
}

/**
 * Celular de WhatsApp al que una campaña puede llegar: un móvil boliviano
 * (+591 6… o 7…, ocho dígitos) o un número de otro país que no sea de EE. UU.
 * y Canadá (+1), adonde Meta no entrega marketing desde abril de 2025. Un fijo
 * boliviano —muchos vienen de FileMaker— no tiene WhatsApp.
 */
const CELULAR = Prisma.sql`(c.telefono ~ '^\\+591[67][0-9]{7}$' OR (c.telefono !~ '^\\+591' AND c.telefono !~ '^\\+1'))`;

/**
 * Audiencias: a quién vale la pena mandarle una campaña HOY.
 *
 * Cruza dos preguntas que no se mezclan:
 *  - **cuánto vale** —la categoría por valor, `clientes/categoria-paciente.ts`—;
 *  - **si conviene escribirle ahora** —no pidió la baja, tiene celular, no
 *    recibió otra campaña hace poco y, si se pide, ya conversó con la clínica—.
 *
 * Es lo que Meta premia: limita cuántas plantillas de marketing recibe cada
 * persona según cuánto lee, así que mandar a todas sale caro y baja la calidad
 * de la línea; mandar a quien vale la pena y lee, rinde más.
 *
 * Solo LEE. El envío masivo es otra fase, y el CRM ya rechaza una plantilla de
 * marketing a quien pidió la baja (`verificarPromociones`).
 */
@Injectable()
export class AudienciasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tipoCambio: TipoCambioService,
  ) {}

  async segmentar(
    query: QueryAudienciaDto,
    ahora = new Date(),
  ): Promise<RespuestaPaginada<PacienteDeAudiencia> & { resumen: ResumenAudiencia }> {
    const base = await this.baseSql(query, ahora);
    const dto = { pagina: query.pagina, limite: query.limite };
    const { skip, take } = calcularPaginacion(dto);

    /* Embudo y página en UNA sentencia sobre la misma CTE, materializada: la
       audiencia se calcula una vez (con todas las Prospecto son ~1,2 s en
       producción) y el total que se pagina es exactamente el «elegibles» del
       resumen. Cada parte vuelve como JSON; las fechas, con zona, para que no
       se lean como hora local. */
    const [{ resumen, pagina }] = await this.prisma.$queryRaw<[{ resumen: FilaResumen[]; pagina: FilaPaciente[] }]>`
      WITH ${base},
      conteo AS (
        SELECT categoria, motivo, converso, COUNT(*)::int AS n FROM audiencia GROUP BY 1, 2, 3
      ),
      elegidas AS (
        SELECT a.id, a.nombre, a.telefono, a.pac, a.categoria, a.gasto::float8 AS gasto,
               a.ultima_compra AT TIME ZONE 'UTC' AS ultima_compra, a.converso, a.leyo_ultimo,
               u.id AS agente_id, u.nombre AS agente_nombre,
               ROW_NUMBER() OVER (ORDER BY a.gasto DESC, a.nombre ASC, a.id ASC) AS orden
        FROM audiencia a
        LEFT JOIN "Usuario" u ON u.id = a."agenteId"
        WHERE a.motivo IS NULL
        ORDER BY orden
        LIMIT ${take} OFFSET ${skip}
      )
      SELECT (SELECT COALESCE(json_agg(c), '[]') FROM conteo c) AS resumen,
             (SELECT COALESCE(json_agg(e ORDER BY e.orden), '[]') FROM elegidas e) AS pagina`;

    const total = resumirAudiencia(resumen);
    return {
      ...paginar(pagina.map(aPaciente), total.elegibles, dto),
      resumen: total,
    };
  }

  /**
   * Las elegibles de la audiencia, TODAS y de más a menos gasto, para
   * congelarla en una campaña. Misma CTE que `segmentar`: lo que se manda es
   * exactamente lo que se vio. Pide una de más que el tope para que quien
   * llama sepa que se pasó, en vez de cortar callado.
   */
  async idsElegibles(filtro: FiltroAudiencia, tope: number, ahora = new Date()): Promise<string[]> {
    const base = await this.baseSql(filtro, ahora);
    const filas = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH ${base}
      SELECT id FROM audiencia WHERE motivo IS NULL
      ORDER BY gasto DESC, nombre ASC, id ASC
      LIMIT ${tope + 1}`;
    return filas.map(f => f.id);
  }

  /**
   * La audiencia completa como CTE `audiencia`: una fila por paciente de las
   * categorías elegidas, con su valor, sus señales de WhatsApp y el primer
   * motivo por el que queda fuera (`null` = elegible).
   */
  private async baseSql(query: FiltroAudiencia, ahora: Date): Promise<Prisma.Sql> {
    const { tipoCambio } = await this.tipoCambio.vigente();
    const categorias = query.categorias?.length ? query.categorias : [...CATEGORIAS_POR_DEFECTO];
    const dias = query.diasSinCampana ?? DIAS_SIN_CAMPANA_POR_DEFECTO;
    const corteCampana = new Date(ahora.getTime() - dias * 24 * 60 * 60 * 1000);
    const exigirConversacion = query.soloConversaron === true;

    /* Las señales de WhatsApp miran TODOS los chats de la paciente, de
       cualquier línea: una campaña sale por una, pero lo que leyó o recibió
       por otra también cuenta para Meta. Cada subconsulta va por los índices
       `Conversacion(clienteId, lineaId)` y `Mensaje(conversacionId, createdAt)`. */
    return Prisma.sql`
      ${valorDePacientesSql(inicioDeVentana(ahora), tipoCambio)},
      senales AS (
        SELECT c.id, c.nombre, c.telefono, c.pac, c.categoria, c."agenteId",
               COALESCE(f.reciente, 0) + COALESCE(r.reciente, 0) AS gasto,
               NULLIF(GREATEST(COALESCE(f.ultima, '-infinity'), COALESCE(r.ultima, '-infinity')), '-infinity') AS ultima_compra,
               c."bajaPromocionesEn" IS NOT NULL AS baja,
               ${CELULAR} AS celular,
               ${dias > 0
                 ? Prisma.sql`EXISTS (
                     SELECT 1 FROM "Conversacion" k JOIN "Mensaje" m ON m."conversacionId" = k.id
                     WHERE k."clienteId" = c.id AND m.direccion = 'SALIENTE'
                       AND m."plantillaCategoria" = 'MARKETING' AND m."createdAt" >= ${corteCampana})`
                 : Prisma.sql`false`} AS campana_reciente,
               EXISTS (
                 SELECT 1 FROM "Conversacion" k JOIN "Mensaje" m ON m."conversacionId" = k.id
                 WHERE k."clienteId" = c.id AND m.direccion = 'ENTRANTE') AS converso,
               (SELECT m."leidoEn" IS NOT NULL
                  FROM "Conversacion" k JOIN "Mensaje" m ON m."conversacionId" = k.id
                 WHERE k."clienteId" = c.id AND m.direccion = 'SALIENTE'
                   /* Lo que mandó una persona o una campaña; no el acuse ni la ubicación. */
                   AND (m.automatico = false OR m."plantillaCategoria" IS NOT NULL)
                 ORDER BY m."createdAt" DESC LIMIT 1) AS leyo_ultimo
        FROM "Cliente" c
        LEFT JOIN filemaker f ON f.pac = c.pac
        LEFT JOIN crm r ON r."clienteId" = c.id
        WHERE c.categoria = ANY(${categorias}::"CategoriaCliente"[])
      ),
      audiencia AS MATERIALIZED (
        SELECT s.*,
               CASE
                 WHEN s.baja THEN 'BAJA_PROMOCIONES'
                 WHEN NOT s.celular THEN 'SIN_CELULAR'
                 WHEN s.campana_reciente THEN 'CAMPANA_RECIENTE'
                 WHEN ${exigirConversacion} AND NOT s.converso THEN 'SIN_CONVERSAR'
               END AS motivo
        FROM senales s
      )`;
  }
}

/** El embudo, a partir de los conteos por categoría, motivo y conversación. */
export function resumirAudiencia(filas: readonly FilaResumen[]): ResumenAudiencia {
  const resumen: ResumenAudiencia = {
    enCategorias: 0,
    excluidas: { BAJA_PROMOCIONES: 0, SIN_CELULAR: 0, CAMPANA_RECIENTE: 0, SIN_CONVERSAR: 0 },
    elegibles: 0,
    elegiblesPorCategoria: { GOLD: 0, SILVER: 0, BRONZE: 0, PROSPECTO: 0 },
    elegiblesQueConversaron: 0,
  };
  for (const { categoria, motivo, converso, n } of filas) {
    const cuantas = n;
    resumen.enCategorias += cuantas;
    if (motivo) {
      resumen.excluidas[motivo] += cuantas;
      continue;
    }
    resumen.elegibles += cuantas;
    resumen.elegiblesPorCategoria[categoria] += cuantas;
    if (converso) resumen.elegiblesQueConversaron += cuantas;
  }
  return resumen;
}

function aPaciente(fila: FilaPaciente): PacienteDeAudiencia {
  return {
    id: fila.id,
    nombre: fila.nombre,
    telefono: fila.telefono,
    pac: fila.pac,
    categoria: fila.categoria,
    gastoRecienteUsd: Math.round(fila.gasto * 100) / 100,
    ultimaCompra: fila.ultima_compra ? new Date(fila.ultima_compra) : null,
    converso: fila.converso,
    leyoUltimo: fila.leyo_ultimo,
    agente: fila.agente_id ? { id: fila.agente_id, nombre: fila.agente_nombre ?? '' } : null,
  };
}
