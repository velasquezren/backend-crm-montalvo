import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  StreamableFile,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RowDataPacket } from 'mysql2/promise';
import { ArchivoSubido } from '../../common/archivos/archivo-subido';
import { CacheMemoria } from '../../common/cache/cache-memoria';
import { validarImagenPublica } from '../../common/storage/imagen-publica';
import { fechaConsultable } from './agenda.contrato';
import { precioDelVps } from './agenda.sql';
import { registrarPagoEnAgenda, reservarEnAgenda } from './agenda-reserva.sql';
import { AgendaReservaClient } from './agenda-reserva.client';
import { firmarReferencia, leerReferencia } from './agenda-referencia';
import { AgendaTelegramService } from './agenda-telegram.service';
import { AgendaVpsClient } from './agenda-vps.client';
import { CrearReservaAgendaDto, PagoReservaAgendaDto } from './dto/reserva-agenda.dto';

/** Un nombre de archivo de QR tal como lo guarda ScriptCase en `pagos_qr.Qr`. */
const ARCHIVO_QR = /^[\w .()-]{1,150}\.(png|jpe?g|webp)$/i;
const BYTES_MAXIMOS_QR = 2 * 1024 * 1024;

const limpiar = (texto: string) => texto.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Reserva real desde la landing: registra la cita en la agenda ScriptCase
 * como lo hace su formulario público y avisa a la clínica por el mismo
 * Telegram. Ver `agenda-reserva.sql.ts` para el porqué de cada columna.
 */
@Injectable()
export class AgendaReservasService {
  private readonly secreto: string | null;
  private readonly qrCache = new CacheMemoria<{ bytes: Buffer; tipo: string }>({ ttlMs: 10 * 60_000, maxEntradas: 20 });

  constructor(
    private readonly config: ConfigService,
    private readonly reservas: AgendaReservaClient,
    private readonly lectura: AgendaVpsClient,
    private readonly telegram: AgendaTelegramService,
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
    if (!fechaConsultable(dto.fecha)) throw new BadRequestException('Elegí una fecha de los próximos 30 días.');
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
    if (datos.nombre.length < 3) throw new BadRequestException('Escribí el nombre completo.');

    const resultado = await this.reservas.enTransaccion(conexion => reservarEnAgenda(conexion, datos));
    if (!resultado.ok) {
      throw resultado.motivo === 'HORA_NO_DISPONIBLE'
        ? new ConflictException({ codigo: 'HORA_NO_DISPONIBLE', message: 'Esa hora acaba de ocuparse. Elegí otra, por favor.' })
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
      throw new GoneException({ codigo: 'REFERENCIA_VENCIDA', message: 'Este enlace de pago venció. Enviá tu comprobante por WhatsApp.' });
    }
    if (!archivo) throw new BadRequestException('Falta el comprobante.');
    // Solo imágenes, comprobadas por sus bytes: es lo que ScriptCase muestra en «ver_qr».
    const imagen = validarImagenPublica(archivo.buffer);
    if ('error' in imagen) throw new BadRequestException('Subí una foto o captura del comprobante (JPG, PNG o WebP, hasta 5 MB).');

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
   * paso de pago. Se lee por HTTP dentro de la red de servidores y se sirve por
   * HTTPS: hoy la paciente la recibe de ScriptCase en HTTP.
   */
  async qr(bancoId: number): Promise<StreamableFile> {
    const imagen = await this.qrCache.resolver(String(bancoId), async () => {
      const [fila] = await this.lectura.ejecutar(async conexion => {
        const [filas] = await conexion.execute<RowDataPacket[]>(
          `SELECT Qr, fecha_vence >= CURRENT_DATE() AS vigente, fecha_vence IS NULL AS sin_vencimiento
             FROM pagos_qr WHERE qr_pk = ?`,
          [bancoId],
        );
        return filas;
      });
      const archivo = typeof fila?.Qr === 'string' ? fila.Qr.trim() : '';
      const vigente = Number(fila?.vigente) === 1 || Number(fila?.sin_vencimiento) === 1;
      if (!archivo || !ARCHIVO_QR.test(archivo) || !vigente) throw new NotFoundException('No hay un QR vigente para este pago.');
      const base = this.config.get<string>('AGENDA_QR_BASE_URL') ?? 'http://23.95.128.187/clinicaw/_lib/file/img/';
      const respuesta = await fetch(base + encodeURIComponent(archivo), { redirect: 'error', signal: AbortSignal.timeout(8_000) });
      const tipo = respuesta.headers.get('content-type') ?? '';
      if (!respuesta.ok || !/^image\/(png|jpeg|webp)$/.test(tipo)) throw new ServiceUnavailableException('No pudimos cargar el QR.');
      const bytes = Buffer.from(await respuesta.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > BYTES_MAXIMOS_QR) throw new ServiceUnavailableException('No pudimos cargar el QR.');
      return { bytes, tipo };
    });
    return new StreamableFile(imagen.bytes, { type: imagen.tipo, length: imagen.bytes.byteLength });
  }
}
