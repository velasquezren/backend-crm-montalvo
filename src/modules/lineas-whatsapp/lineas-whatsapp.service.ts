import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { tieneAlcanceGlobal } from "../../common/auth/roles";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../prisma/prisma.service";
import { Prisma, LineaWhatsapp } from "../../prisma/prisma-client";
import {
  calcularPaginacion,
  paginar,
  PaginationDto,
} from "../../common/dto/pagination.dto";
import { CredencialesWhatsapp } from "../../common/whatsapp/whatsapp-cloud.service";
import {
  LINEA_COMERCIAL_INICIAL,
  SELECT_LINEA,
} from "../conversaciones/acceso-conversacion";
import { ActualizarLineaDto } from "./dto/actualizar-linea.dto";

@Injectable()
export class LineasWhatsappService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async listar(
    query: PaginationDto,
    usuarioId?: string,
    administracion = false,
  ) {
    const where: Prisma.LineaWhatsappWhereInput = usuarioId
      ? { usuarios: { some: { usuarioId } } }
      : {};
    const { skip, take } = calcularPaginacion(query);
    const [datos, total] = await this.prisma.$transaction([
      this.prisma.lineaWhatsapp.findMany({
        where,
        skip,
        take,
        orderBy: { nombre: "asc" },
      }),
      this.prisma.lineaWhatsapp.count({ where }),
    ]);
    return paginar(
      datos.map((linea) => ({
        id: linea.id,
        nombre: linea.nombre,
        telefono: linea.telefono,
        activa: linea.activa,
        comercial: linea.comercial,
        conectada: Boolean(this.credenciales(linea)),
        ...(administracion
          ? {
              phoneNumberId: linea.phoneNumberId,
              wabaId: linea.wabaId,
              tokenEnv: linea.tokenEnv,
            }
          : {}),
      })),
      total,
      query,
    );
  }

  credenciales(linea: LineaWhatsapp): CredencialesWhatsapp | null {
    const inicial = linea.id === LINEA_COMERCIAL_INICIAL;
    const token =
      this.config.get<string>(linea.tokenEnv) ||
      (inicial ? this.config.get<string>("WHATSAPP_ACCESS_TOKEN") : undefined);
    const phoneId =
      linea.phoneNumberId ||
      (inicial
        ? this.config.get<string>("WHATSAPP_PHONE_ID") ||
          this.config.get<string>("WHATSAPP_PHONE_NUMBER_ID")
        : undefined);
    const wabaId =
      linea.wabaId ||
      (inicial ? this.config.get<string>("WHATSAPP_WABA_ID") : undefined);
    return linea.activa && token && phoneId ? { token, phoneId, wabaId } : null;
  }

  async porId(id: string, usuarioId?: string) {
    const linea = await this.prisma.lineaWhatsapp.findFirst({
      where: {
        id,
        ...(usuarioId ? { usuarios: { some: { usuarioId } } } : {}),
      },
    });
    if (!linea) throw new NotFoundException("Línea no encontrada");
    return linea;
  }

  async desdeWebhook(phoneNumberId: string | undefined) {
    if (!phoneNumberId)
      throw new BadRequestException(
        "El webhook no identifica la línea receptora",
      );
    let linea = await this.prisma.lineaWhatsapp.findUnique({
      where: { phoneNumberId },
    });
    if (!linea) {
      const inicial = await this.prisma.lineaWhatsapp.findUnique({
        where: { id: LINEA_COMERCIAL_INICIAL },
      });
      if (
        inicial &&
        !inicial.phoneNumberId &&
        (this.config.get<string>("WHATSAPP_PHONE_ID") ||
          this.config.get<string>("WHATSAPP_PHONE_NUMBER_ID")) === phoneNumberId
      )
        linea = inicial;
    }
    if (!linea) throw new BadRequestException("Línea receptora no registrada");
    return linea;
  }

  async cuentaDeConversacion(id: string) {
    const conversacion = await this.prisma.conversacion.findUniqueOrThrow({
      where: { id },
      include: { linea: true },
    });
    return this.credenciales(conversacion.linea);
  }

  async actualizar(id: string, dto: ActualizarLineaDto, usuarioId: string) {
    const actual = await this.porId(id);
    const nueva = { ...actual, ...dto };
    if (
      nueva.activa &&
      (!this.credenciales(nueva) || !nueva.telefono || !nueva.wabaId)
    ) {
      throw new BadRequestException(
        "Completa número, Phone Number ID, WABA y credencial del servidor antes de activar.",
      );
    }
    const phoneIdInicial =
      this.config.get<string>("WHATSAPP_PHONE_ID") ||
      this.config.get<string>("WHATSAPP_PHONE_NUMBER_ID");
    if (
      id !== LINEA_COMERCIAL_INICIAL &&
      dto.phoneNumberId &&
      dto.phoneNumberId === phoneIdInicial
    ) {
      throw new BadRequestException(
        "Ese identificador pertenece a la línea comercial actual.",
      );
    }
    const phoneActual =
      actual.phoneNumberId ||
      (id === LINEA_COMERCIAL_INICIAL ? phoneIdInicial : undefined);
    if (
      dto.phoneNumberId &&
      phoneActual &&
      dto.phoneNumberId !== phoneActual &&
      (await this.prisma.conversacion.count({ where: { lineaId: id } }))
    ) {
      throw new BadRequestException(
        "Esta línea tiene historial: no se puede cambiar su identificador de WhatsApp.",
      );
    }
    try {
      await this.prisma.$transaction([
        this.prisma.lineaWhatsapp.update({ where: { id }, data: dto }),
        this.prisma.auditLog.create({
          data: {
            entidad: "LineaWhatsapp",
            entidadId: id,
            accion: "ACTUALIZADA",
            usuarioId,
            cambios: { ...dto },
          },
        }),
      ]);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException(
          "El número o identificador ya pertenece a otra línea.",
        );
      }
      throw error;
    }
    return { ok: true };
  }

  /** Los mismos permisos que REST. Se releen en cada aviso y no se cachean. */
  async destinatarios(conversacionId: string) {
    const usuarios = await this.prisma.usuario.findMany({
      where: {
        activo: true,
        OR: [
          { rol: { in: ["ADMIN", "SUPER_ADMIN"] } },
          {
            lineasWhatsapp: {
              some: {
                linea: { conversaciones: { some: { id: conversacionId } } },
              },
            },
          },
        ],
      },
      select: { id: true, rol: true },
    });
    const conversacion = await this.prisma.conversacion.findUnique({
      where: { id: conversacionId },
      include: {
        linea: { select: SELECT_LINEA },
        cliente: { select: { agenteId: true } },
      },
    });
    if (!conversacion) return [];
    return usuarios
      .filter(
        (u) =>
          tieneAlcanceGlobal(u.rol) ||
          conversacion.agenteId === null ||
          conversacion.agenteId === u.id ||
          (conversacion.linea.comercial &&
            conversacion.cliente.agenteId === u.id),
      )
      .map((u) => u.id);
  }
}
