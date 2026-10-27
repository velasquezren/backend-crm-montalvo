import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ArchivoSubido } from '../../common/archivos/archivo-subido';
import { CacheMemoria } from '../../common/cache/cache-memoria';
import { puedeEditarAgendaClinica, puedeVerAgendaClinica } from '../../common/auth/roles';
import { UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { calcularPaginacion, paginar, PaginationDto } from '../../common/dto/pagination.dto';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { ActualizarEspecialidadDto } from '../directorio/dto/especialidad.dto';
import { CrearAusenciaDto } from '../directorio/dto/perfil-medico.dto';
import { claveDeEspecialidad, DirectorioService } from '../directorio/directorio.service';
import { AgendaAdminClient } from './agenda-admin.client';
import { urlFotoDeAgenda } from './agenda.contrato';
import { AgendaMedicoCitasService } from './agenda-medico-citas.service';
import { AgendaReservasService } from './agenda-reservas.service';
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
  MedicoPorCodigo,
  medicosConCodigo,
  renombrarEspecialidadAgenda,
  ResultadoAdminAgenda,
} from './agenda-admin.sql';
import { bloquesDeCasillas, DiaAgenda } from './horario-html';
import { nombreLimpio } from '../../common/texto/espacios';
import { HorarioFilemakerService } from './horario-filemaker.service';
import { bloquesContiguos } from './horario-filemaker';
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

/** De dónde sale la foto que el CRM muestra de un médico. */
export type OrigenFotoMedico = 'WEB' | 'AGENDA';

/**
 * La foto de un médico como la ve la clínica: la de su ficha web si la tiene
 * (la que se cuida desde el CRM), y si no la de la agenda, que es la que ya
 * publica la landing. La de la agenda solo de médicos ACTIVOS: es lo único que
 * sirve su URL pública. Las dos URLs se guardan en el navegador (la de la
 * agenda un año, versionada; la de R2 una hora, firmada por ventana).
 */
export function fotoDelMedico(
  m: { id: number; estado: string; fotoVersion: string | null },
  fotoWeb: string | null | undefined,
): { fotoUrl: string | null; fotoOrigen: OrigenFotoMedico | null } {
  if (fotoWeb) return { fotoUrl: fotoWeb, fotoOrigen: 'WEB' };
  if (m.estado === 'ACTIVO' && m.fotoVersion) return { fotoUrl: urlFotoDeAgenda(m.id, m.fotoVersion), fotoOrigen: 'AGENDA' };
  return { fotoUrl: null, fotoOrigen: null };
}

/** Cuántos códigos se resuelven de una vez: una página del historial de servicios. */
export const MAXIMO_CODIGOS_POR_CONSULTA = 50;

/** `medicoPk` del Excel y `medicos.codigo` de la agenda, comparados sin espacios ni mayúsculas. */
const claveDeCodigo = (codigo: string) => codigo.trim().toUpperCase();

/** El horario de la web que corresponde a las casillas encendidas de una ficha. */
function bloquesDeFicha(f: FichaMedicoAgenda) {
  return bloquesDeCasillas(
    f.casillas.filter(c => c.activa && (f.grilla.dias as readonly string[]).includes(c.dia)).map(c => ({ dia: c.dia as DiaAgenda, hora: c.hora })), f.grilla.minutosConsulta,
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
  /**
   * Los médicos con código, para ponerle cara a quien nombra el historial de
   * servicios. Son ~90 filas: se leen todas de una vez y se cruzan en memoria.
   * Dos minutos, y se vacía al editar o dar de alta un médico desde aquí.
   */
  private readonly conCodigo = new CacheMemoria<MedicoPorCodigo[]>({ ttlMs: 2 * 60_000, maxEntradas: 1 });

  constructor(
    private readonly agenda: AgendaAdminClient,
    private readonly prisma: PrismaService,
    private readonly directorio: DirectorioService,
    private readonly reservas: AgendaReservasService,
    private readonly horariosFilemaker: HorarioFilemakerService,
    private readonly citas: AgendaMedicoCitasService,
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
    const datos = r.datos.map(m => {
      const ficha = web.get(m.id) ?? null;
      return { ...this.paraQuienVe(m, usuario), web: ficha, ...fotoDelMedico(m, ficha?.fotoUrl) };
    });
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
    const presentacion = await this.directorio.fichaDeAgenda(id);
    const sincronizacionHorario = await this.horariosFilemaker.detalle(id);
    const ausencias = await this.ausencias(id);
    return { ...ficha, medico: this.paraQuienVe(ficha.medico, usuario), presentacion, sincronizacionHorario, ausencias, ...fotoDelMedico(ficha.medico, presentacion?.fotoUrl) };
  }

  /* ── Vacaciones y ausencias ─────────────────────────────────────────────── */

  /**
   * Las ausencias que todavía no terminaron, cada una con cuántas citas y
   * reservas ya tiene el médico en esos días: la agenda deja de ofrecerlos,
   * pero lo ya agendado lo reprograma recepción en FileMaker. `pendientes`
   * es `null` si la agenda no se pudo leer (la ausencia vale igual).
   */
  private async ausencias(id: number) {
    const lista = (await this.directorio.ausenciasDeAgenda([id])).get(id) ?? [];
    return Promise.all(lista.map(async a => ({ ...a, pendientes: await this.pendientesEntre(id, a.desde, a.hasta) })));
  }

  private async pendientesEntre(id: number, desde: string, hasta: string): Promise<{ citas: number; reservas: number } | null> {
    if (!this.citas.disponible()) return null;
    try {
      return await this.citas.citasEntre(id, desde, hasta);
    } catch (error: unknown) {
      this.logger.warn(`Citas del médico ${id} en su ausencia sin leer: ${error instanceof Error ? error.message : 'falló'}`);
      return null;
    }
  }

  async agregarAusencia(id: number, dto: CrearAusenciaDto, usuario: UsuarioJwt) {
    this.exigirEditar(usuario);
    await this.leerFicha(id);
    await this.directorio.agregarAusenciaDeAgenda(id, dto, usuario.sub);
    return { ausencias: await this.ausencias(id) };
  }

  async quitarAusencia(id: number, ausenciaId: string, usuario: UsuarioJwt) {
    this.exigirEditar(usuario);
    await this.directorio.quitarAusenciaDeAgenda(id, ausenciaId, usuario.sub);
    return { ausencias: await this.ausencias(id) };
  }

  /**
   * Los médicos de la agenda que corresponden a unos códigos de FileMaker (el
   * `medicoPk` del historial de servicios), con su foto: lo que permite ponerle
   * cara a cada fila y abrir su ficha del Directorio. Un código que no está en
   * la agenda no viene. Si la agenda no responde, la lista llega vacía: quien
   * la pide sigue mostrando las iniciales.
   */
  async porCodigos(codigos: readonly string[]) {
    const buscados = new Set(codigos.map(claveDeCodigo).filter(Boolean).slice(0, MAXIMO_CODIGOS_POR_CONSULTA));
    if (buscados.size === 0) return { datos: [] };
    let todos: MedicoPorCodigo[];
    try {
      todos = await this.conCodigo.resolver('todos', () => this.agenda.consultar(db => medicosConCodigo(db)));
    } catch (error: unknown) {
      this.logger.warn(`Médicos por código sin leer: ${error instanceof Error ? error.message : 'falló'}`);
      return { datos: [] };
    }
    /* Un código repetido en la agenda: gana el activo (vienen primero). */
    const porClave = new Map<string, MedicoPorCodigo>();
    for (const m of todos) {
      const clave = claveDeCodigo(m.codigo);
      if (buscados.has(clave) && !porClave.has(clave)) porClave.set(clave, m);
    }
    const encontrados = [...porClave.values()];
    const web = await this.directorio.resumenDeAgenda(encontrados.map(m => m.id));
    return {
      datos: encontrados.map(m => ({
        codigo: m.codigo, id: m.id, nombre: m.nombre, especialidad: m.especialidad, activo: m.estado === 'ACTIVO',
        ...fotoDelMedico(m, web.get(m.id)?.fotoUrl),
      })),
    };
  }

  /**
   * La foto que se dibuja en una imagen para la paciente (su horario): la de
   * la ficha web PUBLICADA, o la de la agenda; la misma que ve en la landing.
   * `null` si no tiene o no se puede leer: la imagen sale sin foto.
   */
  async fotoParaImagen(id: number): Promise<{ bytes: Buffer; tipo: string } | null> {
    try {
      return (await this.directorio.bytesDeFotoPublicaDeAgenda(id)) ?? (await this.reservas.fotoVigente(id));
    } catch (error: unknown) {
      this.logger.warn(`Foto del médico ${id} para la imagen: ${error instanceof Error ? error.message : 'falló'}`);
      return null;
    }
  }

  private async leerFicha(id: number): Promise<FichaMedicoAgenda> {
    const ficha = await this.agenda.consultar(db => fichaMedicoAgenda(db, id));
    if (!ficha) throw errorDe('NO_ENCONTRADO');
    return ficha;
  }

  private bloquesWeb(ficha: FichaMedicoAgenda) {
    return this.horariosFilemaker.activo()
      ? bloquesContiguos(ficha.casillas.filter(c => c.activa && (ficha.grilla.dias as readonly string[]).includes(c.dia)).map(c => ({ dia: c.dia as DiaAgenda, hora: c.hora })), ficha.grilla.minutosConsulta)
      : bloquesDeFicha(ficha);
  }

  /**
   * Tras guardar en la agenda: la ficha web (si hay) recibe el precio y el
   * horario nuevos. La agenda ya quedó guardada; si esto falla, se registra y
   * la web se pone al día en el próximo guardado.
   */
  private async sincronizarWeb(id: number, usuario: UsuarioJwt) {
    const ficha = await this.leerFicha(id);
    try {
      const bloques = this.bloquesWeb(ficha);
      await this.directorio.sincronizarConAgenda(id, { precioConsulta: precioWeb(ficha.medico.precio), orden: ficha.medico.orden, bloques });
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
    this.conCodigo.invalidar('todos');
    return this.sincronizarWeb(id, usuario);
  }

  async guardarHorario(id: number, dto: GuardarHorarioAgendaDto, usuario: UsuarioJwt) {
    this.exigirEditar(usuario);
    this.horariosFilemaker.exigirEdicionCrm();
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
    this.conCodigo.invalidar('todos');
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

  /**
   * El horario semanal de un médico ACTIVO, para mostrarlo a una paciente (la
   * imagen que manda el asistente). Solo lo público: nombre, especialidad y
   * bloques; `null` si no existe o no está activo.
   */
  async horarioSemanal(id: number): Promise<{ nombre: string; especialidad: string | null; precioBs: number | null; bloques: ReturnType<typeof bloquesDeFicha> } | null> {
    const f = await this.agenda.consultar(db => fichaMedicoAgenda(db, id));
    if (!f || f.medico.estado !== 'ACTIVO') return null;
    return {
      nombre: nombreLimpio([f.medico.sigla, f.medico.nombre].filter(Boolean).join(' ')).slice(0, 120),
      especialidad: f.medico.especialidad,
      precioBs: precioWeb(f.medico.precio),
      bloques: this.bloquesWeb(f),
    };
  }

  /** Crea la ficha web del médico: oculta, con su nombre, precio y horario de la agenda. */
  async crearPresentacion(id: number, usuario: UsuarioJwt) {
    this.exigirEditar(usuario);
    const f = await this.leerFicha(id);
    await this.directorio.crearFichaDeAgenda({
      agendaMedicoId: id,
      nombrePublico: nombreLimpio([f.medico.sigla, f.medico.nombre].filter(Boolean).join(' ')).slice(0, 120),
      codigoFilemaker: f.medico.codigo,
      especialidad: f.medico.especialidad,
      precioConsulta: precioWeb(f.medico.precio),
      orden: f.medico.orden,
      bloques: this.bloquesWeb(f),
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

  /**
   * La foto que ya tiene la agenda pasa a la ficha web: la mayoría de los
   * médicos ya tiene una en ScriptCase, y sin esto había que bajarla y volver
   * a subirla a mano. Pasa por las mismas validaciones que una subida.
   */
  async usarFotoDeAgenda(id: number, usuario: UsuarioJwt) {
    this.exigirEditar(usuario);
    const ficha = await this.presentacionDe(id);
    const foto = await this.reservas.fotoVigente(id);
    if (!foto) throw new NotFoundException('Este médico no tiene foto en la agenda (o está inactivo).');
    const extension = foto.tipo === 'image/png' ? 'png' : foto.tipo === 'image/webp' ? 'webp' : 'jpg';
    await this.directorio.subirFoto(ficha.id, { originalname: `agenda-${id}.${extension}`, mimetype: foto.tipo, size: foto.bytes.byteLength, buffer: foto.bytes }, usuario.sub);
    return this.ficha(id, usuario);
  }

  async quitarFoto(id: number, usuario: UsuarioJwt) {
    this.exigirEditar(usuario);
    const ficha = await this.presentacionDe(id);
    await this.directorio.quitarFoto(ficha.id, usuario.sub);
    return this.ficha(id, usuario);
  }
}
