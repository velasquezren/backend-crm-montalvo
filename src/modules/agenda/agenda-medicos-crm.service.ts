import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ArchivoSubido } from '../../common/archivos/archivo-subido';
import { puedeEditarAgendaClinica, puedeVerAgendaClinica } from '../../common/auth/roles';
import { UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { calcularPaginacion, paginar, PaginationDto } from '../../common/dto/pagination.dto';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { ActualizarEspecialidadDto } from '../directorio/dto/especialidad.dto';
import { claveDeEspecialidad, DirectorioService } from '../directorio/directorio.service';
import { AgendaAdminClient } from './agenda-admin.client';
import {
  actualizarMedicoAgenda,
  crearMedicoAgenda,
  DatosMedicoAgenda,
  FichaMedicoAgenda,
  fichaMedicoAgenda,
  guardarHorarioAgenda,
  listarBancosAgenda,
  listarEspecialidadesAgenda,
  listarMedicosAgenda,
  renombrarEspecialidadAgenda,
  ResultadoAdminAgenda,
} from './agenda-admin.sql';
import { bloquesDeCasillas, DiaAgenda } from './horario-html';
import {
  ActualizarMedicoAgendaDto,
  ActualizarPresentacionAgendaDto,
  CrearMedicoAgendaDto,
  DatosMedicoAgendaDto,
  GuardarHorarioAgendaDto,
  QueryMedicosAgendaAdminDto,
  RenombrarEspecialidadAgendaDto,
} from './dto/medicos-agenda.dto';

/** El precio de la agenda para la web: «400.00» → 400; sin precio o 0, null. */
function precioWeb(precio: string | null): number | null {
  const n = precio === null ? NaN : Number(precio);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** El horario de la web que corresponde a las casillas encendidas de una ficha. */
function bloquesDeFicha(f: FichaMedicoAgenda) {
  return bloquesDeCasillas(
    f.casillas.filter(c => c.activa && (f.grilla.dias as readonly string[]).includes(c.dia)).map(c => ({ dia: c.dia as DiaAgenda, hora: c.hora })),
  );
}

const MENSAJES: Record<Exclude<ResultadoAdminAgenda<unknown>, { ok: true }>['motivo'], string> = {
  NO_ENCONTRADO: 'Ese médico no está en la agenda.',
  CONFLICTO: 'Otra persona cambió este médico mientras lo editabas. Carga lo último antes de guardar.',
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
 * Ve cualquier sesión (el teléfono del médico, solo quien gestiona citas:
 * `puedeVerAgendaClinica`); editan administración y recepción
 * (`puedeEditarAgendaClinica`). Cada cambio deja constancia en
 * `AuditLog` dentro de la transacción de MySQL: si la constancia no se puede
 * guardar, el cambio se deshace.
 *
 * La PRESENTACIÓN web (foto, biografía, publicación) es una ficha del
 * directorio enlazada al médico (`PerfilMedico.agendaMedicoId`): se gestiona
 * desde aquí con los mismos permisos, pero la escribe su dueño,
 * `DirectorioService`. Al guardar datos u horario en la agenda, la ficha
 * recibe el precio y el horario nuevos.
 */
@Injectable()
export class AgendaMedicosCrmService {
  private readonly logger = new Logger(AgendaMedicosCrmService.name);

  constructor(
    private readonly agenda: AgendaAdminClient,
    private readonly prisma: PrismaService,
    private readonly directorio: DirectorioService,
  ) {}

  /**
   * Quién atiende, de qué y cuándo lo ve cualquier sesión: también ventas lo
   * necesita para contestar. El teléfono del médico, solo quien gestiona citas.
   */
  private paraQuienVe<T extends { telefono: string | null }>(medico: T, usuario: UsuarioJwt): T {
    return puedeVerAgendaClinica(usuario.rol) ? medico : { ...medico, telefono: null };
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
    const { skip, take } = calcularPaginacion(query);
    const r = await this.agenda.consultar(db =>
      listarMedicosAgenda(db, { buscar: query.buscar, especialidad: query.especialidad, estado: query.estado, skip, take }),
    );
    const web = await this.directorio.resumenDeAgenda(r.datos.map(m => m.id));
    const datos = r.datos.map(m => ({ ...this.paraQuienVe(m, usuario), web: web.get(m.id) ?? null }));
    return { ...paginar(datos, r.total, query), porEstado: r.porEstado };
  }

  /** Las especialidades de la agenda, cada una con su página web (o null si no tiene). */
  async especialidades(query: PaginationDto) {
    const { skip, take } = calcularPaginacion(query);
    const r = await this.agenda.consultar(db => listarEspecialidadesAgenda(db, skip, take));
    const paginas = await this.directorio.paginasDeEspecialidades(r.datos.map(e => e.nombre));
    const datos = r.datos.map(e => ({ ...e, pagina: paginas.get(claveDeEspecialidad(e.nombre)) ?? null }));
    return paginar(datos, r.total, query);
  }

  /**
   * Crea la página web de las especialidades indicadas que todavía no tienen.
   * Solo de especialidades que existen en la agenda: la web no inventa otras.
   */
  async crearPaginas(nombres: readonly string[], usuario: UsuarioJwt) {
    this.exigirEditar(usuario);
    const r = await this.agenda.consultar(db => listarEspecialidadesAgenda(db, 0, 500));
    const deLaAgenda = new Map(r.datos.map(e => [claveDeEspecialidad(e.nombre), e.nombre] as const));
    const validas = nombres.map(n => deLaAgenda.get(claveDeEspecialidad(n))).filter((n): n is string => !!n);
    if (validas.length === 0) throw new NotFoundException('Esas especialidades no están en la agenda.');
    return { creadas: await this.directorio.crearPaginasDeEspecialidades(validas, usuario.sub) };
  }

  /** Descripción, orden y si se muestra. El nombre lo pone la agenda (renombrar allí). */
  async actualizarPagina(id: string, dto: Omit<ActualizarEspecialidadDto, 'nombre'>, usuario: UsuarioJwt) {
    this.exigirEditar(usuario);
    return this.directorio.actualizarEspecialidad(id, { descripcion: dto.descripcion, activa: dto.activa, orden: dto.orden }, usuario.sub);
  }

  async bancos() {
    return this.agenda.consultar(db => listarBancosAgenda(db));
  }

  async ficha(id: number, usuario: UsuarioJwt) {
    const ficha = await this.leerFicha(id);
    return { ...ficha, medico: this.paraQuienVe(ficha.medico, usuario), presentacion: await this.directorio.fichaDeAgenda(id) };
  }

  private async leerFicha(id: number): Promise<FichaMedicoAgenda> {
    const ficha = await this.agenda.consultar(db => fichaMedicoAgenda(db, id));
    if (!ficha) throw errorDe('NO_ENCONTRADO');
    return ficha;
  }

  /**
   * Tras guardar en la agenda: la ficha web (si hay) recibe el precio y el
   * horario nuevos. La agenda ya quedó guardada; si esto falla, se registra y
   * la web se pone al día en el próximo guardado.
   */
  private async sincronizarWeb(id: number, usuario: UsuarioJwt) {
    const ficha = await this.leerFicha(id);
    try {
      await this.directorio.sincronizarConAgenda(id, { precioConsulta: precioWeb(ficha.medico.precio), orden: ficha.medico.orden, bloques: bloquesDeFicha(ficha) });
    } catch (error) {
      this.logger.warn(`Ficha web del médico ${id} sin sincronizar: ${error instanceof Error ? error.message : 'error'}`);
    }
    return this.ficha(id, usuario);
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
    return this.sincronizarWeb(id, usuario);
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
    return this.sincronizarWeb(id, usuario);
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
    try {
      await this.directorio.renombrarPaginaDeEspecialidad(dto.actual, dto.nueva, usuario.sub);
    } catch (error) {
      this.logger.warn(`Página web de «${dto.actual}» sin renombrar: ${error instanceof Error ? error.message : 'error'}`);
    }
    return { medicos };
  }

  /* ── Presentación web (ficha del directorio enlazada) ─────────────────── */

  /** La ficha web del médico, o 404 si todavía no tiene. */
  private async presentacionDe(id: number) {
    const ficha = await this.directorio.fichaDeAgenda(id);
    if (!ficha) throw new NotFoundException('Este médico todavía no tiene ficha web.');
    return ficha;
  }

  /** Crea la ficha web del médico: oculta, con su nombre, precio y horario de la agenda. */
  async crearPresentacion(id: number, usuario: UsuarioJwt) {
    this.exigirEditar(usuario);
    const f = await this.leerFicha(id);
    await this.directorio.crearFichaDeAgenda({
      agendaMedicoId: id,
      nombrePublico: [f.medico.sigla, f.medico.nombre].filter(Boolean).join(' ').slice(0, 120),
      codigoFilemaker: f.medico.codigo,
      especialidad: f.medico.especialidad,
      precioConsulta: precioWeb(f.medico.precio),
      orden: f.medico.orden,
      bloques: bloquesDeFicha(f),
    }, usuario.sub);
    return this.ficha(id, usuario);
  }

  async actualizarPresentacion(id: number, dto: ActualizarPresentacionAgendaDto, usuario: UsuarioJwt) {
    this.exigirEditar(usuario);
    const ficha = await this.presentacionDe(id);
    await this.directorio.actualizarFicha(ficha.id, dto, usuario.sub);
    return this.ficha(id, usuario);
  }

  async publicarPresentacion(id: number, publicado: boolean, usuario: UsuarioJwt) {
    this.exigirEditar(usuario);
    const ficha = await this.presentacionDe(id);
    await this.directorio.publicar(ficha.id, publicado, usuario.sub);
    return this.ficha(id, usuario);
  }

  async subirFoto(id: number, archivo: ArchivoSubido | undefined, usuario: UsuarioJwt) {
    this.exigirEditar(usuario);
    const ficha = await this.presentacionDe(id);
    await this.directorio.subirFoto(ficha.id, archivo, usuario.sub);
    return this.ficha(id, usuario);
  }

  async quitarFoto(id: number, usuario: UsuarioJwt) {
    this.exigirEditar(usuario);
    const ficha = await this.presentacionDe(id);
    await this.directorio.quitarFoto(ficha.id, usuario.sub);
    return this.ficha(id, usuario);
  }
}
