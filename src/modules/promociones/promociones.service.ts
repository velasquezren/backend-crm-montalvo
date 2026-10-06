import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import { cubreRol } from '../../common/auth/roles';
import { UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { calcularPaginacion, paginar } from '../../common/dto/pagination.dto';
import { fechaCivilClinica, fechaCivilDesdeTexto, textoDeFechaCivil } from '../../common/fechas/zona-clinica';
import { enSegundoPlano } from '../../common/fiabilidad/en-segundo-plano';
import { AvisoLandingService } from '../../common/landing/aviso-landing.service';
import { urlPublica, validarImagenPublica } from '../../common/storage/imagen-publica';
import { R2Service } from '../../common/storage/r2.service';
import { aSlug } from '../../common/texto/slug';
import { esChoqueUnicoEn } from '../../prisma/choque-unico';
import { EstadoPromocion, FormatoBanner, Prisma, Promocion } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ActualizarPromocionDto,
  CrearPromocionDto,
  QueryAnunciosSinPromocionDto,
  QueryPromocionesDto,
  QueryPromocionesPublicasDto,
} from './dto/promocion.dto';
import {
  AccionPromocion,
  ACCIONES_PROMOCION,
  FORMATO_OBLIGATORIO,
  faltantesParaPublicar,
  generarCodigo,
  mensajeDeWhatsapp,
  problemaDeBanner,
  puedeEditar,
  TRANSICIONES,
  vigenciaDe,
} from './promocion-reglas';

/** Estados en los que el banner obligatorio no se puede quitar: alguien la está viendo o revisando. */
const ESTADOS_CON_BANNER_FIJO: readonly EstadoPromocion[] = ['EN_REVISION', 'PUBLICADA', 'PAUSADA'];

const INCLUIR_DETALLE = {
  especialidad: { select: { id: true, nombre: true, slug: true } },
  imagenes: { orderBy: { formato: 'asc' } },
  anuncios: { orderBy: { createdAt: 'asc' } },
  medicos: { select: { perfilMedico: { select: { id: true, nombrePublico: true, slug: true, publicado: true } } } },
  creadaPor: { select: { id: true, nombre: true } },
  revisadaPor: { select: { id: true, nombre: true } },
} satisfies Prisma.PromocionInclude;

type PromocionDetalle = Prisma.PromocionGetPayload<{ include: typeof INCLUIR_DETALLE }>;

const INCLUIR_PUBLICA = {
  especialidad: { select: { nombre: true, slug: true, activa: true } },
  imagenes: true,
  medicos: { select: { perfilMedico: { select: { nombrePublico: true, slug: true, publicado: true } } } },
} satisfies Prisma.PromocionInclude;

type PromocionPublicaFila = Prisma.PromocionGetPayload<{ include: typeof INCLUIR_PUBLICA }>;

interface AnuncioSinPromocion {
  anuncioId: string;
  leads: number;
  ultimoEn: Date;
  titular: string | null;
  imagenUrl: string | null;
}

const aNumero = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());

/**
 * Una promoción tal como la necesita el chat de WhatsApp: la tarjeta, el precio a
 * cobrar y su banner cuadrado. Solo de promociones visibles hoy.
 */
export interface PromocionChat {
  id: string;
  codigo: string;
  titulo: string;
  resumen: string;
  condiciones: string;
  etiquetaOferta: string | null;
  precioRegular: number | null;
  precioPromocional: number | null;
  /** Lo que se cobra: el promocional si hay, si no el regular. `null` = sin precio publicado: no se cobra por chat. */
  precio: number | null;
  vigenteHasta: string | null;
  /** URL pública del banner cuadrado (la que descarga Meta), o `null`. */
  bannerUrl: string | null;
}

/** Cuántas promociones caben en la lista del menú (10 filas de Meta). */
export const PROMOCIONES_EN_MENU = 10;

function fechaOFallar(texto: string, campo: string): Date {
  const fecha = fechaCivilDesdeTexto(texto);
  if (!fecha) throw new BadRequestException(`La fecha de ${campo} no existe.`);
  return fecha;
}

/**
 * Promociones: la agente las redacta con sus banners y precios, un ADMIN las
 * publica, y entonces las ven la landing y WhatsApp mientras estén vigentes.
 * Cada una sabe qué anuncios de Meta la publicitan, así que el CRM puede decir
 * de qué promoción viene una paciente y cuánto vendió.
 *
 * Único dueño de `Promocion`, `PromocionImagen`, `PromocionAnuncio` y
 * `PromocionMedico`. Lee `Lead` y `Venta` para atribuir, sin escribirlos.
 * Diseño: docs/promociones-y-directorio.md.
 */
@Injectable()
export class PromocionesService {
  private readonly logger = new Logger(PromocionesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
    private readonly audit: AuditService,
    private readonly landing: AvisoLandingService,
  ) {}

  /* ── Listado y detalle (CRM) ────────────────────────────────────────── */

  async listar(query: QueryPromocionesDto) {
    const hoy = fechaCivilClinica(new Date());
    const termino = query.buscar?.trim();
    /* Cada filtro es una condición más; van en un AND para que dos `OR` no se pisen. */
    const condiciones: Prisma.PromocionWhereInput[] = [];
    if (query.estado) condiciones.push({ estado: query.estado });
    if (query.especialidadId) condiciones.push({ especialidadId: query.especialidadId });
    if (termino) condiciones.push({ OR: [{ titulo: { contains: termino, mode: 'insensitive' } }, { codigo: termino.toUpperCase() }] });
    if (query.vigencia === 'VIGENTE') condiciones.push({ vigenteDesde: { lte: hoy } }, { OR: [{ vigenteHasta: null }, { vigenteHasta: { gte: hoy } }] });
    if (query.vigencia === 'PROXIMA') condiciones.push({ vigenteDesde: { gt: hoy } });
    if (query.vigencia === 'VENCIDA') condiciones.push({ vigenteHasta: { lt: hoy } });
    const where: Prisma.PromocionWhereInput = { AND: condiciones };
    const { skip, take } = calcularPaginacion(query);
    const [filas, total] = await this.prisma.$transaction([
      this.prisma.promocion.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
        include: {
          especialidad: { select: { id: true, nombre: true } },
          imagenes: { where: { formato: FORMATO_OBLIGATORIO }, select: { clave: true } },
          creadaPor: { select: { nombre: true } },
          _count: { select: { anuncios: true } },
        },
      }),
      this.prisma.promocion.count({ where }),
    ]);
    const datos = await Promise.all(
      filas.map(async p => ({
        id: p.id,
        codigo: p.codigo,
        titulo: p.titulo,
        resumen: p.resumen,
        estado: p.estado,
        vigencia: vigenciaDe(p.vigenteDesde, p.vigenteHasta, hoy),
        vigenteDesde: textoDeFechaCivil(p.vigenteDesde),
        vigenteHasta: p.vigenteHasta ? textoDeFechaCivil(p.vigenteHasta) : null,
        etiquetaOferta: p.etiquetaOferta,
        precioRegular: aNumero(p.precioRegular),
        precioPromocional: aNumero(p.precioPromocional),
        destacada: p.destacada,
        enLanding: p.enLanding,
        enWhatsapp: p.enWhatsapp,
        especialidad: p.especialidad,
        bannerUrl: p.imagenes[0] ? await this.r2.urlFirmada(p.imagenes[0].clave) : null,
        anuncios: p._count.anuncios,
        creadaPor: p.creadaPor?.nombre ?? null,
        updatedAt: p.updatedAt,
        version: p.version,
      })),
    );
    return paginar(datos, total, query);
  }

  async obtener(id: string, usuario: UsuarioJwt) {
    const p = await this.prisma.promocion.findUnique({ where: { id }, include: INCLUIR_DETALLE });
    if (!p) throw new NotFoundException('Esa promoción no existe.');
    return this.detalle(p, usuario);
  }

  /**
   * El detalle que pinta el CRM: todo, más lo que falta para publicarla, las
   * acciones que ESTA persona puede hacer y lo que trajo: leads (por sus anuncios
   * o por su código `PRM-…`), ventas de esos leads o de sus pagos por WhatsApp, y
   * los pagos en curso. Las cifras son atribución, no causalidad.
   */
  private async detalle(p: PromocionDetalle, usuario: UsuarioJwt) {
    const hoy = fechaCivilClinica(new Date());
    const esAdmin = cubreRol(usuario.rol, 'ADMIN');
    const anuncioIds = p.anuncios.map(a => a.anuncioId);
    const deLaPromocion: Prisma.LeadWhereInput = { OR: [{ promocionId: p.id }, ...(anuncioIds.length ? [{ anuncioId: { in: anuncioIds } }] : [])] };
    const [leads, ventas, pagos, imagenes] = await Promise.all([
      this.prisma.lead.count({ where: deLaPromocion }),
      this.prisma.venta.aggregate({
        where: { estado: 'GANADA', OR: [{ lead: deLaPromocion }, { pagoPromocion: { promocionId: p.id } }] },
        _count: true,
        _sum: { monto: true },
      }),
      this.prisma.pagoPromocion.groupBy({ by: ['estado'], where: { promocionId: p.id }, _count: true }),
      Promise.all(
        p.imagenes.map(async i => ({
          id: i.id,
          formato: i.formato,
          ancho: i.ancho,
          alto: i.alto,
          bytes: i.bytes,
          textoAlternativo: i.textoAlternativo,
          url: await this.r2.urlFirmada(i.clave),
          urlPublica: p.estado === 'PUBLICADA' ? urlPublica(`/publico/promociones/imagenes/${i.id}`) : null,
        })),
      ),
    ]);
    return {
      id: p.id,
      codigo: p.codigo,
      slug: p.slug,
      titulo: p.titulo,
      resumen: p.resumen,
      descripcion: p.descripcion,
      condiciones: p.condiciones,
      etiquetaOferta: p.etiquetaOferta,
      precioRegular: aNumero(p.precioRegular),
      precioPromocional: aNumero(p.precioPromocional),
      vigenteDesde: textoDeFechaCivil(p.vigenteDesde),
      vigenteHasta: p.vigenteHasta ? textoDeFechaCivil(p.vigenteHasta) : null,
      vigencia: vigenciaDe(p.vigenteDesde, p.vigenteHasta, hoy),
      estado: p.estado,
      destacada: p.destacada,
      enLanding: p.enLanding,
      enWhatsapp: p.enWhatsapp,
      especialidad: p.especialidad,
      medicos: p.medicos.map(m => m.perfilMedico),
      imagenes,
      anuncios: p.anuncios.map(a => ({ anuncioId: a.anuncioId, asignadoEn: a.createdAt })),
      creadaPor: p.creadaPor,
      revisadaPor: p.revisadaPor,
      publicadaEn: p.publicadaEn,
      motivoDevolucion: p.motivoDevolucion,
      version: p.version,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      mensajeWhatsapp: mensajeDeWhatsapp(p.titulo, p.codigo),
      faltantes: faltantesParaPublicar(this.paraPublicar(p, p.imagenes.map(i => i.formato)), hoy),
      puedeEditar: puedeEditar(p.estado, esAdmin),
      acciones: ACCIONES_PROMOCION.filter(a => {
        const t = TRANSICIONES[a];
        return (t.desde as readonly EstadoPromocion[]).includes(p.estado) && cubreRol(usuario.rol, t.rango);
      }),
      resultados: {
        leads,
        ventasGanadas: ventas._count,
        montoVendido: ventas._sum.monto?.toNumber() ?? 0,
        /* Pagos por WhatsApp: esperando comprobante y por verificar. */
        pagosPendientes: pagos.find(g => g.estado === 'PENDIENTE')?._count ?? 0,
        pagosPorVerificar: pagos.find(g => g.estado === 'COMPROBANTE_ENVIADO')?._count ?? 0,
      },
    };
  }

  /* ── Crear y editar ─────────────────────────────────────────────────── */

  async crear(dto: CrearPromocionDto, usuario: UsuarioJwt) {
    const desde = fechaOFallar(dto.vigenteDesde, 'inicio');
    const hasta = dto.vigenteHasta ? fechaOFallar(dto.vigenteHasta, 'fin') : null;
    this.validarCoherencia(dto.precioRegular ?? null, dto.precioPromocional ?? null, desde, hasta);
    await this.validarReferencias(dto.especialidadId ?? null, dto.medicoIds ?? []);

    const creada = await this.conCodigoLibre(codigo =>
      this.prisma.promocion.create({
        data: {
          codigo,
          slug: this.slugDe(dto.titulo, codigo),
          titulo: dto.titulo,
          resumen: dto.resumen,
          descripcion: dto.descripcion ?? '',
          condiciones: dto.condiciones ?? '',
          etiquetaOferta: dto.etiquetaOferta ?? null,
          precioRegular: dto.precioRegular ?? null,
          precioPromocional: dto.precioPromocional ?? null,
          vigenteDesde: desde,
          vigenteHasta: hasta,
          destacada: dto.destacada ?? false,
          enLanding: dto.enLanding ?? true,
          enWhatsapp: dto.enWhatsapp ?? true,
          especialidadId: dto.especialidadId ?? null,
          creadaPorId: usuario.sub,
          medicos: { create: (dto.medicoIds ?? []).map(perfilMedicoId => ({ perfilMedicoId })) },
        },
        select: { id: true, codigo: true },
      }),
    );
    await this.audit.registrar('Promocion', creada.id, 'PROMOCION_CREADA', usuario.sub, { codigo: creada.codigo, titulo: dto.titulo });
    return this.obtener(creada.id, usuario);
  }

  /**
   * Edición con bloqueo optimista y con permiso por estado: una agente edita
   * borradores; lo que está en revisión o publicado solo lo cambia un admin.
   * Si un admin edita una publicada, el resultado tiene que seguir siendo
   * publicable: no se deja una promoción a la vista con datos incompletos.
   */
  async actualizar(id: string, dto: ActualizarPromocionDto, usuario: UsuarioJwt) {
    const { version, medicoIds, vigenteDesde, vigenteHasta, ...campos } = dto;
    const esAdmin = cubreRol(usuario.rol, 'ADMIN');
    await this.validarReferencias(campos.especialidadId ?? null, medicoIds ?? []);

    const estado = await this.prisma.$transaction(async tx => {
      const actual = await this.bloquear(tx, id);
      if (actual.version !== version) throw new ConflictException('Otra persona guardó cambios en esta promoción. Recárgala y vuelve a intentarlo.');
      if (!puedeEditar(actual.estado, esAdmin)) {
        throw new ForbiddenException(
          actual.estado === 'ARCHIVADA' ? 'Una promoción archivada no se edita.' : 'Solo un administrador puede editar una promoción en revisión o publicada.',
        );
      }
      const desde = vigenteDesde !== undefined ? fechaOFallar(vigenteDesde, 'inicio') : actual.vigenteDesde;
      const hasta = vigenteHasta === undefined ? actual.vigenteHasta : vigenteHasta === null ? null : fechaOFallar(vigenteHasta, 'fin');
      const precioRegular = campos.precioRegular === undefined ? aNumero(actual.precioRegular) : campos.precioRegular;
      const precioPromocional = campos.precioPromocional === undefined ? aNumero(actual.precioPromocional) : campos.precioPromocional;
      this.validarCoherencia(precioRegular, precioPromocional, desde, hasta);

      /* El slug sigue al título solo mientras nunca se publicó: después, la landing ya lo enlaza. */
      const slug = campos.titulo && !actual.publicadaEn ? this.slugDe(campos.titulo, actual.codigo) : undefined;
      const nueva = await tx.promocion.update({
        where: { id },
        data: { ...campos, ...(slug ? { slug } : {}), vigenteDesde: desde, vigenteHasta: hasta, version: { increment: 1 } },
        include: { imagenes: { select: { formato: true } } },
      });
      if (medicoIds) {
        await tx.promocionMedico.deleteMany({ where: { promocionId: id } });
        await tx.promocionMedico.createMany({ data: medicoIds.map(perfilMedicoId => ({ promocionId: id, perfilMedicoId })) });
      }
      if (nueva.estado === 'PUBLICADA') {
        const faltan = faltantesParaPublicar(this.paraPublicar(nueva, nueva.imagenes.map(i => i.formato)), fechaCivilClinica(new Date()));
        if (faltan.length) throw new BadRequestException(faltan);
      }
      return nueva.estado;
    });
    await this.audit.registrar('Promocion', id, 'PROMOCION_EDITADA', usuario.sub, { campos: Object.keys(dto).filter(k => k !== 'version') });
    this.avisarSiSeVe(estado);
    return this.obtener(id, usuario);
  }

  /* ── Ciclo de vida ──────────────────────────────────────────────────── */

  /**
   * Una transición del ciclo de vida (`TRANSICIONES`). La fila se bloquea, se
   * comprueba el estado de partida y, para mandar a revisión o publicar, que no
   * falte nada; el cambio y su constancia en `AuditLog` van en la MISMA
   * transacción: un precio que llegó a pacientes siempre tiene quién lo aprobó.
   */
  async transicion(id: string, accion: AccionPromocion, usuario: UsuarioJwt, motivo?: string) {
    const regla = TRANSICIONES[accion];
    if (!cubreRol(usuario.rol, regla.rango)) throw new ForbiddenException('No tienes permiso para esa acción.');
    if (accion === 'devolver' && !motivo?.trim()) throw new BadRequestException('Di por qué la devuelves.');

    const desde = await this.prisma.$transaction(async tx => {
      const actual = await this.bloquear(tx, id);
      if (!(regla.desde as readonly EstadoPromocion[]).includes(actual.estado)) {
        throw new ConflictException(`No se puede ${accion} una promoción en estado ${actual.estado}.`);
      }
      if (accion === 'enviar' || accion === 'publicar') {
        const formatos = (await tx.promocionImagen.findMany({ where: { promocionId: id }, select: { formato: true } })).map(i => i.formato);
        const faltan = faltantesParaPublicar(this.paraPublicar(actual, formatos), fechaCivilClinica(new Date()));
        if (faltan.length) throw new BadRequestException(faltan);
      }
      const ahora = new Date();
      await tx.promocion.update({
        where: { id },
        data: {
          estado: regla.hacia,
          version: { increment: 1 },
          ...(accion === 'enviar' ? { motivoDevolucion: null } : {}),
          ...(accion === 'devolver' ? { motivoDevolucion: motivo!.trim(), revisadaPorId: usuario.sub } : {}),
          ...(accion === 'publicar' ? { revisadaPorId: usuario.sub, motivoDevolucion: null, publicadaEn: actual.publicadaEn ?? ahora } : {}),
        },
      });
      await tx.auditLog.create({
        data: {
          entidad: 'Promocion',
          entidadId: id,
          accion: `PROMOCION_${accion.toUpperCase()}`,
          usuarioId: usuario.sub,
          cambios: { desde: actual.estado, hacia: regla.hacia, ...(motivo ? { motivo: motivo.trim() } : {}) },
        },
      });
      return actual.estado;
    });
    // Entra o sale de la landing: publicar, pausar o archivar una publicada.
    this.avisarSiSeVe(desde, regla.hacia);
    return this.obtener(id, usuario);
  }

  /* ── Banners ────────────────────────────────────────────────────────── */

  /**
   * Sube (o reemplaza) el banner de un formato. Se valida por sus bytes y por
   * la proporción del formato, va a R2 con un id nuevo —su URL pública es
   * inmutable— y el anterior se borra de R2 DESPUÉS de guardar el nuevo.
   */
  async subirBanner(id: string, formato: FormatoBanner, archivo: ArchivoSubido | undefined, textoAlternativo: string, usuario: UsuarioJwt) {
    if (!archivo) throw new BadRequestException('Falta la imagen.');
    const imagen = validarImagenPublica(archivo.buffer);
    if ('error' in imagen) throw new BadRequestException(imagen.error);
    const problema = problemaDeBanner(formato, imagen.ancho, imagen.alto);
    if (problema) throw new BadRequestException(problema);
    if (!this.r2.habilitado) throw new ServiceUnavailableException('El almacenamiento de imágenes no está configurado.');
    await this.exigirEditable(id, usuario);

    const imagenId = randomUUID();
    const clave = `promociones/${id}/${imagenId}.${imagen.extension}`;
    await this.r2.subir(clave, new Uint8Array(archivo.buffer).slice().buffer, imagen.mime);
    let anterior: string | null = null;
    let estado: EstadoPromocion;
    try {
      estado = await this.prisma.$transaction(async tx => {
        const actual = await this.bloquear(tx, id);
        if (!puedeEditar(actual.estado, cubreRol(usuario.rol, 'ADMIN'))) throw new ForbiddenException('Esta promoción ya no se puede editar.');
        const previa = await tx.promocionImagen.findUnique({ where: { promocionId_formato: { promocionId: id, formato } }, select: { id: true, clave: true } });
        if (previa) {
          await tx.promocionImagen.delete({ where: { id: previa.id } });
          anterior = previa.clave;
        }
        await tx.promocionImagen.create({
          data: { id: imagenId, promocionId: id, formato, clave, mime: imagen.mime, ancho: imagen.ancho, alto: imagen.alto, bytes: imagen.bytes, textoAlternativo },
        });
        await tx.promocion.update({ where: { id }, data: { version: { increment: 1 } } });
        return actual.estado;
      });
    } catch (error) {
      /* La fila no se guardó: el archivo recién subido no lo cita nadie. */
      this.borrarDeR2(clave);
      throw error;
    }
    if (anterior) this.borrarDeR2(anterior);
    await this.audit.registrar('Promocion', id, 'BANNER_SUBIDO', usuario.sub, { formato, ancho: imagen.ancho, alto: imagen.alto });
    this.avisarSiSeVe(estado);
    return this.obtener(id, usuario);
  }

  async quitarBanner(id: string, formato: FormatoBanner, usuario: UsuarioJwt) {
    let clave: string | null = null;
    const estado = await this.prisma.$transaction(async tx => {
      const actual = await this.bloquear(tx, id);
      if (!puedeEditar(actual.estado, cubreRol(usuario.rol, 'ADMIN'))) throw new ForbiddenException('Esta promoción ya no se puede editar.');
      if (formato === FORMATO_OBLIGATORIO && ESTADOS_CON_BANNER_FIJO.includes(actual.estado)) {
        throw new BadRequestException('El banner cuadrado es obligatorio: reemplázalo en vez de quitarlo.');
      }
      const previa = await tx.promocionImagen.findUnique({ where: { promocionId_formato: { promocionId: id, formato } }, select: { id: true, clave: true } });
      if (!previa) throw new NotFoundException('Esa promoción no tiene banner en ese formato.');
      await tx.promocionImagen.delete({ where: { id: previa.id } });
      await tx.promocion.update({ where: { id }, data: { version: { increment: 1 } } });
      clave = previa.clave;
      return actual.estado;
    });
    if (clave) this.borrarDeR2(clave);
    await this.audit.registrar('Promocion', id, 'BANNER_QUITADO', usuario.sub, { formato });
    this.avisarSiSeVe(estado);
    return this.obtener(id, usuario);
  }

  /* ── Anuncios de Meta y atribución ──────────────────────────────────── */

  /**
   * Enlaza un anuncio de Meta a la promoción. Un anuncio publicita UNA
   * promoción: si ya es de otra, 409 con su nombre. Repetirlo es inocuo.
   */
  async asignarAnuncio(id: string, anuncioId: string, usuario: UsuarioJwt) {
    const promocion = await this.prisma.promocion.findUnique({ where: { id }, select: { estado: true } });
    if (!promocion) throw new NotFoundException('Esa promoción no existe.');
    if (promocion.estado === 'ARCHIVADA') throw new BadRequestException('Una promoción archivada no recibe anuncios.');
    try {
      await this.prisma.promocionAnuncio.create({ data: { anuncioId, promocionId: id } });
    } catch (error) {
      if (!esChoqueUnicoEn(error, 'PromocionAnuncio', 'anuncioId') && !esChoqueUnicoEn(error, 'PromocionAnuncio', 'pkey')) throw error;
      const duena = await this.prisma.promocionAnuncio.findUnique({ where: { anuncioId }, select: { promocionId: true, promocion: { select: { titulo: true } } } });
      if (duena && duena.promocionId !== id) throw new ConflictException(`Ese anuncio ya está enlazado a «${duena.promocion.titulo}».`);
    }
    await this.audit.registrar('Promocion', id, 'ANUNCIO_ASIGNADO', usuario.sub, { anuncioId });
    return this.obtener(id, usuario);
  }

  async quitarAnuncio(id: string, anuncioId: string, usuario: UsuarioJwt) {
    const { count } = await this.prisma.promocionAnuncio.deleteMany({ where: { anuncioId, promocionId: id } });
    if (!count) throw new NotFoundException('Ese anuncio no está enlazado a esta promoción.');
    await this.audit.registrar('Promocion', id, 'ANUNCIO_QUITADO', usuario.sub, { anuncioId });
    return this.obtener(id, usuario);
  }

  /**
   * Anuncios que ya trajeron pacientes (`Lead.anuncioId`) y no están enlazados
   * a ninguna promoción, con su titular e imagen tal como llegaron en el
   * referral (`Cliente.datosExtra.campanaOrigen`). Es la lista de «¿esto qué
   * promoción es?» que completa la agente. Lee Leads y Clientes; no los escribe.
   */
  async anunciosSinPromocion(query: QueryAnunciosSinPromocionDto) {
    const { skip, take } = calcularPaginacion(query);
    const [filas, [{ total }]] = await Promise.all([
      this.prisma.$queryRaw<AnuncioSinPromocion[]>`
        SELECT l."anuncioId",
               count(*)::int AS leads,
               max(l."createdAt") AS "ultimoEn",
               (array_agg(c."datosExtra"->'campanaOrigen'->>'titular' ORDER BY l."createdAt" DESC)
                  FILTER (WHERE c."datosExtra"->'campanaOrigen'->>'anuncioId' = l."anuncioId"))[1] AS titular,
               (array_agg(c."datosExtra"->'campanaOrigen'->>'imagenUrl' ORDER BY l."createdAt" DESC)
                  FILTER (WHERE c."datosExtra"->'campanaOrigen'->>'anuncioId' = l."anuncioId"))[1] AS "imagenUrl"
        FROM "Lead" l
        JOIN "Cliente" c ON c.id = l."clienteId"
        LEFT JOIN "PromocionAnuncio" pa ON pa."anuncioId" = l."anuncioId"
        WHERE l."anuncioId" IS NOT NULL AND pa."anuncioId" IS NULL
        GROUP BY l."anuncioId"
        ORDER BY "ultimoEn" DESC, l."anuncioId"
        LIMIT ${take} OFFSET ${skip}`,
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT count(DISTINCT l."anuncioId")::int AS total
        FROM "Lead" l
        LEFT JOIN "PromocionAnuncio" pa ON pa."anuncioId" = l."anuncioId"
        WHERE l."anuncioId" IS NOT NULL AND pa."anuncioId" IS NULL`,
    ]);
    return paginar(filas, total, query);
  }

  /**
   * ¿De qué promoción viene alguien que llegó por este anuncio? Lo pide el chat
   * para decir «vino por la promo X, Bs Y, vigente hasta Z». `null` si el
   * anuncio no está enlazado.
   */
  async atribucion(anuncioId: string) {
    const enlace = await this.prisma.promocionAnuncio.findUnique({
      where: { anuncioId },
      select: { promocion: { select: { id: true, codigo: true, titulo: true, resumen: true, estado: true, etiquetaOferta: true, precioRegular: true, precioPromocional: true, vigenteDesde: true, vigenteHasta: true, condiciones: true } } },
    });
    if (!enlace) return { promocion: null };
    const p = enlace.promocion;
    return {
      promocion: {
        id: p.id,
        codigo: p.codigo,
        titulo: p.titulo,
        resumen: p.resumen,
        estado: p.estado,
        etiquetaOferta: p.etiquetaOferta,
        precioRegular: aNumero(p.precioRegular),
        precioPromocional: aNumero(p.precioPromocional),
        vigenteDesde: textoDeFechaCivil(p.vigenteDesde),
        vigenteHasta: p.vigenteHasta ? textoDeFechaCivil(p.vigenteHasta) : null,
        vigencia: vigenciaDe(p.vigenteDesde, p.vigenteHasta, fechaCivilClinica(new Date())),
        condiciones: p.condiciones,
      },
    };
  }

  /* ── Chat de WhatsApp ───────────────────────────────────────────────── */

  /** Los anuncios de Meta que la publicitan: para atribuir la venta de un pago al lead correcto. */
  async anunciosDe(promocionId: string): Promise<string[]> {
    const filas = await this.prisma.promocionAnuncio.findMany({ where: { promocionId }, select: { anuncioId: true } });
    return filas.map(f => f.anuncioId);
  }

  /**
   * La promoción de un código `PRM-…`, si está visible hoy en algún canal: el
   * código llega desde la landing, así que basta con que esté publicada y vigente.
   */
  async paraChatPorCodigo(codigo: string): Promise<PromocionChat | null> {
    const p = await this.prisma.promocion.findFirst({ where: { codigo, ...this.whereVisible() }, include: { imagenes: { where: { formato: FORMATO_OBLIGATORIO } } } });
    return p ? this.paraChat(p) : null;
  }

  /** Por id, con la misma condición: lo que se le cobra tiene que seguir visible al pedir el QR. */
  async paraChatPorId(id: string): Promise<PromocionChat | null> {
    const p = await this.prisma.promocion.findFirst({ where: { id, ...this.whereVisible() }, include: { imagenes: { where: { formato: FORMATO_OBLIGATORIO } } } });
    return p ? this.paraChat(p) : null;
  }

  async hayParaMenuWhatsapp(): Promise<boolean> {
    return Boolean(await this.prisma.promocion.findFirst({ where: this.wherePublica('whatsapp'), select: { id: true } }));
  }

  /** Las que se ofrecen por WhatsApp hoy, en el orden de la landing, para la lista del menú. */
  async paraMenuWhatsapp(): Promise<PromocionChat[]> {
    const filas = await this.prisma.promocion.findMany({
      where: this.wherePublica('whatsapp'),
      orderBy: [{ destacada: 'desc' }, { vigenteHasta: { sort: 'asc', nulls: 'last' } }, { publicadaEn: 'desc' }, { id: 'asc' }],
      take: PROMOCIONES_EN_MENU,
      include: { imagenes: { where: { formato: FORMATO_OBLIGATORIO } } },
    });
    return filas.map(f => this.paraChat(f));
  }

  private paraChat(p: Promocion & { imagenes: { id: string }[] }): PromocionChat {
    const precioRegular = aNumero(p.precioRegular);
    const precioPromocional = aNumero(p.precioPromocional);
    const banner = p.imagenes[0];
    return {
      id: p.id,
      codigo: p.codigo,
      titulo: p.titulo,
      resumen: p.resumen,
      condiciones: p.condiciones,
      etiquetaOferta: p.etiquetaOferta,
      precioRegular,
      precioPromocional,
      precio: precioPromocional ?? precioRegular,
      vigenteHasta: p.vigenteHasta ? textoDeFechaCivil(p.vigenteHasta) : null,
      bannerUrl: banner ? urlPublica(`/publico/promociones/imagenes/${banner.id}`) : null,
    };
  }

  /* ── Público (landing, y más adelante el menú de WhatsApp) ──────────── */

  /** Publicada y vigente hoy en La Paz. La única definición de «visible». */
  private whereVisible(): Prisma.PromocionWhereInput {
    const hoy = fechaCivilClinica(new Date());
    return { estado: 'PUBLICADA', vigenteDesde: { lte: hoy }, OR: [{ vigenteHasta: null }, { vigenteHasta: { gte: hoy } }] };
  }

  /** Visible y ofrecida en ese canal. */
  private wherePublica(canal: 'landing' | 'whatsapp'): Prisma.PromocionWhereInput {
    return { ...this.whereVisible(), ...(canal === 'landing' ? { enLanding: true } : { enWhatsapp: true }) };
  }

  async listarPublicas(query: QueryPromocionesPublicasDto) {
    const where: Prisma.PromocionWhereInput = {
      ...this.wherePublica(query.canal ?? 'landing'),
      ...(query.especialidad ? { especialidad: { slug: query.especialidad, activa: true } } : {}),
    };
    const { skip, take } = calcularPaginacion(query);
    const [filas, total] = await this.prisma.$transaction([
      this.prisma.promocion.findMany({
        where,
        orderBy: [{ destacada: 'desc' }, { vigenteHasta: { sort: 'asc', nulls: 'last' } }, { publicadaEn: 'desc' }, { id: 'asc' }],
        skip,
        take,
        include: INCLUIR_PUBLICA,
      }),
      this.prisma.promocion.count({ where }),
    ]);
    return paginar(filas.map(f => this.publica(f)), total, query);
  }

  async publicaPorSlug(slug: string) {
    /* Basta que sea visible en algún canal: un enlace compartido por WhatsApp abre su página. */
    const p = await this.prisma.promocion.findFirst({ where: { slug, ...this.whereVisible() }, include: INCLUIR_PUBLICA });
    if (!p) throw new NotFoundException('Esa promoción no está disponible.');
    return this.publica(p);
  }

  /**
   * El banner de una promoción visible hoy. Una en borrador o vencida no se
   * sirve aunque alguien conozca el id: un precio sin aprobar no sale de aquí.
   */
  async imagenPublica(imagenId: string): Promise<StreamableFile> {
    const imagen = await this.prisma.promocionImagen.findFirst({
      where: { id: imagenId, promocion: this.whereVisible() },
      select: { clave: true, mime: true, bytes: true },
    });
    if (!imagen) throw new NotFoundException('Esa imagen no está disponible.');
    const objeto = await this.r2.leer(imagen.clave);
    if (!objeto) throw new NotFoundException('Esa imagen no está disponible.');
    return new StreamableFile(Readable.fromWeb(objeto.cuerpo as ReadableStreamWeb<Uint8Array>), { type: imagen.mime, length: objeto.bytes ?? imagen.bytes });
  }

  /** Lo que se publica. Nada interno: ni versión, ni quién la creó, ni sus anuncios, ni resultados. */
  private publica(p: PromocionPublicaFila) {
    const banners: Partial<Record<FormatoBanner, { url: string; ancho: number; alto: number; alt: string }>> = {};
    for (const i of p.imagenes) {
      banners[i.formato] = { url: urlPublica(`/publico/promociones/imagenes/${i.id}`), ancho: i.ancho, alto: i.alto, alt: i.textoAlternativo };
    }
    return {
      slug: p.slug,
      codigo: p.codigo,
      titulo: p.titulo,
      resumen: p.resumen,
      descripcion: p.descripcion,
      condiciones: p.condiciones,
      etiquetaOferta: p.etiquetaOferta,
      precioRegular: aNumero(p.precioRegular),
      precioPromocional: aNumero(p.precioPromocional),
      moneda: 'BOB' as const,
      vigenteDesde: textoDeFechaCivil(p.vigenteDesde),
      vigenteHasta: p.vigenteHasta ? textoDeFechaCivil(p.vigenteHasta) : null,
      destacada: p.destacada,
      especialidad: p.especialidad?.activa ? { slug: p.especialidad.slug, nombre: p.especialidad.nombre } : null,
      medicos: p.medicos.filter(m => m.perfilMedico.publicado).map(m => ({ slug: m.perfilMedico.slug, nombre: m.perfilMedico.nombrePublico })),
      banners,
      mensajeWhatsapp: mensajeDeWhatsapp(p.titulo, p.codigo),
    };
  }

  /* ── Internos ───────────────────────────────────────────────────────── */

  /**
   * Avisa a la landing si el cambio toca algo que ve el público: solo lo
   * PUBLICADO sale en la API pública. Editar un borrador no la molesta.
   */
  private avisarSiSeVe(...estados: EstadoPromocion[]) {
    if (estados.includes('PUBLICADA')) this.landing.avisar('promociones');
  }

  /** La fila bloqueada hasta el final de la transacción, para decidir sobre su estado sin carreras. */
  private async bloquear(tx: Prisma.TransactionClient, id: string) {
    const [fila] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Promocion" WHERE id = ${id} FOR NO KEY UPDATE`;
    if (!fila) throw new NotFoundException('Esa promoción no existe.');
    return tx.promocion.findUniqueOrThrow({ where: { id } });
  }

  private async exigirEditable(id: string, usuario: UsuarioJwt) {
    const p = await this.prisma.promocion.findUnique({ where: { id }, select: { estado: true } });
    if (!p) throw new NotFoundException('Esa promoción no existe.');
    if (!puedeEditar(p.estado, cubreRol(usuario.rol, 'ADMIN'))) {
      throw new ForbiddenException('Solo un administrador puede editar una promoción en revisión o publicada.');
    }
  }

  private paraPublicar(
    p: Pick<Promocion, 'titulo' | 'resumen' | 'condiciones' | 'etiquetaOferta' | 'precioRegular' | 'precioPromocional' | 'vigenteDesde' | 'vigenteHasta' | 'enLanding' | 'enWhatsapp'>,
    formatos: readonly FormatoBanner[],
  ) {
    return {
      titulo: p.titulo,
      resumen: p.resumen,
      condiciones: p.condiciones,
      etiquetaOferta: p.etiquetaOferta,
      precioRegular: aNumero(p.precioRegular),
      precioPromocional: aNumero(p.precioPromocional),
      vigenteDesde: p.vigenteDesde,
      vigenteHasta: p.vigenteHasta,
      enLanding: p.enLanding,
      enWhatsapp: p.enWhatsapp,
      formatos,
    };
  }

  /** Lo que la base también rechazaría (CHECK), dicho antes y en castellano. */
  private validarCoherencia(precioRegular: number | null, precioPromocional: number | null, desde: Date, hasta: Date | null) {
    if (precioRegular !== null && precioPromocional !== null && precioPromocional >= precioRegular) {
      throw new BadRequestException('El precio promocional tiene que ser menor que el regular.');
    }
    if (hasta && hasta < desde) throw new BadRequestException('La vigencia termina antes de empezar.');
  }

  private async validarReferencias(especialidadId: string | null, medicoIds: readonly string[]) {
    if (especialidadId) {
      const e = await this.prisma.especialidad.findFirst({ where: { id: especialidadId, activa: true }, select: { id: true } });
      if (!e) throw new BadRequestException('Esa especialidad no existe o está inactiva.');
    }
    if (medicoIds.length) {
      const n = await this.prisma.perfilMedico.count({ where: { id: { in: [...medicoIds] } } });
      if (n !== medicoIds.length) throw new BadRequestException('Algún médico elegido no tiene ficha en el directorio.');
    }
  }

  private slugDe(titulo: string, codigo: string): string {
    return `${aSlug(titulo, 72)}-${codigo.slice(4).toLowerCase()}`;
  }

  /** Crea con un código nuevo; si choca (1 entre 28 millones), prueba otro. */
  private async conCodigoLibre<T>(crear: (codigo: string) => Promise<T>): Promise<T> {
    for (let intento = 0; intento < 5; intento++) {
      try {
        return await crear(generarCodigo());
      } catch (error) {
        if (!esChoqueUnicoEn(error, 'Promocion', 'codigo') && !esChoqueUnicoEn(error, 'Promocion', 'slug')) throw error;
      }
    }
    throw new ConflictException('No se pudo generar un código libre; vuelve a intentarlo.');
  }

  private borrarDeR2(clave: string) {
    void enSegundoPlano(`borrar ${clave} de R2`, this.logger, () => this.r2.eliminar(clave));
  }
}
