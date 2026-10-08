import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  StreamableFile,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { ArchivoSubido } from '../../common/archivos/archivo-subido';
import { CacheMemoria } from '../../common/cache/cache-memoria';
import { validarImagenPublica } from '../../common/storage/imagen-publica';
import { R2Service } from '../../common/storage/r2.service';
import { fechaConsultable } from './agenda.contrato';
import { ARCHIVO_IMAGEN_AGENDA, precioDelVps, versionDeFoto } from './agenda.sql';
import { registrarPagoEnAgenda, reservarEnAgenda } from './agenda-reserva.sql';
import { AgendaReservaClient } from './agenda-reserva.client';
import { firmarReferencia, leerReferencia } from './agenda-referencia';
import { AgendaTelegramService } from './agenda-telegram.service';
import { AgendaVpsClient } from './agenda-vps.client';
import { CrearReservaAgendaDto, PagoReservaAgendaDto } from './dto/reserva-agenda.dto';

/** Las fotos de la agenda llegan a ~200 KB; 3 MB ya no es una foto de ficha. */
const BYTES_MAXIMOS_IMAGEN_AGENDA = 3 * 1024 * 1024;

/** Lo que pasó al llevar a la agenda un comprobante que llegó por el chat. */
export type ResultadoPagoChat = 'REGISTRADO' | 'NO_ES_IMAGEN' | 'NO_ENCONTRADA' | 'YA_NO_PENDIENTE';

const EXTENSION_IMAGEN: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

const limpiar = (texto: string) => texto.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Reserva real desde la landing: registra la cita en la agenda ScriptCase
 * como lo hace su formulario público y avisa a la clínica por el mismo
 * Telegram. Ver `agenda-reserva.sql.ts` para el porqué de cada columna.
 */
@Injectable()
export class AgendaReservasService {
  private readonly logger = new Logger(AgendaReservasService.name);
  private readonly secreto: string | null;
  private readonly imagenes = new CacheMemoria<{ bytes: Buffer; tipo: string }>({ ttlMs: 10 * 60_000, maxEntradas: 120 });
  /** QR ya copiados a R2, por banco: la clave cambia si cambia la imagen, así que copiarlo de nuevo es solo trabajo de más. */
  private readonly qrEnR2 = new CacheMemoria<string>({ ttlMs: 10 * 60_000, maxEntradas: 60 });

  constructor(
    private readonly config: ConfigService,
    private readonly reservas: AgendaReservaClient,
    private readonly lectura: AgendaVpsClient,
    private readonly telegram: AgendaTelegramService,
    private readonly r2: R2Service,
  ) {
    const secreto = config.get<string>('AGENDA_RESERVA_SECRETO')?.trim() ?? '';
    this.secreto = secreto.length >= 32 ? secreto : null;
  }

  private exigirHabilitada(): string {
    if (!this.reservas.habilitada() || !this.secreto) throw this.reservas.noDisponible();
    return this.secreto;
  }

  async reservar(dto: CrearReservaAgendaDto) {
    const secreto = this.exigirHabilitada();
    if (!fechaConsultable(dto.fecha)) throw new BadRequestException('Elige una fecha de los próximos 30 días.');
    const telefono = dto.telefono.replace(/\D/g, '').replace(/^591(?=\d{8}$)/, '');
    const datos = {
      medicoId: Number(dto.medicoId),
      fecha: dto.fecha,
      hora: dto.hora,
      nombre: limpiar(dto.nombre),
      telefono,
      ci: limpiar(dto.ci),
      observaciones: limpiar(dto.observaciones ?? ''),
    };
    if (datos.nombre.length < 3) throw new BadRequestException('Escribe el nombre completo.');

    const resultado = await this.reservas.enTransaccion(conexion => reservarEnAgenda(conexion, datos));
    if (!resultado.ok) {
      throw resultado.motivo === 'HORA_NO_DISPONIBLE'
        ? new ConflictException({ codigo: 'HORA_NO_DISPONIBLE', message: 'Esa hora acaba de ocuparse. Elige otra, por favor.' })
        : new NotFoundException({ codigo: 'MEDICO_NO_DISPONIBLE', message: 'Ese profesional ya no está disponible en línea.' });
    }
    this.telegram.nuevaCita(datos.nombre, datos.ci);
    return {
      codigo: resultado.paraAge,
      referencia: firmarReferencia(resultado.paraAge, secreto),
      medico: resultado.medicoNombre,
      fecha: datos.fecha,
      hora: datos.hora,
      estado: 'PENDIENTE' as const,
      pago: { precio: precioDelVps(resultado.precio), bancoId: resultado.bancoId },
    };
  }

  async registrarPago(dto: PagoReservaAgendaDto, archivo: ArchivoSubido | undefined) {
    const secreto = this.exigirHabilitada();
    const paraAge = leerReferencia(dto.referencia, secreto);
    if (paraAge === null) {
      throw new GoneException({ codigo: 'REFERENCIA_VENCIDA', message: 'Este enlace de pago venció. Envía tu comprobante por WhatsApp.' });
    }
    if (!archivo) throw new BadRequestException('Falta el comprobante.');
    // Solo imágenes, comprobadas por sus bytes: es lo que ScriptCase muestra en «ver_qr».
    const imagen = validarImagenPublica(archivo.buffer);
    if ('error' in imagen) throw new BadRequestException('Sube una foto o captura del comprobante (JPG, PNG o WebP, hasta 5 MB).');

    const resultado = await this.reservas.enTransaccion(conexion =>
      registrarPagoEnAgenda(conexion, paraAge, archivo.buffer, (dto.nit ?? '').trim(), limpiar(dto.razonSocial ?? '')),
    );
    if (!resultado.ok) {
      throw resultado.motivo === 'NO_ENCONTRADA'
        ? new NotFoundException('Esa reserva no existe.')
        : new ConflictException({ codigo: 'YA_REGISTRADO', message: 'Esta reserva ya tiene un comprobante o la clínica ya la gestionó.' });
    }
    this.telegram.pagoParaVerificar(resultado.nombre, resultado.ci);
    return { codigo: paraAge, estado: 'PAGADO' as const };
  }

  /**
   * La imagen QR del banco del médico, la misma que muestra ScriptCase en su
   * paso de pago, solo si está vigente.
   */
  async qr(bancoId: number): Promise<StreamableFile> {
    return this.comoArchivo(await this.imagenQr(bancoId));
  }

  /**
   * El QR del médico copiado a R2, para mandarlo por WhatsApp al cerrar una
   * reserva del chat: Meta descarga la imagen de una URL nuestra, nunca de
   * ScriptCase. La clave lleva el hash de la imagen: si la clínica cambia el QR,
   * cambia la clave, y un QR viejo nunca sale con el nombre del nuevo.
   *
   * `null` si hoy no se puede (sin R2, QR vencido, ScriptCase sin responder):
   * la reserva sigue en pie y recepción coordina el pago, como con la web.
   */
  async prepararQr(bancoId: number): Promise<string | null> {
    if (!this.r2.habilitado) return null;
    try {
      return await this.qrEnR2.resolver(String(bancoId), async () => {
        const imagen = await this.imagenQr(bancoId);
        const extension = EXTENSION_IMAGEN[imagen.tipo];
        if (!extension) throw new ServiceUnavailableException('Formato de QR no soportado.');
        const hash = createHash('sha256').update(imagen.bytes).digest('hex').slice(0, 16);
        const clave = `agenda/qr/${bancoId}-${hash}.${extension}`;
        const cuerpo = imagen.bytes.buffer.slice(imagen.bytes.byteOffset, imagen.bytes.byteOffset + imagen.bytes.byteLength) as ArrayBuffer;
        await this.r2.subir(clave, cuerpo, imagen.tipo);
        return clave;
      });
    } catch {
      this.logger.warn('QR de agenda no disponible para el chat');
      return null;
    }
  }

  /**
   * Un comprobante que la paciente mandó por el chat, a su reserva: lo mismo
   * que hace la web al subirlo (`registrarPago`), sin NIT ni razón social, que
   * por el chat no se piden. Lanza solo si la agenda no responde (se reintenta).
   */
  async registrarPagoDesdeChat(paraAge: number, comprobante: Buffer): Promise<ResultadoPagoChat> {
    if (!this.reservas.habilitada()) throw this.reservas.noDisponible();
    if ('error' in validarImagenPublica(comprobante)) return 'NO_ES_IMAGEN';
    const resultado = await this.reservas.enTransaccion(conexion => registrarPagoEnAgenda(conexion, paraAge, comprobante, '', ''));
    if (!resultado.ok) return resultado.motivo;
    this.telegram.pagoParaVerificar(resultado.nombre, resultado.ci);
    return 'REGISTRADO';
  }

  private imagenQr(bancoId: number) {
    return this.imagen(`qr:${bancoId}`, async conexion => {
      const [filas] = await conexion.execute<RowDataPacket[]>(
        `SELECT Qr AS archivo, (fecha_vence IS NULL OR fecha_vence >= CURRENT_DATE()) AS vigente FROM pagos_qr WHERE qr_pk = ?`,
        [bancoId],
      );
      return Number(filas[0]?.vigente) === 1 ? filas[0]?.archivo : null;
    });
  }

  /** La foto del médico que publica la agenda (`medicos.foto`), solo de médicos activos. */
  async foto(medicoId: number, version: string): Promise<StreamableFile> {
    return this.comoArchivo(await this.imagen(`foto:${medicoId}:${version}`, async conexion => {
      const [filas] = await conexion.execute<RowDataPacket[]>(
        `SELECT foto FROM medicos WHERE medico_pk = ? AND estado = 'ACTIVO'`,
        [medicoId],
      );
      // Una versión que ya no coincide es una foto reemplazada: no se sirve la nueva con la URL vieja.
      return versionDeFoto(filas[0]?.foto) === version ? filas[0]?.foto : null;
    }));
  }

  private comoArchivo(imagen: { bytes: Buffer; tipo: string }): StreamableFile {
    return new StreamableFile(imagen.bytes, { type: imagen.tipo, length: imagen.bytes.byteLength });
  }

  /**
   * Una imagen de la carpeta pública de ScriptCase (`_lib/file/img`), leída por
   * HTTP dentro de la red de servidores y servida por HTTPS: hoy la paciente la
   * recibe de ScriptCase en HTTP. El nombre sale de la base, nunca del público.
   */
  private imagen(
    clave: string,
    archivoDe: (conexion: PoolConnection) => Promise<unknown>,
  ): Promise<{ bytes: Buffer; tipo: string }> {
    return this.imagenes.resolver(clave, async () => {
      const crudo = await this.lectura.ejecutar(archivoDe);
      const archivo = typeof crudo === 'string' ? crudo.trim() : '';
      if (!archivo || !ARCHIVO_IMAGEN_AGENDA.test(archivo)) throw new NotFoundException('Esa imagen no está disponible.');
      const base = this.config.get<string>('AGENDA_QR_BASE_URL') ?? 'http://23.95.128.187/clinicaw/_lib/file/img/';
      const respuesta = await fetch(base + encodeURIComponent(archivo), { redirect: 'error', signal: AbortSignal.timeout(8_000) });
      const tipo = respuesta.headers.get('content-type') ?? '';
      if (!respuesta.ok || !/^image\/(png|jpeg|webp)$/.test(tipo)) throw new ServiceUnavailableException('No pudimos cargar la imagen.');
      const bytes = Buffer.from(await respuesta.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > BYTES_MAXIMOS_IMAGEN_AGENDA) throw new ServiceUnavailableException('No pudimos cargar la imagen.');
      return { bytes, tipo };
    });
  }
}
