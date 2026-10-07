import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  StreamableFile,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as ReadableStreamWeb } from 'node:stream/web';

import { ArchivoSubido } from '../../common/archivos/archivo-subido';
import { AuditService } from '../../common/audit/audit.service';
import { calcularPaginacion, paginar } from '../../common/dto/pagination.dto';
import { fechaCivilClinica, fechaCivilDesdeTexto, textoDeFechaCivil } from '../../common/fechas/zona-clinica';
import { enSegundoPlano } from '../../common/fiabilidad/en-segundo-plano';
import { AvisoLandingService } from '../../common/landing/aviso-landing.service';
import { urlPublica, validarImagenPublica } from '../../common/storage/imagen-publica';
import { R2Service } from '../../common/storage/r2.service';
import { aSlug } from '../../common/texto/slug';
import { esChoqueUnicoEn } from '../../prisma/choque-unico';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ActualizarEspecialidadDto,
  CrearEspecialidadDto,
  QueryEspecialidadesDto,
} from './dto/especialidad.dto';
import {
  ActualizarPerfilMedicoDto,
  CrearAusenciaDto,
  CrearPerfilMedicoDto,
  GuardarHorarioDto,
  QueryDirectorioPublicoDto,
  QueryMedicosSinFichaDto,
  QueryPerfilesMedicosDto,
} from './dto/perfil-medico.dto';
import { BloqueHorario, erroresDelHorario, horaDeMinutos, minutosDeHora, ordenarBloques, resumenDelHorario } from './horario';

/** Ausencias futuras que se aceptan por médico: más es un error de carga. */
const AUSENCIAS_MAXIMAS = 50;
/** Una foto de ficha más chica que esto se ve pixelada en la tarjeta. */
const LADO_MINIMO_FOTO = 400;

const SELECT_ESPECIALIDAD = { id: true, nombre: true, slug: true } as const;

const INCLUIR_FICHA = {
  especialidades: { select: { especialidad: { select: { ...SELECT_ESPECIALIDAD, activa: true } } } },
  horarios: { select: { id: true, diaSemana: true, inicioMinuto: true, finMinuto: true, lugar: true } },
} satisfies Prisma.PerfilMedicoInclude;

type FichaConRelaciones = Prisma.PerfilMedicoGetPayload<{ include: typeof INCLUIR_FICHA }>;

/**
 * La clave con que se reconoce la página web de una especialidad de la agenda:
 * sin mayúsculas, tildes ni espacios de más. Es la misma regla que aplica la
 * colación de la agenda (utf8mb4_0900_ai_ci), así que «Pediatría» y
 * «pediatria» son la misma especialidad allí y aquí.
 */
export function claveDeEspecialidad(nombre: string): string {
  return nombre.normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** La página web de una especialidad, como la ve la pestaña Especialidades. */
export interface PaginaDeEspecialidad {
  id: string;
  nombre: string;
  slug: string;
  descripcion: string;
  activa: boolean;
  orden: number;
  /** Médicos con ficha web PUBLICADA en esta página. */
  publicados: number;
}

/** Lo que la agenda le pasa al directorio de uno de sus médicos. */
export interface DatosFichaDeAgenda {
  agendaMedicoId: number;
  nombrePublico: string;
  /** La especialidad escrita en la agenda: si tiene página web, la ficha nace en ella. */
  especialidad: string | null;
  codigoFilemaker: string | null;
  /** En Bs; null si la agenda no tiene precio (o tiene 0). */
  precioConsulta: number | null;
  /** El orden de la agenda: el médico sale en el mismo lugar en la reserva y en «Staff médico». */
  orden: number;
  bloques: BloqueHorario[];
}

export interface ResumenWebDeAgenda {
  perfilId: string;
  publicado: boolean;
  fotoUrl: string | null;
}

/** Ausencias que lleva cada médico en el listado público: la landing ofrece las próximas dos semanas. */
const AUSENCIAS_EN_LISTADO = 5;

const SELECT_AUSENCIA = { desde: true, hasta: true, motivoPublico: true } as const;

function ausenciaPublica(a: { desde: Date; hasta: Date; motivoPublico: string | null }) {
  return { desde: textoDeFechaCivil(a.desde), hasta: textoDeFechaCivil(a.hasta), motivo: a.motivoPublico };
}

function bloquePublico(b: BloqueHorario) {
  return { diaSemana: b.diaSemana, desde: horaDeMinutos(b.inicioMinuto), hasta: horaDeMinutos(b.finMinuto), lugar: b.lugar ?? null };
}

/**
 * El directorio médico: especialidades, la ficha pública de cada médico y su
 * horario semanal informativo. Único dueño de `Especialidad`, `PerfilMedico`,
 * `PerfilMedicoEspecialidad`, `HorarioMedico` y `AusenciaMedico`. Lee `Medico`
 * (de comisiones) para enlazar la ficha con su código de FileMaker; no lo escribe.
 *
 * Diseño: docs/promociones-y-directorio.md.
 */
@Injectable()
export class DirectorioService {
  private readonly logger = new Logger(DirectorioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
    private readonly audit: AuditService,
    private readonly landing: AvisoLandingService,
  ) {}

  /* ── Especialidades ─────────────────────────────────────────────────── */

  async listarEspecialidades(query: QueryEspecialidadesDto) {
    const where: Prisma.EspecialidadWhereInput = {
      ...(query.incluirInactivas ? {} : { activa: true }),
      ...(query.buscar?.trim() ? { nombre: { contains: query.buscar.trim(), mode: 'insensitive' } } : {}),
    };
    const { skip, take } = calcularPaginacion(query);
    const [datos, total] = await this.prisma.$transaction([
      this.prisma.especialidad.findMany({
        where,
        orderBy: [{ orden: 'asc' }, { nombre: 'asc' }],
        skip,
        take,
        include: { _count: { select: { medicos: true } } },
      }),
      this.prisma.especialidad.count({ where }),
    ]);
    return paginar(
      datos.map(({ _count, ...e }) => ({ ...e, medicos: _count.medicos })),
      total,
      query,
    );
  }

  async crearEspecialidad(dto: CrearEspecialidadDto, usuarioId: string) {
    const creada = await this.conSlugLibre('Especialidad', aSlug(dto.nombre), slug =>
      this.prisma.especialidad.create({
        data: { nombre: dto.nombre, slug, descripcion: dto.descripcion ?? '', orden: dto.orden ?? 0 },
      }),
    ).catch((error: unknown) => {
      if (esChoqueUnicoEn(error, 'Especialidad', 'nombre')) throw new ConflictException(`Ya existe la especialidad «${dto.nombre}».`);
      throw error;
    });
    await this.audit.registrar('Especialidad', creada.id, 'ESPECIALIDAD_CREADA', usuarioId, { nombre: creada.nombre });
    this.landing.avisar('directorio', 'promociones');
    return creada;
  }

  async actualizarEspecialidad(id: string, dto: ActualizarEspecialidadDto, usuarioId: string) {
    await this.especialidadOFallar(id);
    try {
      const actualizada = await this.prisma.especialidad.update({ where: { id }, data: dto });
      await this.audit.registrar('Especialidad', id, 'ESPECIALIDAD_EDITADA', usuarioId, { ...dto });
      this.landing.avisar('directorio', 'promociones');
      return actualizada;
    } catch (error) {
      if (esChoqueUnicoEn(error, 'Especialidad', 'nombre')) throw new ConflictException(`Ya existe la especialidad «${dto.nombre}».`);
      throw error;
    }
  }

  private async especialidadOFallar(id: string) {
    const e = await this.prisma.especialidad.findUnique({ where: { id }, select: { id: true } });
    if (!e) throw new NotFoundException('Esa especialidad no existe.');
    return e;
  }

  /** Las especialidades pedidas existen y están activas; si no, 400 con cuáles faltan. */
  private async exigirEspecialidadesActivas(ids: readonly string[]) {
    if (ids.length === 0) return;
    const encontradas = await this.prisma.especialidad.findMany({ where: { id: { in: [...ids] }, activa: true }, select: { id: true } });
    if (encontradas.length !== ids.length) throw new BadRequestException('Alguna especialidad no existe o está inactiva.');
  }

  /* ── Fichas de médicos (CRM) ────────────────────────────────────────── */

  async listarFichas(query: QueryPerfilesMedicosDto) {
    const termino = query.buscar?.trim();
    const where: Prisma.PerfilMedicoWhereInput = {
      ...(termino ? { nombrePublico: { contains: termino, mode: 'insensitive' } } : {}),
      ...(query.especialidadId ? { especialidades: { some: { especialidadId: query.especialidadId } } } : {}),
      ...(query.publicado === undefined ? {} : { publicado: query.publicado }),
    };
    const { skip, take } = calcularPaginacion(query);
    const [filas, total] = await this.prisma.$transaction([
      this.prisma.perfilMedico.findMany({
        where,
        orderBy: [{ orden: 'asc' }, { nombrePublico: 'asc' }],
        skip,
        take,
        include: { ...INCLUIR_FICHA, medico: { select: { codigo: true } } },
      }),
      this.prisma.perfilMedico.count({ where }),
    ]);
    const datos = await Promise.all(
      filas.map(async f => ({
        id: f.id,
        nombrePublico: f.nombrePublico,
        slug: f.slug,
        publicado: f.publicado,
        codigoFilemaker: f.medico?.codigo ?? null,
        agendaMedicoId: f.agendaMedicoId,
        especialidades: f.especialidades.map(e => e.especialidad),
        resumenHorario: resumenDelHorario(f.horarios),
        fotoUrl: f.fotoClave ? await this.r2.urlFirmada(f.fotoClave) : null,
        precioConsulta: f.precioConsulta?.toNumber() ?? null,
        version: f.version,
      })),
    );
    return paginar(datos, total, query);
  }

  async obtenerFicha(id: string) {
    const f = await this.prisma.perfilMedico.findUnique({
      where: { id },
      include: {
        ...INCLUIR_FICHA,
        medico: { select: { id: true, codigo: true, nombre: true } },
        ausencias: {
          where: { hasta: { gte: fechaCivilClinica(new Date()) } },
          orderBy: { desde: 'asc' },
          select: { id: true, desde: true, hasta: true, motivoPublico: true },
        },
      },
    });
    if (!f) throw new NotFoundException('Esa ficha no existe.');
    return {
      id: f.id,
      nombrePublico: f.nombrePublico,
      slug: f.slug,
      resumen: f.resumen,
      biografia: f.biografia,
      matricula: f.matricula,
      precioConsulta: f.precioConsulta?.toNumber() ?? null,
      publicado: f.publicado,
      orden: f.orden,
      version: f.version,
      agendaMedicoId: f.agendaMedicoId,
      medico: f.medico,
      especialidades: f.especialidades.map(e => e.especialidad),
      horario: ordenarBloques(f.horarios).map(bloquePublico),
      resumenHorario: resumenDelHorario(f.horarios),
      ausencias: f.ausencias.map(a => ({ id: a.id, desde: textoDeFechaCivil(a.desde), hasta: textoDeFechaCivil(a.hasta), motivoPublico: a.motivoPublico })),
      fotoUrl: f.fotoClave ? await this.r2.urlFirmada(f.fotoClave) : null,
      updatedAt: f.updatedAt,
    };
  }

  async crearFicha(dto: CrearPerfilMedicoDto, usuarioId: string) {
    const especialidadIds = dto.especialidadIds ?? [];
    await this.exigirEspecialidadesActivas(especialidadIds);
    if (dto.medicoId) {
      const medico = await this.prisma.medico.findUnique({ where: { id: dto.medicoId }, select: { id: true } });
      if (!medico) throw new BadRequestException('Ese médico no existe en la planilla.');
    }
    const creada = await this.conSlugLibre('PerfilMedico', aSlug(dto.nombrePublico, 110), slug =>
      this.prisma.perfilMedico.create({
        data: {
          nombrePublico: dto.nombrePublico,
          slug,
          medicoId: dto.medicoId,
          especialidades: { create: especialidadIds.map(especialidadId => ({ especialidadId })) },
        },
        select: { id: true },
      }),
    ).catch((error: unknown) => {
      if (esChoqueUnicoEn(error, 'PerfilMedico', 'medicoId')) throw new ConflictException('Ese médico ya tiene una ficha.');
      throw error;
    });
    await this.audit.registrar('PerfilMedico', creada.id, 'FICHA_MEDICO_CREADA', usuarioId, { nombrePublico: dto.nombrePublico });
    return this.obtenerFicha(creada.id);
  }

  /**
   * Edición de la ficha con bloqueo optimista: el UPDATE exige la versión que
   * leyó quien edita, así que de dos personas guardando a la vez la segunda
   * recibe 409 en vez de pisar a la primera sin saberlo.
   */
  async actualizarFicha(id: string, dto: ActualizarPerfilMedicoDto, usuarioId: string) {
    const { version, especialidadIds, ...campos } = dto;
    if (campos.precioConsulta !== undefined || campos.orden !== undefined) {
      await this.exigirSinAgenda(id, 'El precio y el orden de este médico se editan en la agenda.');
    }
    if (especialidadIds) await this.exigirEspecialidadesActivas(especialidadIds);
    if (campos.medicoId) {
      const medico = await this.prisma.medico.findUnique({ where: { id: campos.medicoId }, select: { id: true } });
      if (!medico) throw new BadRequestException('Ese médico no existe en la planilla.');
    }
    try {
      await this.prisma.$transaction(async tx => {
        const actual = await this.exigirVersion(tx, id, version);
        if (especialidadIds && especialidadIds.length === 0 && actual.publicado) {
          throw new BadRequestException('Una ficha publicada necesita al menos una especialidad.');
        }
        await tx.perfilMedico.update({ where: { id }, data: { ...campos, version: { increment: 1 } } });
        if (especialidadIds) {
          await tx.perfilMedicoEspecialidad.deleteMany({ where: { perfilMedicoId: id } });
          await tx.perfilMedicoEspecialidad.createMany({ data: especialidadIds.map(especialidadId => ({ perfilMedicoId: id, especialidadId })) });
        }
      });
    } catch (error) {
      if (esChoqueUnicoEn(error, 'PerfilMedico', 'medicoId')) throw new ConflictException('Ese médico ya tiene otra ficha.');
      throw error;
    }
    await this.audit.registrar('PerfilMedico', id, 'FICHA_MEDICO_EDITADA', usuarioId, { campos: Object.keys(dto).filter(k => k !== 'version') });
    return this.avisarSiPublicada(await this.obtenerFicha(id));
  }

  /** El horario semanal entero, de una vez. Vacío = «con cita a solicitud». */
  async guardarHorario(id: string, dto: GuardarHorarioDto, usuarioId: string) {
    const bloques: BloqueHorario[] = dto.bloques.map(b => ({
      diaSemana: b.diaSemana,
      inicioMinuto: minutosDeHora(b.desde) ?? -1,
      finMinuto: minutosDeHora(b.hasta) ?? -1,
      lugar: b.lugar ?? null,
    }));
    const errores = erroresDelHorario(bloques);
    if (errores.length) throw new BadRequestException(errores);
    await this.exigirSinAgenda(id, 'El horario de este médico se edita en la agenda: es el que da los cupos.');
    await this.prisma.$transaction(async tx => {
      await this.exigirVersion(tx, id, dto.version);
      await tx.perfilMedico.update({ where: { id }, data: { version: { increment: 1 } } });
      await tx.horarioMedico.deleteMany({ where: { perfilMedicoId: id } });
      await tx.horarioMedico.createMany({ data: bloques.map(b => ({ ...b, perfilMedicoId: id })) });
    });
    await this.audit.registrar('PerfilMedico', id, 'HORARIO_MEDICO_GUARDADO', usuarioId, { bloques: bloques.length });
    return this.avisarSiPublicada(await this.obtenerFicha(id));
  }

  async agregarAusencia(id: string, dto: CrearAusenciaDto, usuarioId: string) {
    const desde = fechaCivilDesdeTexto(dto.desde);
    const hasta = fechaCivilDesdeTexto(dto.hasta);
    if (!desde || !hasta) throw new BadRequestException('Alguna de las fechas no existe.');
    if (desde > hasta) throw new BadRequestException('La ausencia termina antes de empezar.');
    if (hasta < fechaCivilClinica(new Date())) throw new BadRequestException('Esa ausencia ya pasó.');
    await this.fichaOFallar(id);
    const futuras = await this.prisma.ausenciaMedico.count({ where: { perfilMedicoId: id, hasta: { gte: fechaCivilClinica(new Date()) } } });
    if (futuras >= AUSENCIAS_MAXIMAS) throw new BadRequestException(`Hay ${AUSENCIAS_MAXIMAS} ausencias cargadas; quita alguna antes.`);
    const creada = await this.prisma.ausenciaMedico.create({
      data: { perfilMedicoId: id, desde, hasta, motivoPublico: dto.motivoPublico ?? null },
    });
    await this.audit.registrar('PerfilMedico', id, 'AUSENCIA_MEDICO_CREADA', usuarioId, { desde: dto.desde, hasta: dto.hasta });
    this.landing.avisar('directorio');
    return { id: creada.id, desde: dto.desde, hasta: dto.hasta, motivoPublico: creada.motivoPublico };
  }

  async quitarAusencia(id: string, ausenciaId: string, usuarioId: string) {
    const { count } = await this.prisma.ausenciaMedico.deleteMany({ where: { id: ausenciaId, perfilMedicoId: id } });
    if (!count) throw new NotFoundException('Esa ausencia no existe.');
    await this.audit.registrar('PerfilMedico', id, 'AUSENCIA_MEDICO_QUITADA', usuarioId, { ausenciaId });
    this.landing.avisar('directorio');
  }

  /** Publicar exige al menos una especialidad activa: una ficha sin especialidad no se puede buscar. */
  async publicar(id: string, publicado: boolean, usuarioId: string) {
    const ficha = await this.prisma.perfilMedico.findUnique({
      where: { id },
      select: { especialidades: { where: { especialidad: { activa: true } }, select: { especialidadId: true } } },
    });
    if (!ficha) throw new NotFoundException('Esa ficha no existe.');
    if (publicado && ficha.especialidades.length === 0) {
      throw new BadRequestException('Para publicar la ficha, asígnale al menos una especialidad activa.');
    }
    await this.prisma.perfilMedico.update({ where: { id }, data: { publicado, version: { increment: 1 } } });
    await this.audit.registrar('PerfilMedico', id, publicado ? 'FICHA_MEDICO_PUBLICADA' : 'FICHA_MEDICO_OCULTADA', usuarioId);
    this.landing.avisar('directorio', 'promociones');
    return this.obtenerFicha(id);
  }

  /**
   * La foto de la ficha. Se valida por sus bytes, va a R2 con un id nuevo (URL
   * pública inmutable) y la anterior se borra DESPUÉS de guardar la nueva: si
   * algo falla a mitad, la ficha nunca queda apuntando a un archivo borrado.
   */
  async subirFoto(id: string, archivo: ArchivoSubido | undefined, usuarioId: string) {
    if (!archivo) throw new BadRequestException('Falta la imagen.');
    const imagen = validarImagenPublica(archivo.buffer);
    if ('error' in imagen) throw new BadRequestException(imagen.error);
    if (Math.min(imagen.ancho, imagen.alto) < LADO_MINIMO_FOTO) {
      throw new BadRequestException(`La foto tiene que medir al menos ${LADO_MINIMO_FOTO}×${LADO_MINIMO_FOTO} px.`);
    }
    if (!this.r2.habilitado) throw new ServiceUnavailableException('El almacenamiento de imágenes no está configurado.');
    const anterior = await this.prisma.perfilMedico.findUnique({ where: { id }, select: { fotoClave: true } });
    if (!anterior) throw new NotFoundException('Esa ficha no existe.');

    const fotoId = randomUUID();
    const clave = `directorio/${id}/${fotoId}.${imagen.extension}`;
    await this.r2.subir(clave, new Uint8Array(archivo.buffer).slice().buffer, imagen.mime);
    await this.prisma.perfilMedico.update({
      where: { id },
      data: { fotoId, fotoClave: clave, fotoMime: imagen.mime, version: { increment: 1 } },
    });
    if (anterior.fotoClave) this.borrarDeR2(anterior.fotoClave);
    await this.audit.registrar('PerfilMedico', id, 'FOTO_MEDICO_SUBIDA', usuarioId, { ancho: imagen.ancho, alto: imagen.alto });
    return this.avisarSiPublicada(await this.obtenerFicha(id));
  }

  async quitarFoto(id: string, usuarioId: string) {
    const ficha = await this.prisma.perfilMedico.findUnique({ where: { id }, select: { fotoClave: true } });
    if (!ficha) throw new NotFoundException('Esa ficha no existe.');
    if (!ficha.fotoClave) return this.obtenerFicha(id);
    await this.prisma.perfilMedico.update({ where: { id }, data: { fotoId: null, fotoClave: null, fotoMime: null, version: { increment: 1 } } });
    this.borrarDeR2(ficha.fotoClave);
    await this.audit.registrar('PerfilMedico', id, 'FOTO_MEDICO_QUITADA', usuarioId);
    return this.avisarSiPublicada(await this.obtenerFicha(id));
  }

  /** Médicos de la planilla de comisiones que todavía no tienen ficha: para enlazarlos al crearla. */
  async medicosSinFicha(query: QueryMedicosSinFichaDto) {
    const termino = query.buscar?.trim();
    const where: Prisma.MedicoWhereInput = {
      activo: true,
      perfil: { is: null },
      ...(termino
        ? { OR: [{ nombre: { contains: termino, mode: 'insensitive' } }, { codigo: { contains: termino, mode: 'insensitive' } }] }
        : {}),
    };
    const { skip, take } = calcularPaginacion(query);
    const [datos, total] = await this.prisma.$transaction([
      this.prisma.medico.findMany({ where, orderBy: { nombre: 'asc' }, skip, take, select: { id: true, codigo: true, nombre: true, especialidad: true } }),
      this.prisma.medico.count({ where }),
    ]);
    return paginar(datos, total, query);
  }

  /* ── Fichas de médicos de la AGENDA ─────────────────────────────────── */
  /*
   * La ficha web de un médico de la agenda de la clínica (ScriptCase): la agenda
   * es dueña de su nombre, precio y horario —son los que dan los cupos—; la ficha
   * pone lo que la agenda no tiene: foto, resumen, biografía, matrícula, las
   * especialidades de la web y si se publica. El módulo `agenda` llama a estos
   * métodos; nunca escribe estas tablas por su cuenta.
   */

  /** La ficha enlazada a un médico de la agenda, o null si todavía no tiene. */
  async fichaDeAgenda(agendaMedicoId: number) {
    const f = await this.prisma.perfilMedico.findUnique({ where: { agendaMedicoId }, select: { id: true } });
    return f ? this.obtenerFicha(f.id) : null;
  }

  /**
   * Crea la ficha web de un médico de la agenda: nace OCULTA, con el nombre, el
   * precio y el horario de la agenda, y enlazada al médico de comisiones que
   * tenga su mismo código de FileMaker (si lo hay y no tiene ya otra ficha).
   */
  async crearFichaDeAgenda(agenda: DatosFichaDeAgenda, usuarioId: string) {
    const medico = agenda.codigoFilemaker
      ? await this.prisma.medico.findFirst({ where: { codigo: agenda.codigoFilemaker, perfil: { is: null } }, select: { id: true } })
      : null;
    const pagina = agenda.especialidad ? (await this.paginasDeEspecialidades([agenda.especialidad])).get(claveDeEspecialidad(agenda.especialidad)) : undefined;
    const creada = await this.conSlugLibre('PerfilMedico', aSlug(agenda.nombrePublico, 110), slug =>
      this.prisma.perfilMedico.create({
        data: {
          nombrePublico: agenda.nombrePublico,
          slug,
          agendaMedicoId: agenda.agendaMedicoId,
          medicoId: medico?.id,
          precioConsulta: agenda.precioConsulta,
          orden: agenda.orden,
          ...(pagina?.activa ? { especialidades: { create: [{ especialidadId: pagina.id }] } } : {}),
          horarios: { create: agenda.bloques.map(({ diaSemana, inicioMinuto, finMinuto }) => ({ diaSemana, inicioMinuto, finMinuto })) },
        },
        select: { id: true },
      }),
    ).catch((error: unknown) => {
      if (esChoqueUnicoEn(error, 'PerfilMedico', 'agendaMedicoId')) throw new ConflictException('Este médico ya tiene su ficha web.');
      throw error;
    });
    await this.audit.registrar('PerfilMedico', creada.id, 'FICHA_MEDICO_CREADA', usuarioId, { agendaMedicoId: agenda.agendaMedicoId });
    return this.obtenerFicha(creada.id);
  }

  /**
   * Lleva a la ficha web el precio, el orden y el horario que se acaban de
   * guardar en la agenda. Sin ficha enlazada no hace nada. No mueve la versión de la ficha a
   * propósito: quien la tenga abierta para la biografía no recibe un 409 porque
   * otra persona cambió el horario.
   */
  async sincronizarConAgenda(agendaMedicoId: number, datos: Pick<DatosFichaDeAgenda, 'precioConsulta' | 'orden' | 'bloques'>) {
    const ficha = await this.prisma.perfilMedico.findUnique({ where: { agendaMedicoId }, select: { id: true, publicado: true } });
    if (!ficha) return;
    await this.prisma.$transaction([
      this.prisma.perfilMedico.update({ where: { id: ficha.id }, data: { precioConsulta: datos.precioConsulta, orden: datos.orden } }),
      this.prisma.horarioMedico.deleteMany({ where: { perfilMedicoId: ficha.id } }),
      this.prisma.horarioMedico.createMany({
        data: datos.bloques.map(({ diaSemana, inicioMinuto, finMinuto }) => ({ perfilMedicoId: ficha.id, diaSemana, inicioMinuto, finMinuto })),
      }),
    ]);
    this.avisarSiPublicada(ficha);
  }

  /** Para el listado del CRM: la ficha web (foto firmada y si está publicada) de cada médico de la agenda que tenga. */
  async resumenDeAgenda(agendaMedicoIds: readonly number[]): Promise<Map<number, ResumenWebDeAgenda>> {
    if (agendaMedicoIds.length === 0) return new Map();
    const fichas = await this.prisma.perfilMedico.findMany({
      where: { agendaMedicoId: { in: [...agendaMedicoIds] } },
      select: { id: true, agendaMedicoId: true, publicado: true, fotoClave: true },
    });
    const pares = await Promise.all(
      fichas.map(async f => [f.agendaMedicoId!, {
        perfilId: f.id,
        publicado: f.publicado,
        fotoUrl: f.fotoClave ? await this.r2.urlFirmada(f.fotoClave) : null,
      }] as const),
    );
    return new Map(pares);
  }

  /**
   * La página web de cada especialidad de la agenda, por su clave
   * (`claveDeEspecialidad`). Son decenas: se leen todas y se cruzan en memoria.
   */
  async paginasDeEspecialidades(nombres: readonly string[]): Promise<Map<string, PaginaDeEspecialidad>> {
    if (nombres.length === 0) return new Map();
    const buscadas = new Set(nombres.map(claveDeEspecialidad));
    const filas = await this.prisma.especialidad.findMany({
      select: {
        id: true, nombre: true, slug: true, descripcion: true, activa: true, orden: true,
        _count: { select: { medicos: { where: { perfilMedico: { publicado: true } } } } },
      },
    });
    return new Map(
      filas
        .filter(e => buscadas.has(claveDeEspecialidad(e.nombre)))
        .map(({ _count, ...e }) => [claveDeEspecialidad(e.nombre), { ...e, publicados: _count.medicos }] as const),
    );
  }

  /** Crea la página web de las especialidades que no tienen. Devuelve cuántas creó. */
  async crearPaginasDeEspecialidades(nombres: readonly string[], usuarioId: string): Promise<number> {
    const existentes = await this.paginasDeEspecialidades(nombres);
    const faltan = new Map<string, string>();
    for (const n of nombres) {
      const clave = claveDeEspecialidad(n);
      if (clave && !existentes.has(clave) && !faltan.has(clave)) faltan.set(clave, n.trim().slice(0, 80));
    }
    for (const nombre of faltan.values()) await this.crearEspecialidad({ nombre }, usuarioId);
    return faltan.size;
  }

  /**
   * Al renombrar una especialidad en la agenda, su página web la acompaña: si
   * la vieja tiene página y la nueva no, se renombra (la dirección `slug` no
   * cambia). Si las dos tienen, se dejan como están: unificarlas es decisión
   * de quien edita.
   */
  async renombrarPaginaDeEspecialidad(actual: string, nueva: string, usuarioId: string): Promise<void> {
    const paginas = await this.paginasDeEspecialidades([actual, nueva]);
    const vieja = paginas.get(claveDeEspecialidad(actual));
    if (!vieja || paginas.has(claveDeEspecialidad(nueva)) || claveDeEspecialidad(actual) === claveDeEspecialidad(nueva)) return;
    await this.actualizarEspecialidad(vieja.id, { nombre: nueva.trim().slice(0, 80) }, usuarioId);
  }

  /**
   * Para la reserva web: la foto pública de los médicos de la agenda con ficha
   * PUBLICADA y foto. Es la misma URL inmutable que sirve el directorio.
   */
  async fotosPublicasDeAgenda(agendaMedicoIds: readonly number[]): Promise<Map<number, string>> {
    if (agendaMedicoIds.length === 0) return new Map();
    const fichas = await this.prisma.perfilMedico.findMany({
      where: { agendaMedicoId: { in: [...agendaMedicoIds] }, publicado: true, fotoId: { not: null } },
      select: { agendaMedicoId: true, fotoId: true },
    });
    return new Map(fichas.map(f => [f.agendaMedicoId!, urlPublica(`/publico/directorio/fotos/${f.fotoId}`)]));
  }

  /* ── Directorio público (landing) ───────────────────────────────────── */

  /** Especialidades activas, con cuántos médicos publicados tiene cada una. */
  async especialidadesPublicas(query: QueryDirectorioPublicoDto) {
    const where: Prisma.EspecialidadWhereInput = { activa: true };
    const { skip, take } = calcularPaginacion(query);
    const [filas, total] = await this.prisma.$transaction([
      this.prisma.especialidad.findMany({
        where,
        orderBy: [{ orden: 'asc' }, { nombre: 'asc' }],
        skip,
        take,
        select: {
          ...SELECT_ESPECIALIDAD,
          descripcion: true,
          _count: { select: { medicos: { where: { perfilMedico: { publicado: true } } } } },
        },
      }),
      this.prisma.especialidad.count({ where }),
    ]);
    return paginar(
      filas.map(({ _count, ...e }) => ({ ...e, medicos: _count.medicos })),
      total,
      query,
    );
  }

  async medicosPublicos(query: QueryDirectorioPublicoDto) {
    const hoy = fechaCivilClinica(new Date());
    const where: Prisma.PerfilMedicoWhereInput = {
      publicado: true,
      ...(query.especialidad
        ? { especialidades: { some: { especialidad: { slug: query.especialidad, activa: true } } } }
        : { especialidades: { some: { especialidad: { activa: true } } } }),
    };
    const { skip, take } = calcularPaginacion(query);
    const [filas, total] = await this.prisma.$transaction([
      this.prisma.perfilMedico.findMany({
        where,
        orderBy: [{ orden: 'asc' }, { nombrePublico: 'asc' }],
        skip,
        take,
        include: {
          ...INCLUIR_FICHA,
          // Las próximas, para que la landing no ofrezca un día en que el médico no está.
          ausencias: { where: { hasta: { gte: hoy } }, orderBy: { desde: 'asc' }, take: AUSENCIAS_EN_LISTADO, select: SELECT_AUSENCIA },
        },
      }),
      this.prisma.perfilMedico.count({ where }),
    ]);
    return paginar(
      filas.map(f => ({ ...this.tarjetaPublica(f), ausencias: f.ausencias.map(ausenciaPublica) })),
      total,
      query,
    );
  }

  async medicoPublico(slug: string) {
    const hoy = fechaCivilClinica(new Date());
    const f = await this.prisma.perfilMedico.findFirst({
      where: { slug, publicado: true },
      include: {
        ...INCLUIR_FICHA,
        ausencias: { where: { hasta: { gte: hoy } }, orderBy: { desde: 'asc' }, select: SELECT_AUSENCIA },
      },
    });
    if (!f) throw new NotFoundException('Ese médico no está en el directorio.');
    return {
      ...this.tarjetaPublica(f),
      biografia: f.biografia,
      matricula: f.matricula,
      ausencias: f.ausencias.map(ausenciaPublica),
    };
  }

  /** La foto de una ficha PUBLICADA. Una oculta no se sirve aunque se conozca su id. */
  async fotoPublica(fotoId: string): Promise<StreamableFile> {
    const ficha = await this.prisma.perfilMedico.findFirst({ where: { fotoId, publicado: true }, select: { fotoClave: true, fotoMime: true } });
    if (!ficha?.fotoClave) throw new NotFoundException('Esa foto no existe.');
    const objeto = await this.r2.leer(ficha.fotoClave);
    if (!objeto) throw new NotFoundException('Esa foto no existe.');
    return new StreamableFile(Readable.fromWeb(objeto.cuerpo as ReadableStreamWeb<Uint8Array>), {
      type: ficha.fotoMime ?? objeto.tipo ?? 'application/octet-stream',
      ...(objeto.bytes ? { length: objeto.bytes } : {}),
    });
  }

  /**
   * Avisa a la landing si la ficha está a la vista. También renueva las
   * promociones: muestran el nombre de los médicos que las atienden.
   */
  private avisarSiPublicada<T extends { publicado: boolean }>(ficha: T): T {
    if (ficha.publicado) this.landing.avisar('directorio', 'promociones');
    return ficha;
  }

  /** Lo que se publica de un médico. Nada interno: ni versión, ni código de FileMaker, ni la clave de R2. */
  private tarjetaPublica(f: FichaConRelaciones) {
    return {
      slug: f.slug,
      nombre: f.nombrePublico,
      resumen: f.resumen,
      especialidades: f.especialidades.filter(e => e.especialidad.activa).map(e => ({ slug: e.especialidad.slug, nombre: e.especialidad.nombre })),
      fotoUrl: f.fotoId ? urlPublica(`/publico/directorio/fotos/${f.fotoId}`) : null,
      precioConsulta: f.precioConsulta?.toNumber() ?? null,
      horario: ordenarBloques(f.horarios).map(bloquePublico),
      resumenHorario: resumenDelHorario(f.horarios),
    };
  }

  /* ── Internos ───────────────────────────────────────────────────────── */

  /** Una ficha enlazada a la agenda recibe su precio y horario de allí: aquí no se tocan. */
  private async exigirSinAgenda(id: string, mensaje: string) {
    const f = await this.prisma.perfilMedico.findUnique({ where: { id }, select: { agendaMedicoId: true } });
    if (!f) throw new NotFoundException('Esa ficha no existe.');
    if (f.agendaMedicoId !== null) throw new BadRequestException(mensaje);
  }

  private async fichaOFallar(id: string) {
    const f = await this.prisma.perfilMedico.findUnique({ where: { id }, select: { id: true } });
    if (!f) throw new NotFoundException('Esa ficha no existe.');
  }

  /** Dentro de una transacción: la ficha existe y nadie la guardó desde que se leyó. */
  private async exigirVersion(tx: Prisma.TransactionClient, id: string, version: number) {
    /* Bloquea la fila hasta el final de la transacción: de dos guardados
       simultáneos con la misma versión, el segundo espera y ya ve la nueva. */
    const [actual] = await tx.$queryRaw<{ version: number; publicado: boolean }[]>`
      SELECT version, publicado FROM "PerfilMedico" WHERE id = ${id} FOR NO KEY UPDATE`;
    if (!actual) throw new NotFoundException('Esa ficha no existe.');
    if (actual.version !== version) throw new ConflictException('Otra persona guardó cambios en esta ficha. Recárgala y vuelve a intentarlo.');
    return actual;
  }

  /** Crea con el slug pedido; si ya existe, prueba `-2`, `-3`… El slug no se reutiliza ni se edita. */
  private async conSlugLibre<T>(tabla: string, base: string, crear: (slug: string) => Promise<T>): Promise<T> {
    for (let intento = 1; intento <= 20; intento++) {
      const slug = intento === 1 ? base : `${base}-${intento}`;
      try {
        return await crear(slug);
      } catch (error) {
        if (!esChoqueUnicoEn(error, tabla, 'slug')) throw error;
      }
    }
    throw new ConflictException('No se encontró una dirección libre para ese nombre.');
  }

  private borrarDeR2(clave: string) {
    void enSegundoPlano(`borrar ${clave} de R2`, this.logger, () => this.r2.eliminar(clave));
  }
}
