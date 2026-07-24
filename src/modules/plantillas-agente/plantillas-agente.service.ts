import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreatePlantillaAgenteDto } from './dto/create-plantilla-agente.dto';
import { UpdatePlantillaAgenteDto } from './dto/update-plantilla-agente.dto';

const PLANTILLAS_DEFECTO = [
  {
    titulo: 'Agendamiento y Horarios',
    atajo: '/horarios',
    contenido:
      'Estimado/a paciente, la atención médica se realiza de lunes a sábado de 08:00 a 19:00 hrs. ¿En qué fecha o especialidad requiere su consulta?',
    tags: ['horarios', 'agendamiento'],
  },
  {
    titulo: 'Información de Servicios',
    atajo: '/servicios',
    contenido:
      'Con gusto le brindamos información detallada sobre nuestras especialidades y tratamientos médicos. ¿Qué consulta o procedimiento necesita coordinar?',
    tags: ['servicios', 'informacion'],
  },
  {
    titulo: 'Ubicación y Accesos',
    atajo: '/ubicacion',
    contenido:
      'Nuestras instalaciones principales se encuentran en Clínica Montalvo. Disponemos de estacionamiento privado para la comodidad de nuestros pacientes.',
    tags: ['ubicacion', 'estacionamiento'],
  },
  {
    titulo: 'Indicaciones de Cita',
    atajo: '/cita',
    contenido:
      'Le sugerimos acudir con 10 minutos de anticipación a su consulta agendada, portando su documento de identidad.',
    tags: ['indicaciones', 'confirmacion'],
  },
];

@Injectable()
export class PlantillasAgenteService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Obtiene las plantillas personalizadas del agente.
   * Si el agente no tiene ninguna guardada todavía, siembra las plantillas por defecto del sistema.
   */
  async findAll(usuarioId: string) {
    let plantillas = await this.prisma.plantillaAgente.findMany({
      where: { usuarioId },
      orderBy: { createdAt: 'desc' },
    });

    if (plantillas.length === 0) {
      await this.prisma.plantillaAgente.createMany({
        data: PLANTILLAS_DEFECTO.map(p => ({ ...p, usuarioId })),
      });
      plantillas = await this.prisma.plantillaAgente.findMany({
        where: { usuarioId },
        orderBy: { createdAt: 'desc' },
      });
    }

    return plantillas;
  }

  async create(usuarioId: string, dto: CreatePlantillaAgenteDto) {
    const atajoLimpio = dto.atajo
      ? dto.atajo.startsWith('/')
        ? dto.atajo.trim()
        : `/${dto.atajo.trim()}`
      : null;

    return this.prisma.plantillaAgente.create({
      data: {
        usuarioId,
        titulo: dto.titulo.trim(),
        atajo: atajoLimpio,
        contenido: dto.contenido.trim(),
        tags: dto.tags ?? [],
      },
    });
  }

  async update(id: string, usuarioId: string, dto: UpdatePlantillaAgenteDto) {
    const existe = await this.prisma.plantillaAgente.findFirst({
      where: { id, usuarioId },
    });
    if (!existe) {
      throw new NotFoundException(`Plantilla ${id} no encontrada o no pertenece al usuario`);
    }

    const atajoLimpio =
      dto.atajo !== undefined
        ? dto.atajo
          ? dto.atajo.startsWith('/')
            ? dto.atajo.trim()
            : `/${dto.atajo.trim()}`
          : null
        : undefined;

    return this.prisma.plantillaAgente.update({
      where: { id },
      data: {
        titulo: dto.titulo?.trim(),
        atajo: atajoLimpio,
        contenido: dto.contenido?.trim(),
        tags: dto.tags,
      },
    });
  }

  async remove(id: string, usuarioId: string) {
    const existe = await this.prisma.plantillaAgente.findFirst({
      where: { id, usuarioId },
    });
    if (!existe) {
      throw new NotFoundException(`Plantilla ${id} no encontrada o no pertenece al usuario`);
    }

    await this.prisma.plantillaAgente.delete({ where: { id } });
    return { ok: true, id };
  }
}
