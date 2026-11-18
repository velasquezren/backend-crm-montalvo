import { Injectable } from '@nestjs/common';

import { AuditService } from '../../common/audit/audit.service';
import { UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { calcularPaginacion, paginar, RespuestaPaginada } from '../../common/dto/pagination.dto';
import { inicioDelMesClinica } from '../../common/fechas/zona-clinica';
import { EstadoMensaje, Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { PROPOSITO_INFORMES } from '../conversaciones/interacciones-integracion';
import { RESPUESTA_PDF_AVISO } from './aviso-informe-pdf';
import { QueryConstanciaDto } from './dto/query-constancia.dto';
import { PREFIJO_INFORME_CHAT } from './informes-chat.service';
import { InformeConstancia, PortalResultadosClient, UsoPortal } from './portal-resultados.client';
import { ACCION_AVISO_ENVIADO } from './resultados.service';

/** Un estado de entrega de WhatsApp con sus marcas de tiempo, tal como lo dejó Meta. */
export interface EntregaWhatsapp {
  estado: EstadoMensaje | null;
  /** Cuándo el CRM lo registró y lo pasó a Meta. */
  enviadoEn: Date;
  entregadoEn: Date | null;
  leidoEn: Date | null;
  codigoError: number | null;
}

/** Un aviso de resultado enviado, con todo lo que consta de lo que pasó después. */
export interface FilaConstancia {
  avisoId: string;
  enviadoEn: Date;
  /** Quién lo envió: la cuenta del CRM y, si salió desde FileMaker, la cuenta de FileMaker. */
  enviadoPor: { nombre: string | null; usuarioFilemaker: string | null };
  /**
   * La ficha cuyo WhatsApp recibió el aviso. `telefonoAlEnviar: false` = el
   * aviso es anterior al 18/11/2026 y no guardó el número: se muestra el
   * ACTUAL de la ficha, que pudo cambiar. `null` = la ficha ya no existe.
   */
  destinatario: { nombre: string; telefono: string | null; telefonoAlEnviar: boolean; otraFicha: boolean } | null;
  informeId: string;
  /** Del portal; si el informe ya no existe allí, el nombre del estudio que quedó en la auditoría. */
  estudio: string | null;
  /** Lo que sabe el portal del informe; `null` si ya no existe en el portal. */
  informe: Omit<InformeConstancia, 'informeId' | 'estudio' | 'acceso' | 'descargas'> | null;
  /** El aviso por WhatsApp. `null` = aviso antiguo cuyo mensaje ya no se puede ubicar. */
  whatsapp: EntregaWhatsapp | null;
  /**
   * La línea de WhatsApp por la que salió: no siempre es la de la clínica
   * (LABORATORIO sale por la de Laboratorio Climon). `null` si no hay mensaje.
   */
  linea: { nombre: string; telefono: string | null } | null;
  /**
   * Lo que hizo el paciente con el enlace del portal. `primera` es la más
   * temprana entre abrir la página y ver o guardar el PDF. `null` = el
   * informe ya no existe en el portal.
   */
  portal: { primera: string | null; pdf: UsoPortal | null; original: UsoPortal | null; adjuntos: UsoPortal | null } | null;
  /** Cada vez que el paciente pidió el PDF por el chat («Recibir PDF»), y el envío que salió. */
  pdfPorWhatsapp: Array<{ solicitadoEn: Date; envio: EntregaWhatsapp | null }>;
}

export interface ConstanciaMensual extends RespuestaPaginada<FilaConstancia> {
  mes: string;
  /** El mes en hora de La Paz: desde (incluido) hasta (excluido). */
  desde: Date;
  hasta: Date;
  generadoEn: Date;
}

/** Lo que guarda la auditoría de cada aviso (`ResultadosService.entregar`). */
interface DetalleAuditoria {
  informeId?: string;
  clienteId?: string;
  estudio?: string;
  mensajeId?: string;
  telefono?: string | null;
  usuarioFilemaker?: string;
  destino?: string;
}

/** Un envío antes de cruzarlo con mensajes, fichas y portal. */
interface Envio {
  avisoId: string;
  informeId: string;
  clienteId: string | null;
  enviadoPorId: string | null;
  mensajeId: string | null;
  /** `undefined` = la auditoría no lo guardó (anterior al 18/11/2026). */
  telefono: string | null | undefined;
  estudio: string | null;
  usuarioFilemaker: string | null;
  otraFicha: boolean;
  registradoEn: Date;
}

/**
 * Constancia mensual de entregas de resultados (18/11/2026): por cada aviso
 * de resultado enviado en el mes, a quién y a qué número, qué informe, cuándo,
 * qué dijo WhatsApp (entregado, leído), qué hizo el paciente con el enlace del
 * portal y si pidió el PDF por el chat. La clínica la imprime para
 * notariarla, así que dice solo lo que consta y marca lo que no.
 *
 * **La fuente es la auditoría `RESULTADO_ENVIADO`, no `AvisoResultado`.** La
 * fila del aviso se borra al renovar un enlace vencido o al reintentar uno
 * fallido (`ResultadosService.reservar`), y con ella se perdería el primer
 * envío. La auditoría queda. Se suman los avisos que, por un fallo al
 * escribirla (es best-effort), no la tengan.
 *
 * Solo lectura sobre tablas de Conversaciones y Clientes: agregar para
 * informar está permitido; nada se escribe fuera de la auditoría propia.
 */
@Injectable()
export class ConstanciaResultadosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly portal: PortalResultadosClient,
    private readonly audit: AuditService,
  ) {}

  async mensual(query: QueryConstanciaDto, usuario: UsuarioJwt, ahora = new Date()): Promise<ConstanciaMensual> {
    const { desde, hasta } = rangoDelMes(query.mes);
    const { skip, take } = calcularPaginacion(query);
    const [pagina, total] = await Promise.all([this.pagina(desde, hasta, skip, take), this.total(desde, hasta)]);
    const envios = await this.envios(pagina);
    const datos = await this.filas(envios);
    /* Una vez por constancia, no por página: queda quién la sacó y cuándo. */
    if ((query.pagina ?? 1) === 1) {
      await this.audit.registrar('ConstanciaResultados', query.mes, 'CONSTANCIA_RESULTADOS_GENERADA', usuario.sub, { mes: query.mes, total });
    }
    return { ...paginar(datos, total, query), mes: query.mes, desde, hasta, generadoEn: ahora };
  }

  /**
   * Los ids de una página, en SQL: auditorías del mes y, aparte, los avisos
   * del mes sin auditoría. Ordenados por cuándo salieron.
   */
  private pagina(desde: Date, hasta: Date, skip: number, take: number) {
    return this.prisma.$queryRaw<Array<{ fuente: 'AUDITORIA' | 'AVISO'; id: string }>>`
      WITH envios AS (${enviosDelMes(desde, hasta)})
      SELECT fuente, id FROM envios ORDER BY en, id LIMIT ${take} OFFSET ${skip}`;
  }

  private async total(desde: Date, hasta: Date): Promise<number> {
    const [{ total }] = await this.prisma.$queryRaw<Array<{ total: number }>>`
      WITH envios AS (${enviosDelMes(desde, hasta)})
      SELECT count(*)::int AS total FROM envios`;
    return total;
  }

  /** Cada id de la página como un envío, con lo que dice su auditoría y su aviso. */
  private async envios(pagina: Array<{ fuente: 'AUDITORIA' | 'AVISO'; id: string }>): Promise<Envio[]> {
    const idsAuditoria = pagina.filter(p => p.fuente === 'AUDITORIA').map(p => p.id);
    const auditorias = idsAuditoria.length
      ? await this.prisma.auditLog.findMany({ where: { id: { in: idsAuditoria } }, select: { id: true, entidadId: true, usuarioId: true, cambios: true, createdAt: true } })
      : [];
    const porAuditoria = new Map(auditorias.map(a => [a.id, a]));
    const idsAviso = [...auditorias.map(a => a.entidadId), ...pagina.filter(p => p.fuente === 'AVISO').map(p => p.id)];
    const avisos = idsAviso.length
      ? await this.prisma.avisoResultado.findMany({
          where: { id: { in: idsAviso } },
          select: { id: true, informeId: true, clienteId: true, enviadoPorId: true, mensajeId: true, enviadoEn: true },
        })
      : [];
    const porAviso = new Map(avisos.map(a => [a.id, a]));

    return pagina.flatMap((p): Envio[] => {
      if (p.fuente === 'AVISO') {
        const aviso = porAviso.get(p.id);
        if (!aviso) return [];
        return [{ avisoId: aviso.id, informeId: aviso.informeId, clienteId: aviso.clienteId, enviadoPorId: aviso.enviadoPorId,
          mensajeId: aviso.mensajeId, telefono: undefined, estudio: null, usuarioFilemaker: null, otraFicha: false, registradoEn: aviso.enviadoEn }];
      }
      const auditoria = porAuditoria.get(p.id);
      if (!auditoria) return [];
      const d = detalle(auditoria.cambios);
      const aviso = porAviso.get(auditoria.entidadId);
      const informeId = d.informeId ?? aviso?.informeId;
      if (!informeId) return [];
      return [{
        avisoId: auditoria.entidadId,
        informeId,
        clienteId: d.clienteId ?? aviso?.clienteId ?? null,
        enviadoPorId: auditoria.usuarioId ?? aviso?.enviadoPorId ?? null,
        mensajeId: d.mensajeId ?? aviso?.mensajeId ?? null,
        telefono: d.telefono,
        estudio: d.estudio ?? null,
        usuarioFilemaker: d.usuarioFilemaker ?? null,
        otraFicha: d.destino === 'OTRA_FICHA',
        registradoEn: aviso?.enviadoEn ?? auditoria.createdAt,
      }];
    });
  }

  /** Cruza los envíos con sus mensajes, fichas, cuentas, el portal y los pedidos de PDF. En lote. */
  private async filas(envios: Envio[]): Promise<FilaConstancia[]> {
    if (!envios.length) return [];
    const unicos = <T>(xs: Array<T | null | undefined>) => [...new Set(xs.filter((x): x is T => x != null))];
    const [mensajes, clientes, usuarios, portal] = await Promise.all([
      this.prisma.mensaje.findMany({
        where: { id: { in: unicos(envios.map(e => e.mensajeId)) } },
        select: {
          id: true, conversacionId: true, createdAt: true, estadoEnvio: true, entregadoEn: true, leidoEn: true, codigoErrorEnvio: true,
          conversacion: { select: { linea: { select: { nombre: true, telefono: true } } } },
        },
      }),
      this.prisma.cliente.findMany({ where: { id: { in: unicos(envios.map(e => e.clienteId)) } }, select: { id: true, nombre: true, telefono: true } }),
      this.prisma.usuario.findMany({ where: { id: { in: unicos(envios.map(e => e.enviadoPorId)) } }, select: { id: true, nombre: true } }),
      /* Si el portal no responde, la constancia falla entera (503): una
         constancia para notariar no se imprime con la mitad de los datos. */
      this.portal.constancia(unicos(envios.map(e => e.informeId))),
    ]);
    const porMensaje = new Map(mensajes.map(m => [m.id, m]));
    const porCliente = new Map(clientes.map(c => [c.id, c]));
    const porUsuario = new Map(usuarios.map(u => [u.id, u.nombre]));
    const porInforme = new Map(portal.datos.map(i => [i.informeId, i]));
    const pedidos = await this.pedidosDePdf(envios, porMensaje);

    return envios.map((e): FilaConstancia => {
      const mensaje = e.mensajeId ? porMensaje.get(e.mensajeId) : undefined;
      const cliente = e.clienteId ? porCliente.get(e.clienteId) : undefined;
      const informe = porInforme.get(e.informeId);
      return {
        avisoId: e.avisoId,
        enviadoEn: mensaje?.createdAt ?? e.registradoEn,
        enviadoPor: { nombre: e.enviadoPorId ? (porUsuario.get(e.enviadoPorId) ?? null) : null, usuarioFilemaker: e.usuarioFilemaker },
        destinatario: cliente
          ? { nombre: cliente.nombre, telefono: e.telefono !== undefined ? e.telefono : cliente.telefono, telefonoAlEnviar: e.telefono !== undefined, otraFicha: e.otraFicha }
          : null,
        informeId: e.informeId,
        estudio: informe?.estudio ?? e.estudio,
        informe: informe
          ? { tipo: informe.tipo, fechaEstudio: informe.fechaEstudio, estado: informe.estado, publicadoEn: informe.publicadoEn,
              retiradoEn: informe.retiradoEn, paciente: informe.paciente, medico: informe.medico }
          : null,
        whatsapp: mensaje ? entrega(mensaje) : null,
        linea: mensaje ? { nombre: mensaje.conversacion.linea.nombre, telefono: mensaje.conversacion.linea.telefono } : null,
        portal: informe
          ? { primera: primeraApertura(informe.acceso?.abiertoEn ?? null, informe.descargas), ...informe.descargas }
          : null,
        pdfPorWhatsapp: pedidos.get(e.avisoId) ?? [],
      };
    });
  }

  /**
   * Los «Recibir PDF» del paciente sobre cada aviso, con el PDF que salió.
   *
   * El toque queda en `InteraccionMensaje` del mensaje entrante (la purga no
   * borra los de informes): `contextoId` es el aviso al que respondió. Un
   * informe pedido desde «Mis informes» trae su id en la selección y se le
   * asigna al último aviso de ese informe anterior al toque, en el mismo chat.
   * Solo cuentan los CORRELACIONADOS: un segundo toque en 10 minutos queda
   * DUPLICADO y no manda otro PDF.
   */
  private async pedidosDePdf(
    envios: Envio[],
    mensajes: Map<string, { id: string; conversacionId: string; createdAt: Date }>,
  ): Promise<Map<string, FilaConstancia['pdfPorWhatsapp']>> {
    const resultado = new Map<string, FilaConstancia['pdfPorWhatsapp']>();
    const conAviso = envios.flatMap(e => {
      const m = e.mensajeId ? mensajes.get(e.mensajeId) : undefined;
      return m ? [{ envio: e, conversacionId: m.conversacionId, enviadoEn: m.createdAt }] : [];
    });
    if (!conAviso.length) return resultado;
    const chats = [...new Set(conAviso.map(c => c.conversacionId))];
    const toques = await this.prisma.interaccionMensaje.findMany({
      where: {
        estado: 'CORRELACIONADA',
        vista: { path: ['proposito'], equals: PROPOSITO_INFORMES },
        mensaje: { conversacionId: { in: chats }, direccion: 'ENTRANTE' },
      },
      select: { mensajeId: true, vista: true, mensaje: { select: { conversacionId: true, createdAt: true } } },
    });
    if (!toques.length) return resultado;
    const pdfs = await this.prisma.mensaje.findMany({
      where: { conversacionId: { in: chats }, direccion: 'SALIENTE', mediaKey: { in: toques.map(t => `${PREFIJO_INFORME_CHAT}${t.mensajeId}`) } },
      select: { mediaKey: true, createdAt: true, estadoEnvio: true, entregadoEn: true, leidoEn: true, codigoErrorEnvio: true },
    });
    const pdfDe = new Map(pdfs.map(p => [p.mediaKey, p]));

    for (const toque of toques) {
      const vista = (toque.vista ?? {}) as { seleccionId?: unknown; contextoId?: unknown };
      const seleccion = typeof vista.seleccionId === 'string' ? vista.seleccionId : '';
      let destino: Envio | undefined;
      if (seleccion === RESPUESTA_PDF_AVISO) {
        destino = conAviso.find(c => c.envio.mensajeId === vista.contextoId)?.envio;
      } else if (seleccion.startsWith('INFORME_')) {
        const informeId = seleccion.slice('INFORME_'.length);
        destino = conAviso
          .filter(c => c.envio.informeId === informeId && c.conversacionId === toque.mensaje.conversacionId && c.enviadoEn <= toque.mensaje.createdAt)
          .sort((a, b) => b.enviadoEn.getTime() - a.enviadoEn.getTime())[0]?.envio;
      }
      if (!destino) continue;
      const pdf = pdfDe.get(`${PREFIJO_INFORME_CHAT}${toque.mensajeId}`);
      const lista = resultado.get(destino.avisoId) ?? [];
      lista.push({ solicitadoEn: toque.mensaje.createdAt, envio: pdf ? entrega(pdf) : null });
      resultado.set(destino.avisoId, lista);
    }
    for (const lista of resultado.values()) lista.sort((a, b) => a.solicitadoEn.getTime() - b.solicitadoEn.getTime());
    return resultado;
  }
}

/** `2026-11` → el mes en el calendario de La Paz. El día 15 a mediodía está lejos de cualquier borde. */
export function rangoDelMes(mes: string): { desde: Date; hasta: Date } {
  const [anio, numero] = mes.split('-').map(Number);
  const referencia = new Date(Date.UTC(anio, numero - 1, 15, 16));
  return { desde: inicioDelMesClinica(referencia), hasta: inicioDelMesClinica(referencia, 1) };
}

/**
 * Los envíos del mes: cada auditoría `RESULTADO_ENVIADO` y cada aviso con
 * mensaje que no tenga auditoría. `en` es el instante de cada uno, para ordenar.
 */
function enviosDelMes(desde: Date, hasta: Date): Prisma.Sql {
  const d = Prisma.sql`(${desde.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
  const h = Prisma.sql`(${hasta.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
  return Prisma.sql`
    SELECT 'AUDITORIA' AS fuente, a.id, a."createdAt" AS en
      FROM "AuditLog" a
     WHERE a.entidad = 'AvisoResultado' AND a.accion = ${ACCION_AVISO_ENVIADO}
       AND a."createdAt" >= ${d} AND a."createdAt" < ${h}
    UNION ALL
    SELECT 'AVISO', r.id, r."enviadoEn"
      FROM "AvisoResultado" r
     WHERE r."mensajeId" IS NOT NULL
       AND r."enviadoEn" >= ${d} AND r."enviadoEn" < ${h}
       AND NOT EXISTS (
         SELECT 1 FROM "AuditLog" a
          WHERE a.entidad = 'AvisoResultado' AND a."entidadId" = r.id AND a.accion = ${ACCION_AVISO_ENVIADO})`;
}

/** El detalle JSON de la auditoría, leído campo a campo: lo viejo puede no tener todo. */
function detalle(cambios: Prisma.JsonValue): DetalleAuditoria {
  if (!cambios || typeof cambios !== 'object' || Array.isArray(cambios)) return {};
  const texto = (clave: string) => (typeof cambios[clave] === 'string' ? (cambios[clave] as string) : undefined);
  return {
    informeId: texto('informeId'),
    clienteId: texto('clienteId'),
    estudio: texto('estudio'),
    mensajeId: texto('mensajeId'),
    /* Presente y nulo = la ficha no tenía número (solo usuario de WhatsApp). Ausente = no se guardó. */
    telefono: 'telefono' in cambios ? (texto('telefono') ?? null) : undefined,
    usuarioFilemaker: texto('usuarioFilemaker'),
    destino: texto('destino'),
  };
}

function entrega(m: { createdAt: Date; estadoEnvio: EstadoMensaje | null; entregadoEn: Date | null; leidoEn: Date | null; codigoErrorEnvio: number | null }): EntregaWhatsapp {
  return {
    estado: m.estadoEnvio,
    enviadoEn: m.createdAt,
    entregadoEn: m.entregadoEn,
    leidoEn: m.leidoEn,
    codigoError: m.estadoEnvio === 'FALLIDO' ? m.codigoErrorEnvio : null,
  };
}

/** La primera vez que se usó el enlace: abrir la página, ver el PDF o guardar algo. */
export function primeraApertura(abiertoEn: string | null, descargas: InformeConstancia['descargas']): string | null {
  const marcas = [abiertoEn, descargas.pdf?.primera, descargas.original?.primera, descargas.adjuntos?.primera]
    .filter((m): m is string => !!m)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return marcas[0] ?? null;
}
