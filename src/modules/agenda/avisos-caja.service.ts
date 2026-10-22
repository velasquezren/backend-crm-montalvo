import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { cubreRol } from '../../common/auth/roles';
import { UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { enSegundoPlano } from '../../common/fiabilidad/en-segundo-plano';
import { normalizarTelefono } from '../../common/telefono/telefono';
import { WhatsappCloudService } from '../../common/whatsapp/whatsapp-cloud.service';
import { esChoqueUnicoEn } from '../../prisma/choque-unico';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { LineasWhatsappService } from '../lineas-whatsapp/lineas-whatsapp.service';
import { AgendaConsultaClient } from './agenda-consulta.client';
import { reservasPorIds } from './agenda-consulta.sql';
import {
  CUERPO_PLANTILLA_AVISO_CAJA, EstadoPlantillaCaja, estadoPlantillaCaja, IDIOMA_AVISO_CAJA, LINEA_AVISO_CAJA,
  parametrosAvisoCaja, PIE_PLANTILLA_AVISO_CAJA, PLANTILLA_AVISO_CAJA,
} from './avisos-caja';

/** Más que esto no es «caja»: es una lista de difusión, y cada aviso se paga. */
const MAXIMO_NUMEROS = 10;
/** El estado de la plantilla en Meta cambia poco: se pregunta cada tanto, no en cada comprobante. */
const VIGENCIA_ESTADO_MS = 10 * 60_000;
const VIGENCIA_ESTADO_DUDOSO_MS = 60_000;

export interface NumeroCajaVista {
  readonly id: string;
  readonly nombre: string;
  readonly telefono: string;
  readonly agregadoPor: string | null;
  readonly agregadoEn: Date;
}

export interface AvisosCajaVista {
  readonly numeros: readonly NumeroCajaVista[];
  readonly plantilla: { readonly nombre: string; readonly estado: EstadoPlantillaCaja; readonly cuerpo: string; readonly pie: string };
  readonly linea: string | null;
  readonly maximo: number;
}

/** Del teléfono, a la bitácora, solo cómo termina. */
const terminaEn = (telefono: string) => `…${telefono.slice(-4)}`;

/**
 * Cuando un comprobante de reserva queda cargado en la agenda (web, Flow o chat
 * con la IA), un WhatsApp a cada número de caja para que lo revise y lo registre
 * en FileMaker. Es el mismo momento que el aviso de Telegram de siempre
 * (`AgendaTelegramService.pagoParaVerificar`), que sigue saliendo.
 *
 * Único dueño de `NumeroCaja`. Sale como plantilla desde Recepción
 * (`AVISO_CAJA_LINEA` para otra) y solo si Meta ya la aprobó: antes, ni se
 * intenta. Nunca lanza ni deshace el registro del pago; no guarda los avisos en
 * el inbox (son internos), solo una línea de log por comprobante.
 */
@Injectable()
export class AvisosCajaService {
  private readonly logger = new Logger(AvisosCajaService.name);
  private estado: { valor: EstadoPlantillaCaja; hasta: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly agenda: AgendaConsultaClient,
    private readonly lineas: LineasWhatsappService,
    private readonly whatsapp: WhatsappCloudService,
  ) {}

  private get plantilla(): string {
    return this.config.get<string>('AVISO_CAJA_PLANTILLA')?.trim() || PLANTILLA_AVISO_CAJA;
  }

  private get lineaId(): string {
    return this.config.get<string>('AVISO_CAJA_LINEA')?.trim() || LINEA_AVISO_CAJA;
  }

  private exigirAdmin(usuario: UsuarioJwt): void {
    if (!cubreRol(usuario.rol, 'ADMIN')) throw new ForbiddenException('Los números de caja los gestiona administración.');
  }

  async vista(usuario: UsuarioJwt, { refrescar = false } = {}): Promise<AvisosCajaVista> {
    this.exigirAdmin(usuario);
    if (refrescar) this.estado = null;
    const [filas, linea, estado] = await Promise.all([
      this.prisma.numeroCaja.findMany({ orderBy: { createdAt: 'asc' } }),
      this.prisma.lineaWhatsapp.findUnique({ where: { id: this.lineaId }, select: { nombre: true } }),
      this.estadoPlantilla(),
    ]);
    const autores = await this.prisma.usuario.findMany({ where: { id: { in: [...new Set(filas.map(f => f.agregadoPorId))] } }, select: { id: true, nombre: true } });
    return {
      numeros: filas.map(f => ({ id: f.id, nombre: f.nombre, telefono: f.telefono, agregadoPor: autores.find(a => a.id === f.agregadoPorId)?.nombre ?? null, agregadoEn: f.createdAt })),
      plantilla: { nombre: this.plantilla, estado, cuerpo: CUERPO_PLANTILLA_AVISO_CAJA, pie: PIE_PLANTILLA_AVISO_CAJA },
      linea: linea?.nombre ?? null,
      maximo: MAXIMO_NUMEROS,
    };
  }

  async agregar(nombreEscrito: string, telefonoEscrito: string, usuario: UsuarioJwt): Promise<AvisosCajaVista> {
    this.exigirAdmin(usuario);
    const telefono = normalizarTelefono(telefonoEscrito);
    if (!telefono) throw new BadRequestException('Ese número de teléfono no es válido. Escríbelo con el código de país, por ejemplo +591 70012345.');
    const nombre = nombreEscrito.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (nombre.length < 2) throw new BadRequestException('Escribe de quién es el número (por ejemplo, «Caja central»).');
    try {
      await this.prisma.$transaction(async tx => {
        if (await tx.numeroCaja.count() >= MAXIMO_NUMEROS) throw new BadRequestException(`Caben hasta ${MAXIMO_NUMEROS} números de caja.`);
        const creado = await tx.numeroCaja.create({ data: { nombre, telefono, agregadoPorId: usuario.sub } });
        await tx.auditLog.create({ data: { entidad: 'NumeroCaja', entidadId: creado.id, accion: 'NUMERO_CAJA_AGREGADO', usuarioId: usuario.sub,
          cambios: { nombre, telefono: terminaEn(telefono) } as Prisma.InputJsonValue } });
      });
    } catch (error: unknown) {
      if (esChoqueUnicoEn(error, 'NumeroCaja', 'telefono')) throw new ConflictException('Ese número ya recibe los avisos de caja.');
      throw error;
    }
    return this.vista(usuario);
  }

  async quitar(id: string, usuario: UsuarioJwt): Promise<AvisosCajaVista> {
    this.exigirAdmin(usuario);
    await this.prisma.$transaction(async tx => {
      const fila = await tx.numeroCaja.findUnique({ where: { id } });
      if (!fila) throw new NotFoundException('Ese número ya no está en la lista.');
      await tx.numeroCaja.delete({ where: { id } });
      await tx.auditLog.create({ data: { entidad: 'NumeroCaja', entidadId: id, accion: 'NUMERO_CAJA_QUITADO', usuarioId: usuario.sub,
        cambios: { nombre: fila.nombre, telefono: terminaEn(fila.telefono) } as Prisma.InputJsonValue } });
    });
    return this.vista(usuario);
  }

  /**
   * El comprobante de la reserva `paraAge` quedó en la agenda. No espera ni lanza:
   * quien llama ya registró el pago y respondió.
   */
  comprobanteRegistrado(paraAge: number): void {
    void enSegundoPlano('aviso a caja', this.logger, () => this.avisar(paraAge));
  }

  /** Público para las pruebas. Devuelve a cuántos números salió. */
  async avisar(paraAge: number): Promise<number> {
    const numeros = await this.prisma.numeroCaja.findMany({ select: { telefono: true } });
    if (!numeros.length) return 0;
    if (await this.estadoPlantilla() !== 'APROBADA') {
      this.logger.warn(`Aviso a caja de la reserva ${paraAge} sin enviar: la plantilla ${this.plantilla} no está aprobada en Meta`);
      return 0;
    }
    const cuenta = await this.cuenta();
    if (!cuenta || !this.agenda.habilitada()) {
      this.logger.warn(`Aviso a caja de la reserva ${paraAge} sin enviar: ${cuenta ? 'la agenda no está configurada' : 'la línea no tiene credenciales'}`);
      return 0;
    }
    const [reserva] = await this.agenda.ejecutar(db => reservasPorIds(db, [paraAge]));
    if (!reserva) {
      this.logger.warn(`Aviso a caja de la reserva ${paraAge} sin enviar: no está en la agenda`);
      return 0;
    }
    const parametros = parametrosAvisoCaja(reserva);
    let enviados = 0;
    for (const { telefono } of numeros) {
      const resultado = await this.whatsapp.enviar(telefono, {
        type: 'template',
        template: {
          name: this.plantilla,
          language: { code: IDIOMA_AVISO_CAJA },
          components: [{ type: 'body', parameters: parametros.map(text => ({ type: 'text', text })) }],
        },
      }, undefined, cuenta);
      if (resultado.estado !== 'NO_SALIO') enviados++;
    }
    /* Una línea por comprobante, sin datos de la paciente ni números. */
    this.logger.log(`Aviso a caja de la reserva ${paraAge}: ${enviados}/${numeros.length} enviados`);
    return enviados;
  }

  private async cuenta() {
    const linea = await this.prisma.lineaWhatsapp.findUnique({ where: { id: this.lineaId } });
    return linea ? this.lineas.credenciales(linea) : null;
  }

  /** Con caché: aprobada, por 10 min; lo dudoso (en revisión, sin conexión), por 1 min. */
  private async estadoPlantilla(): Promise<EstadoPlantillaCaja> {
    const ahora = Date.now();
    if (this.estado && this.estado.hasta > ahora) return this.estado.valor;
    const cuenta = await this.cuenta();
    const valor = estadoPlantillaCaja(cuenta ? await this.whatsapp.listarPlantillas(cuenta) : null, this.plantilla);
    this.estado = { valor, hasta: ahora + (valor === 'APROBADA' ? VIGENCIA_ESTADO_MS : VIGENCIA_ESTADO_DUDOSO_MS) };
    return valor;
  }
}
