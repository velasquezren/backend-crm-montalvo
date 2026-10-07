import { BadRequestException, ForbiddenException, Injectable, NotFoundException, StreamableFile, UnsupportedMediaTypeException } from '@nestjs/common';
import { alcanceAgente, puedeVerAgendaClinica } from '../../common/auth/roles';
import { UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { calcularPaginacion, paginar } from '../../common/dto/pagination.dto';
import { fechaCivilClinica, fechaCivilDesdeTexto, textoDeFechaCivil } from '../../common/fechas/zona-clinica';
import { normalizarTelefono } from '../../common/telefono/telefono';
import { PrismaService } from '../../prisma/prisma.service';
import { whereAccesoConversacion } from '../conversaciones/acceso-conversacion';
import { AgendaConsultaClient } from './agenda-consulta.client';
import { comprobanteDeReserva, FilaReservaAgenda, listarReservasAgenda, reservasPorTelefono } from './agenda-consulta.sql';
import { precioDelVps } from './agenda.sql';
import { QueryReservasAgendaDto } from './dto/reservas-crm.dto';

const DIA = 86_400_000;
/** Sin rango, la pantalla abre en los próximos 30 días (hoy incluido). */
const DIAS_POR_DEFECTO = 30;
/** Un trimestre: lo más que se lista de una vez. */
const DIAS_MAXIMOS = 92;
/** Las próximas de una paciente, en la ficha de su chat. */
const RESERVAS_EN_EL_CHAT = 10;

/** Una reserva como la ve el CRM: el precio en centavos y el teléfono listo para abrir su chat. */
export interface ReservaAgendaCrm extends Omit<FilaReservaAgenda, 'precio'> {
  precio: { importeCentavos: number; moneda: 'BOB' } | null;
  /** E.164 si el teléfono escrito en la agenda es válido: con él se abre su conversación. */
  telefonoE164: string | null;
}

function presentar(f: FilaReservaAgenda): ReservaAgendaCrm {
  return { ...f, precio: precioDelVps(f.precio), telefonoE164: normalizarTelefono(f.telefono) };
}

const hoyEnLaClinica = () => fechaCivilClinica(new Date());
const sumarDias = (fecha: Date, dias: number) => new Date(fecha.getTime() + dias * DIA);

/** Los tipos que un comprobante puede tener, reconocidos por sus primeros bytes (no por lo que dijo quien lo subió). */
export function tipoDeComprobante(bytes: Buffer): { tipo: string; extension: string } | null {
  const empieza = (...firma: number[]) => firma.every((b, i) => bytes[i] === b);
  if (empieza(0xff, 0xd8, 0xff)) return { tipo: 'image/jpeg', extension: 'jpg' };
  if (empieza(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { tipo: 'image/png', extension: 'png' };
  if (empieza(0x47, 0x49, 0x46, 0x38)) return { tipo: 'image/gif', extension: 'gif' };
  if (empieza(0x52, 0x49, 0x46, 0x46) && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return { tipo: 'image/webp', extension: 'webp' };
  if (empieza(0x25, 0x50, 0x44, 0x46, 0x2d)) return { tipo: 'application/pdf', extension: 'pdf' };
  return null;
}

/**
 * Las reservas de la agenda de la clínica (ScriptCase), para el CRM. Solo lee,
 * con la cuenta interna `crm_agenda_consulta`; las reservas se siguen creando,
 * cobrando y confirmando donde siempre (ScriptCase, la web y caja).
 *
 * Quién ve qué:
 * - la pantalla completa, quien gestiona citas (`puedeVerAgendaClinica`);
 * - las de UNA paciente, cualquiera que pueda ver su chat (`whereAccesoConversacion`):
 *   una agente de ventas no recorre la agenda, pero sí ve si su paciente ya reservó.
 */
@Injectable()
export class AgendaReservasCrmService {
  constructor(
    private readonly agenda: AgendaConsultaClient,
    private readonly prisma: PrismaService,
  ) {}

  private exigirAgendaClinica(usuario: UsuarioJwt): void {
    if (!puedeVerAgendaClinica(usuario.rol)) throw new ForbiddenException('La agenda completa la ven recepción, asistencia y administración.');
  }

  /** El rango pedido, validado: fechas que existen, en orden y de hasta un trimestre. */
  private rango(query: QueryReservasAgendaDto): { desde: string; hasta: string } {
    const desde = query.desde ? fechaCivilDesdeTexto(query.desde) : hoyEnLaClinica();
    const hasta = query.hasta ? fechaCivilDesdeTexto(query.hasta) : desde && sumarDias(desde, DIAS_POR_DEFECTO - 1);
    if (!desde || !hasta) throw new BadRequestException('Elegí fechas que existan.');
    if (hasta < desde) throw new BadRequestException('La fecha final no puede ser anterior a la inicial.');
    if ((hasta.getTime() - desde.getTime()) / DIA + 1 > DIAS_MAXIMOS) throw new BadRequestException(`Elegí un rango de hasta ${DIAS_MAXIMOS} días.`);
    return { desde: textoDeFechaCivil(desde), hasta: textoDeFechaCivil(hasta) };
  }

  /** Una página de reservas del rango, con el total, la cuenta por estado (para los filtros) y el rango aplicado. */
  async listar(query: QueryReservasAgendaDto, usuario: UsuarioJwt) {
    this.exigirAgendaClinica(usuario);
    const { desde, hasta } = this.rango(query);
    const { skip, take } = calcularPaginacion(query);
    const r = await this.agenda.ejecutar(db => listarReservasAgenda(db, { desde, hasta, estado: query.estado, buscar: query.buscar, skip, take }));
    return { ...paginar(r.datos.map(presentar), r.total, query), porEstado: r.porEstado, desde, hasta };
  }

  /**
   * Las próximas reservas de la paciente de un chat, por su teléfono. Quien no
   * puede ver el chat recibe 404, igual que si no existiera.
   */
  async deConversacion(conversacionId: string, usuario: UsuarioJwt): Promise<ReservaAgendaCrm[]> {
    const conversacion = await this.prisma.conversacion.findFirst({
      where: { id: conversacionId, ...whereAccesoConversacion(alcanceAgente(usuario)) },
      select: { cliente: { select: { telefono: true } } },
    });
    if (!conversacion) throw new NotFoundException('Conversación no encontrada');
    const digitos = (conversacion.cliente.telefono ?? '').replace(/\D/g, '');
    /* La agenda guarda el número como lo escribió la persona: se compara el local
       boliviano (y `reservasPorTelefono` prueba también con el 591 delante). */
    const local = digitos.startsWith('591') && digitos.length === 11 ? digitos.slice(3) : digitos;
    if (local.length < 7) return [];
    const desde = textoDeFechaCivil(hoyEnLaClinica());
    return (await this.agenda.ejecutar(db => reservasPorTelefono(db, local, desde, RESERVAS_EN_EL_CHAT))).map(presentar);
  }

  /**
   * El comprobante que subió la paciente. Es un dato de pago: antes de entregarlo
   * queda constancia de quién lo abrió, y si esa constancia no se puede guardar
   * no se entrega.
   */
  async comprobante(id: number, usuario: UsuarioJwt): Promise<StreamableFile> {
    this.exigirAgendaClinica(usuario);
    const bytes = await this.agenda.ejecutar(db => comprobanteDeReserva(db, id));
    if (!bytes) throw new NotFoundException('Esa reserva no tiene comprobante.');
    const formato = tipoDeComprobante(bytes);
    if (!formato) throw new UnsupportedMediaTypeException('El comprobante no es una imagen ni un PDF.');
    await this.prisma.auditLog.create({
      data: { entidad: 'ReservaAgenda', entidadId: String(id), accion: 'COMPROBANTE_AGENDA_VISTO', usuarioId: usuario.sub },
    });
    return new StreamableFile(bytes, {
      type: formato.tipo,
      length: bytes.byteLength,
      disposition: `inline; filename="comprobante-${id}.${formato.extension}"`,
    });
  }
}

