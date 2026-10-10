import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { CacheMemoria } from '../../common/cache/cache-memoria';
import { ModoAsistente, ResultadoTurnoAsistente } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { ImagenHorarioService } from './imagen-horario.service';
import { ClasificadorMensajes, LectorComprobantes, ModeloConversacional } from './modelo.port';
import { probarProveedor, ResultadoPrueba } from './prueba-conexion';
import { ConfiguracionIA, EstadoProveedorIA } from './vertex/proveedor-vertex';

export const MODOS_ASISTENTE: readonly ModoAsistente[] = ['APAGADO', 'SUGERIR', 'RESPONDER'];

export const LIMITES_ASISTENTE = {
  conocimiento: 8000,
  criterioDerivacion: 2000,
  /** Un criterio de una línea («lo médico») no es un criterio: es un deseo. */
  criterioMinimo: 40,
} as const;

/** Lo que el asistente de una línea necesita para trabajar. */
export interface AsistenteDeLinea {
  readonly lineaId: string;
  readonly comercial: boolean;
  readonly modo: Exclude<ModoAsistente, 'APAGADO'>;
  readonly conocimiento: string;
  readonly criterioDerivacion: string;
}

/**
 * Por qué no se puede guardar esta configuración, o `null`. Es la regla de
 * «Antes de activar la IA» (docs/atencion-humana.md) puesta en código: el
 * asistente no contesta solo sin un criterio de la clínica de qué pasa
 * siempre a una persona.
 */
export function motivoParaNoGuardar(c: { modo: ModoAsistente; criterioDerivacion: string }): string | null {
  if (c.modo === 'RESPONDER' && c.criterioDerivacion.trim().length < LIMITES_ASISTENTE.criterioMinimo) {
    return 'Para que el asistente responda solo, la clínica tiene que escribir qué temas pasan siempre a una persona.';
  }
  return null;
}

/**
 * Dueño de `AsistenteLinea`: cómo participa el asistente en cada línea. Lo
 * configura un SUPER_ADMIN junto con la línea, como el menú y el cobro.
 */
@Injectable()
export class AsistenteLineasService {
  /** Lo lee cada mensaje entrante: sin caché sería una consulta por mensaje. */
  private readonly activos = new CacheMemoria<AsistenteDeLinea | null>({ ttlMs: 30_000, maxEntradas: 50 });

  constructor(
    private readonly prisma: PrismaService,
    private readonly ia: ConfiguracionIA,
    private readonly modelo: ModeloConversacional,
    private readonly clasificador: ClasificadorMensajes,
    private readonly lector: LectorComprobantes,
    private readonly imagenes: ImagenHorarioService,
  ) {}

  estadoProveedor(): EstadoProveedorIA {
    return this.ia.estado();
  }

  /** «Probar conexión»: la prueba de punta a punta con datos sintéticos (`prueba-conexion.ts`). */
  probarConexion(): Promise<ResultadoPrueba> {
    return probarProveedor({
      estado: this.ia.estado(), modelo: this.modelo, clasificador: this.clasificador, lector: this.lector,
      dibujar: svg => this.imagenes.dibujar(svg),
    });
  }

  /**
   * El asistente de la línea, si está encendido Y el servidor puede llamar a
   * Gemini. `null` = la línea se comporta como siempre.
   */
  async activoEn(lineaId: string): Promise<AsistenteDeLinea | null> {
    if (!this.ia.estado().listo) return null;
    return this.activos.resolver(lineaId, async () => {
      const fila = await this.prisma.asistenteLinea.findUnique({ where: { lineaId }, include: { linea: { select: { comercial: true, activa: true } } } });
      if (!fila || fila.modo === 'APAGADO' || !fila.linea.activa) return null;
      /* Leído de la base, se vuelve a validar: un RESPONDER sin criterio (escrito
         a mano, o un criterio borrado) no contesta solo; sugiere. */
      const modo = fila.modo === 'RESPONDER' && motivoParaNoGuardar(fila) ? 'SUGERIR' : fila.modo;
      return { lineaId, comercial: fila.linea.comercial, modo, conocimiento: fila.conocimiento, criterioDerivacion: fila.criterioDerivacion };
    });
  }

  /** ¿Se leen los comprobantes de esta línea? */
  async leeComprobantes(lineaId: string): Promise<boolean> {
    if (!this.ia.estado().listo) return false;
    const fila = await this.prisma.asistenteLinea.findUnique({ where: { lineaId }, select: { leerComprobantes: true } });
    return fila?.leerComprobantes ?? false;
  }

  async editable(lineaId: string) {
    const linea = await this.prisma.lineaWhatsapp.findUnique({
      where: { id: lineaId },
      select: {
        id: true, nombre: true, comercial: true,
        asistente: { select: { modo: true, conocimiento: true, criterioDerivacion: true, leerComprobantes: true, actualizadoEn: true, actualizadoPor: { select: { nombre: true } } } },
      },
    });
    if (!linea) throw new NotFoundException('Línea no encontrada');
    return {
      linea: { id: linea.id, nombre: linea.nombre, comercial: linea.comercial },
      configuracion: linea.asistente ?? { modo: 'APAGADO' as const, conocimiento: '', criterioDerivacion: '', leerComprobantes: false, actualizadoEn: null, actualizadoPor: null },
      proveedor: this.ia.estado(),
      actividad: await this.actividad(lineaId),
    };
  }

  async guardar(lineaId: string, dto: { modo: ModoAsistente; conocimiento: string; criterioDerivacion: string; leerComprobantes: boolean }, usuarioId: string) {
    const motivo = motivoParaNoGuardar(dto);
    if (motivo) throw new BadRequestException(motivo);
    const existe = await this.prisma.lineaWhatsapp.findUnique({ where: { id: lineaId }, select: { id: true } });
    if (!existe) throw new NotFoundException('Línea no encontrada');
    const datos = { modo: dto.modo, conocimiento: dto.conocimiento.trim(), criterioDerivacion: dto.criterioDerivacion.trim(), leerComprobantes: dto.leerComprobantes, actualizadoPorId: usuarioId };
    await this.prisma.$transaction(async tx => {
      const antes = await tx.asistenteLinea.findUnique({ where: { lineaId }, select: { modo: true, leerComprobantes: true } });
      await tx.asistenteLinea.upsert({ where: { lineaId }, create: { lineaId, ...datos }, update: datos });
      await tx.auditLog.create({
        data: {
          entidad: 'AsistenteLinea', entidadId: lineaId, accion: 'ASISTENTE_CONFIGURADO', usuarioId,
          /* Los textos no van: son largos y están en la fila. Lo que se audita es quién lo encendió. */
          cambios: { modo: { antes: antes?.modo ?? 'APAGADO', despues: dto.modo }, leerComprobantes: { antes: antes?.leerComprobantes ?? false, despues: dto.leerComprobantes } },
        },
      });
    });
    this.activos.invalidar(lineaId);
    return this.editable(lineaId);
  }

  /** Qué hizo el asistente en la línea los últimos 7 días: lo que deja juzgar si sirve. */
  private async actividad(lineaId: string) {
    const desde = new Date(Date.now() - 7 * 86_400_000);
    const grupos = await this.prisma.turnoAsistente.groupBy({
      by: ['resultado'],
      where: { lineaId, createdAt: { gte: desde } },
      _count: { _all: true },
      _sum: { tokensEntrada: true, tokensSalida: true },
    });
    const porResultado = Object.fromEntries(grupos.map(g => [g.resultado, g._count._all])) as Partial<Record<ResultadoTurnoAsistente, number>>;
    return {
      dias: 7,
      porResultado,
      tokensEntrada: grupos.reduce((s, g) => s + (g._sum.tokensEntrada ?? 0), 0),
      tokensSalida: grupos.reduce((s, g) => s + (g._sum.tokensSalida ?? 0), 0),
    };
  }
}
