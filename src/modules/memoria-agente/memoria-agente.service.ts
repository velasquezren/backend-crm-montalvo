import { ArchivoSubido } from './archivo-subido';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TipoRecursoMemoria } from '../../prisma/prisma-client';
import { terminoBusqueda } from '../../common/dto/busqueda';
import { calcularPaginacion, paginar } from '../../common/dto/pagination.dto';
import { R2Service } from '../../common/storage/r2.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateRecursoMemoriaDto } from './dto/create-recurso-memoria.dto';
import { QueryRecursoMemoriaDto } from './dto/query-recurso-memoria.dto';
import { UpdateRecursoMemoriaDto } from './dto/update-recurso-memoria.dto';

const CUOTA_MAXIMA_BYTES = 30 * 1024 * 1024; // 30 MB por agente
const TAMANO_MAXIMO_ARCHIVO = 5 * 1024 * 1024; // 5 MB por archivo individual

const MIME_WHITELIST = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  /* Notas de voz del chat. Este endpoint es también el que sube los adjuntos de
     Conversaciones, y `MediaRecorder` no entrega el mismo contenedor en todas
     partes: ogg/opus en Chrome y Firefox, webm/opus donde no hay ogg, y mp4 en
     Safari —que es el navegador de las agentes con iPhone—. Sin los cuatro, la
     grabadora sube y el servidor la rechaza. */
  'audio/ogg',
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
];

/**
 * `audio/ogg;codecs=opus` y `audio/ogg` son el mismo tipo.
 *
 * `MediaRecorder` añade el parámetro del códec al MIME y multer lo repite tal
 * cual, así que comparar la cadena entera contra la lista blanca deja fuera
 * toda nota de voz aunque su tipo esté permitido.
 */
function tipoBase(mime: string): string {
  return mime.split(';')[0].trim().toLowerCase();
}

@Injectable()
export class MemoriaAgenteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
  ) {}

  /**
   * Consulta el uso de espacio actual del agente autenticado (0 a 30 MB).
   */
  async consultarCuota(usuarioId: string) {
    const [agregado, count] = await this.prisma.$transaction([
      this.prisma.recursoMemoriaAgente.aggregate({
        where: { usuarioId },
        _sum: { pesoBytes: true },
      }),
      this.prisma.recursoMemoriaAgente.count({ where: { usuarioId } }),
    ]);

    const bytesUsados = agregado._sum.pesoBytes ?? 0;
    const porcentajeUsado = Math.min(100, Number(((bytesUsados / CUOTA_MAXIMA_BYTES) * 100).toFixed(2)));
    const megabytesUsados = Number((bytesUsados / (1024 * 1024)).toFixed(2));
    const megabytesMaximos = 30;

    return {
      bytesUsados,
      megabytesUsados,
      megabytesMaximos,
      porcentajeUsado,
      recursosCount: count,
    };
  }

  async findAll(usuarioId: string, query: QueryRecursoMemoriaDto) {
    const where: Prisma.RecursoMemoriaAgenteWhereInput = {
      usuarioId,
      tipo: query.tipo,
      categoria: query.categoria,
      /* Los tres `contains` van escapados porque acaban en un LIKE; el `has`
         NO, porque es contención sobre el array de tags y ahí `%` es un
         carácter más. Escaparlo haría que un tag con `%` dejara de encontrarse. */
      ...(query.busqueda?.trim()
        ? {
            OR: [
              { titulo: { contains: terminoBusqueda(query.busqueda), mode: 'insensitive' } },
              { contenido: { contains: terminoBusqueda(query.busqueda), mode: 'insensitive' } },
              { atajo: { contains: terminoBusqueda(query.busqueda), mode: 'insensitive' } },
              { tags: { has: query.busqueda.trim().toLowerCase() } },
            ],
          }
        : {}),
    };

    const { skip, take } = calcularPaginacion(query);

    const [datos, total] = await this.prisma.$transaction([
      this.prisma.recursoMemoriaAgente.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.recursoMemoriaAgente.count({ where }),
    ]);

    /* Genera URLs firmadas de R2 (15 min) para recursos binarios en paralelo */
    const datosConMediaUrl = await Promise.all(
      datos.map(async item => ({
        ...item,
        mediaUrl: item.mediaKey ? await this.r2.urlFirmada(item.mediaKey) : null,
      })),
    );

    return paginar(datosConMediaUrl, total, query);
  }

  /**
   * Crea un recurso tipo TEXTO o ENLACE (sin binario).
   */
  async create(usuarioId: string, dto: CreateRecursoMemoriaDto) {
    const atajoLimpio = dto.atajo
      ? dto.atajo.startsWith('/')
        ? dto.atajo.trim()
        : `/${dto.atajo.trim()}`
      : null;

    return this.prisma.recursoMemoriaAgente.create({
      data: {
        usuarioId,
        titulo: dto.titulo.trim(),
        contenido: dto.contenido?.trim() ?? null,
        tipo: dto.tipo ?? 'TEXTO',
        categoria: dto.categoria ?? 'GENERAL',
        atajo: atajoLimpio,
        tags: dto.tags ?? [],
      },
    });
  }

  /**
   * Sube un archivo binario (Imagen / PDF / Banner) a R2 con control estricto de cuota (30 MB).
   */
  async subirBinario(
    usuarioId: string,
    dto: CreateRecursoMemoriaDto,
    file?: ArchivoSubido,
  ) {
    if (!file) {
      throw new BadRequestException('Se requiere adjuntar un archivo para recursos multimedia');
    }

    if (file.size > TAMANO_MAXIMO_ARCHIVO) {
      throw new BadRequestException('El archivo excede el tamaño máximo permitido por recurso (5 MB).');
    }

    if (!MIME_WHITELIST.includes(tipoBase(file.mimetype))) {
      throw new BadRequestException(
        `Tipo de archivo no permitido (${file.mimetype}). Se aceptan imágenes, PDF, Word y notas de voz.`,
      );
    }

    /* Validar cuota acumulada del agente antes de guardar */
    const cuota = await this.consultarCuota(usuarioId);
    if (cuota.bytesUsados + file.size > CUOTA_MAXIMA_BYTES) {
      throw new BadRequestException(
        `Capacidad de memoria agotada (${cuota.megabytesUsados} MB / 30 MB). Elimina algunos recursos para liberar espacio.`,
      );
    }

    const extension = file.originalname.split('.').pop() ?? 'bin';
    const idTemp = `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const mediaKey = `memoria/${usuarioId}/${idTemp}.${extension}`;

    /* Subir binario a Cloudflare R2 */
    const ab = file.buffer.buffer.slice(
      file.buffer.byteOffset,
      file.buffer.byteOffset + file.buffer.byteLength,
    ) as ArrayBuffer;
    await this.r2.subir(mediaKey, ab, file.mimetype);

    const tipoInferido: TipoRecursoMemoria = file.mimetype.startsWith('image/') ? 'IMAGEN' : 'DOCUMENTO';

    const atajoLimpio = dto.atajo
      ? dto.atajo.startsWith('/')
        ? dto.atajo.trim()
        : `/${dto.atajo.trim()}`
      : null;

    const creado = await this.prisma.recursoMemoriaAgente.create({
      data: {
        usuarioId,
        titulo: dto.titulo?.trim() || file.originalname,
        contenido: dto.contenido?.trim() ?? null,
        tipo: dto.tipo ?? tipoInferido,
        categoria: dto.categoria ?? 'GENERAL',
        atajo: atajoLimpio,
        mediaKey,
        mediaMime: file.mimetype,
        mediaNombre: file.originalname,
        pesoBytes: file.size,
        tags: dto.tags ?? [],
      },
    });

    const mediaUrl = await this.r2.urlFirmada(creado.mediaKey!);
    return { ...creado, mediaUrl };
  }

  async update(id: string, usuarioId: string, dto: UpdateRecursoMemoriaDto) {
    const existe = await this.prisma.recursoMemoriaAgente.findFirst({
      where: { id, usuarioId },
    });
    if (!existe) {
      throw new NotFoundException(`Recurso ${id} no encontrado`);
    }

    const atajoLimpio =
      dto.atajo !== undefined
        ? dto.atajo
          ? dto.atajo.startsWith('/')
            ? dto.atajo.trim()
            : `/${dto.atajo.trim()}`
          : null
        : undefined;

    return this.prisma.recursoMemoriaAgente.update({
      where: { id },
      data: {
        titulo: dto.titulo?.trim(),
        contenido: dto.contenido?.trim(),
        tipo: dto.tipo,
        categoria: dto.categoria,
        atajo: atajoLimpio,
        tags: dto.tags,
      },
    });
  }

  async remove(id: string, usuarioId: string) {
    const existe = await this.prisma.recursoMemoriaAgente.findFirst({
      where: { id, usuarioId },
    });
    if (!existe) {
      throw new NotFoundException(`Recurso ${id} no encontrado`);
    }

    if (existe.mediaKey) {
      try {
        await this.r2.eliminar(existe.mediaKey);
      } catch (err) {
        // ignora si el archivo en R2 ya fue removido
      }
    }

    await this.prisma.recursoMemoriaAgente.delete({ where: { id } });
    return { ok: true, id };
  }
}
