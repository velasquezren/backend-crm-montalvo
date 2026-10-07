import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { puedeEditarAgendaClinica, puedeVerAgendaClinica } from '../../common/auth/roles';
import { UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { calcularPaginacion, paginar, PaginationDto } from '../../common/dto/pagination.dto';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { AgendaAdminClient } from './agenda-admin.client';
import {
  actualizarMedicoAgenda,
  crearMedicoAgenda,
  DatosMedicoAgenda,
  fichaMedicoAgenda,
  guardarHorarioAgenda,
  listarBancosAgenda,
  listarEspecialidadesAgenda,
  listarMedicosAgenda,
  renombrarEspecialidadAgenda,
  ResultadoAdminAgenda,
} from './agenda-admin.sql';
import {
  ActualizarMedicoAgendaDto,
  CrearMedicoAgendaDto,
  DatosMedicoAgendaDto,
  GuardarHorarioAgendaDto,
  QueryMedicosAgendaAdminDto,
  RenombrarEspecialidadAgendaDto,
} from './dto/medicos-agenda.dto';

const MENSAJES: Record<Exclude<ResultadoAdminAgenda<unknown>, { ok: true }>['motivo'], string> = {
  NO_ENCONTRADO: 'Ese médico no está en la agenda.',
  CONFLICTO: 'Alguien cambió esta ficha mientras la editabas. Volvé a abrirla para ver lo último.',
  BANCO_INEXISTENTE: 'Ese QR de cobro ya no está en la agenda.',
  SIN_CODIGO: 'Este médico no tiene código de FileMaker: sin él la agenda no puede darle horas nuevas.',
  CASILLA_INVALIDA: 'Una de las casillas del horario no es válida.',
  CODIGO_DUPLICADO: 'Ya hay un médico con ese código de FileMaker.',
};

/** El motivo de un resultado fallido, como la excepción HTTP que le corresponde. */
function errorDe(motivo: keyof typeof MENSAJES): Error {
  const mensaje = MENSAJES[motivo];
  if (motivo === 'NO_ENCONTRADO') return new NotFoundException(mensaje);
  if (motivo === 'CONFLICTO' || motivo === 'CODIGO_DUPLICADO') return new ConflictException({ codigo: motivo, message: mensaje });
  return new BadRequestException({ codigo: motivo, message: mensaje });
}

function datos(dto: DatosMedicoAgendaDto): DatosMedicoAgenda {
  return {
    nombre: dto.nombre,
    sigla: dto.sigla ?? null,
    especialidad: dto.especialidad,
    telefono: dto.telefono ?? null,
    estado: dto.estado,
    precio: dto.precio ?? null,
    bancoId: dto.bancoId ?? null,
    orden: dto.orden,
  };
}

/**
 * Los médicos, horarios y especialidades de la agenda de la clínica (ScriptCase),
 * administrados desde el Directorio del CRM. Es la ÚNICA lista de médicos: la
 * agenda da los cupos, FileMaker la lee por ODBC y la landing la publica.
 *
 * Ven quien gestiona citas (`puedeVerAgendaClinica`); editan administración y
 * recepción (`puedeEditarAgendaClinica`). Cada cambio deja constancia en
 * `AuditLog` dentro de la transacción de MySQL: si la constancia no se puede
 * guardar, el cambio se deshace.
 */
@Injectable()
export class AgendaMedicosCrmService {
  constructor(
    private readonly agenda: AgendaAdminClient,
    private readonly prisma: PrismaService,
  ) {}

  private exigirVer(usuario: UsuarioJwt): void {
    if (!puedeVerAgendaClinica(usuario.rol)) throw new ForbiddenException('Los médicos de la agenda los ven recepción, asistencia y administración.');
  }

  private exigirEditar(usuario: UsuarioJwt): void {
    if (!puedeEditarAgendaClinica(usuario.rol)) throw new ForbiddenException('Los médicos de la agenda los editan recepción y administración.');
  }

  private auditar(entidad: 'MedicoAgenda' | 'EspecialidadAgenda', id: number | string, accion: string, usuario: UsuarioJwt, cambios: Record<string, unknown>) {
    return this.prisma.auditLog.create({
      data: {
        entidad, entidadId: String(id), accion, usuarioId: usuario.sub,
        cambios: JSON.parse(JSON.stringify(cambios)) as Prisma.InputJsonValue,
      },
    });
  }

  async listar(query: QueryMedicosAgendaAdminDto, usuario: UsuarioJwt) {
    this.exigirVer(usuario);
    const { skip, take } = calcularPaginacion(query);
    const r = await this.agenda.enTransaccion(db =>
      listarMedicosAgenda(db, { buscar: query.buscar, especialidad: query.especialidad, estado: query.estado, skip, take }),
    );
    return { ...paginar(r.datos, r.total, query), porEstado: r.porEstado };
  }

  async especialidades(query: PaginationDto, usuario: UsuarioJwt) {
    this.exigirVer(usuario);
    const { skip, take } = calcularPaginacion(query);
    const r = await this.agenda.enTransaccion(db => listarEspecialidadesAgenda(db, skip, take));
    return paginar(r.datos, r.total, query);
  }

  async bancos(usuario: UsuarioJwt) {
    this.exigirVer(usuario);
    return this.agenda.enTransaccion(db => listarBancosAgenda(db));
  }

  async ficha(id: number, usuario: UsuarioJwt) {
    this.exigirVer(usuario);
    const ficha = await this.agenda.enTransaccion(db => fichaMedicoAgenda(db, id));
    if (!ficha) throw errorDe('NO_ENCONTRADO');
    return ficha;
  }

  async actualizar(id: number, dto: ActualizarMedicoAgendaDto, usuario: UsuarioJwt) {
    this.exigirEditar(usuario);
    const nuevos = datos(dto);
    const r = await this.agenda.enTransaccion(async db => {
      const resultado = await actualizarMedicoAgenda(db, id, dto.version, nuevos);
      if (resultado.ok) {
        const m = resultado.valor.medico;
        const antes: DatosMedicoAgenda = {
          nombre: m.nombre, sigla: m.sigla, especialidad: m.especialidad ?? '', telefono: m.telefono,
          estado: m.estado === 'ACTIVO' ? 'ACTIVO' : 'INACTIVO', precio: m.precio, bancoId: m.bancoId, orden: m.orden,
        };
        await this.auditar('MedicoAgenda', id, 'MEDICO_AGENDA_EDITADO', usuario, { antes, despues: nuevos });
      }
      return resultado;
    });
    if (!r.ok) throw errorDe(r.motivo);
    return this.ficha(id, usuario);
  }

  async guardarHorario(id: number, dto: GuardarHorarioAgendaDto, usuario: UsuarioJwt) {
    this.exigirEditar(usuario);
    const r = await this.agenda.enTransaccion(async db => {
      const resultado = await guardarHorarioAgenda(db, id, dto.version, dto.activas);
      if (resultado.ok) {
        const { encendidas, apagadas, creadas } = resultado.valor;
        await this.auditar('MedicoAgenda', id, 'HORARIO_AGENDA_GUARDADO', usuario, { encendidas, apagadas, creadas, activas: dto.activas.map(c => `${c.dia} ${c.hora}`) });
      }
      return resultado;
    });
    if (!r.ok) throw errorDe(r.motivo);
    return this.ficha(id, usuario);
  }

  async crear(dto: CrearMedicoAgendaDto, usuario: UsuarioJwt) {
    this.exigirEditar(usuario);
    const nuevos = datos(dto);
    const r = await this.agenda.enTransaccion(async db => {
      const resultado = await crearMedicoAgenda(db, dto.codigo, nuevos);
      if (resultado.ok) await this.auditar('MedicoAgenda', resultado.valor.id, 'MEDICO_AGENDA_CREADO', usuario, { codigo: dto.codigo, ...nuevos });
      return resultado;
    });
    if (!r.ok) throw errorDe(r.motivo);
    return this.ficha(r.valor.id, usuario);
  }

  async renombrarEspecialidad(dto: RenombrarEspecialidadAgendaDto, usuario: UsuarioJwt) {
    this.exigirEditar(usuario);
    const medicos = await this.agenda.enTransaccion(async db => {
      const cambiados = await renombrarEspecialidadAgenda(db, dto.actual, dto.nueva);
      if (cambiados > 0) await this.auditar('EspecialidadAgenda', dto.actual, 'ESPECIALIDAD_AGENDA_RENOMBRADA', usuario, { actual: dto.actual, nueva: dto.nueva, medicos: cambiados });
      return cambiados;
    });
    if (medicos === 0) throw new NotFoundException('Ningún médico tiene esa especialidad.');
    return { medicos };
  }
}
