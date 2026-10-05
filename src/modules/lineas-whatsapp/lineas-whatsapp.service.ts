import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { esRolOperativo, ROLES_ALCANCE_GLOBAL, tieneAlcanceGlobal } from "../../common/auth/roles";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../prisma/prisma.service";
import { Prisma, LineaWhatsapp } from "../../prisma/prisma-client";
import {
  calcularPaginacion,
  paginar,
  PaginationDto,
} from "../../common/dto/pagination.dto";
import { CredencialesWhatsapp } from "../../common/whatsapp/whatsapp-cloud.service";
import { LINEA_COMERCIAL_INICIAL } from "../conversaciones/acceso-conversacion";
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

  /**
   * Resuelve la línea receptora de un cambio del webhook, o `null` si ese
   * número **no es nuestro** —falta el `phone_number_id` o no está registrado
   * en el CRM—.
   *
   * **Devuelve `null` en vez de lanzar, y esa distinción es el punto.** Antes
   * lanzaba, el controlador lo contaba como fallo de persistencia y el lote
   * entero salía 503. El 503 es correcto para un fallo TRANSITORIO —la base
   * caída— porque Meta reintenta y acaba entrando; para uno PERMANENTE es un
   * mensaje envenenado: un número que no está registrado va a fallar idéntico
   * en cada reintento, para siempre, y Meta termina desactivando la
   * suscripción. Como las cuatro líneas comparten una sola app y un solo
   * `META_APP_SECRET`, eso deja mudas a las CUATRO, incluida la comercial, que
   * es la única que hoy lleva tráfico real de pacientes. Es la misma familia de
   * fallo por la que este webhook no usa `forbidNonWhitelisted`.
   *
   * Un error de base sigue propagándose como excepción: eso SÍ es transitorio y
   * tiene que acabar en 503. Ver `procesarWebhook`.
   */
  async desdeWebhook(
    phoneNumberId: string | undefined,
  ): Promise<LineaWhatsapp | null> {
    if (!phoneNumberId) return null;
    const linea = await this.prisma.lineaWhatsapp.findUnique({
      where: { phoneNumberId },
    });
    if (linea) return linea;
    /* La línea comercial puede no tener `phoneNumberId` en base todavía: nació
       en la migración y sus credenciales siguen viviendo en el `.env`. */
    const inicial = await this.prisma.lineaWhatsapp.findUnique({
      where: { id: LINEA_COMERCIAL_INICIAL },
    });
    const phoneIdEnv =
      this.config.get<string>("WHATSAPP_PHONE_ID") ||
      this.config.get<string>("WHATSAPP_PHONE_NUMBER_ID");
    return inicial && !inicial.phoneNumberId && phoneIdEnv === phoneNumberId
      ? inicial
      : null;
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

  /**
   * Quién ve esta conversación en vivo (`ven`) y a quién, además, le suena
   * (`avisar`). Los mismos permisos que REST; se releen en cada aviso y no se
   * cachean, porque quitarle una línea a alguien tiene que cortarle los avisos
   * en el acto.
   *
   * **Son dos listas y no una a propósito.** Silenciar una línea no puede
   * quitarte de `ven`: el socket es también lo que refresca la bandeja, y una
   * agente que cubre Recepción con los avisos apagados tiene que seguir viendo
   * llegar esos chats — solo que sin que le suenen. Si el silencio recortara
   * `ven`, su bandeja se quedaría congelada sin que nadie supiera por qué.
   *
   * Lo que es SUYO avisa aunque la línea esté silenciada: el chat asignado a
   * ella, o en la comercial la paciente de su cartera. Silenciar quita el ruido
   * del pool, no su trabajo — igual que en Slack un canal silenciado sigue
   * avisando cuando te mencionan.
   *
   * El silencio vale igual para quien ve la línea por membresía que para quien
   * la ve por rol (los admins): es una preferencia de la persona, no del
   * acceso. Ver `SilencioLinea`.
   */
  /**
   * `critica` (una emergencia que declaró la paciente): le suena a todos los que
   * la ven, también a quien silenció la línea. El silencio es para el flujo de
   * todos los días; esto no puede quedar mudo.
   */
  async audiencia(conversacionId: string, { critica = false } = {}): Promise<{ ven: string[]; avisar: string[] }> {
    const conversacion = await this.prisma.conversacion.findUnique({
      where: { id: conversacionId },
      select: {
        lineaId: true,
        agenteId: true,
        linea: { select: { comercial: true } },
        cliente: { select: { agenteId: true } },
      },
    });
    if (!conversacion) return { ven: [], avisar: [] };

    const { lineaId, agenteId, linea, cliente } = conversacion;
    const usuarios = await this.prisma.usuario.findMany({
      where: {
        activo: true,
        OR: [
          { rol: { in: [...ROLES_ALCANCE_GLOBAL] } },
          { lineasWhatsapp: { some: { lineaId } } },
        ],
      },
      select: {
        id: true,
        rol: true,
        silenciosLinea: { where: { lineaId }, select: { lineaId: true } },
      },
    });

    const esSuya = (id: string) =>
      agenteId === id || (linea.comercial && cliente.agenteId === id);
    const ven = usuarios.filter(
      (u) =>
        tieneAlcanceGlobal(u.rol) ||
        esRolOperativo(u.rol) ||
        agenteId === null ||
        esSuya(u.id),
    );
    const avisar = critica ? ven : ven.filter(
      (u) => u.silenciosLinea.length === 0 || esSuya(u.id),
    );
    return { ven: ven.map((u) => u.id), avisar: avisar.map((u) => u.id) };
  }

  /**
   * Las líneas activas que esta persona ve, y si le suenan. Es lo que se le
   * muestra para que decida ella; las inactivas no reciben mensajes y un
   * interruptor sobre ellas solo sería ruido.
   *
   * «Ve» con la misma convención que `listar` y `porId`: `alcance` es el de
   * `alcanceAgente()` —`undefined` con alcance global—, y el dueño de los avisos
   * es siempre `usuarioId`, que sale del token.
   */
  async avisosDe(usuarioId: string, alcance: string | undefined, query: PaginationDto) {
    const where: Prisma.LineaWhatsappWhereInput = {
      activa: true,
      ...(alcance ? { usuarios: { some: { usuarioId: alcance } } } : {}),
    };
    const { skip, take } = calcularPaginacion(query);
    const [lineas, total] = await this.prisma.$transaction([
      this.prisma.lineaWhatsapp.findMany({
        where,
        skip,
        take,
        orderBy: { nombre: "asc" },
        select: {
          id: true,
          nombre: true,
          telefono: true,
          silencios: { where: { usuarioId }, select: { lineaId: true } },
        },
      }),
      this.prisma.lineaWhatsapp.count({ where }),
    ]);
    return paginar(
      lineas.map((l) => ({
        lineaId: l.id,
        nombre: l.nombre,
        telefono: l.telefono,
        suena: l.silencios.length === 0,
      })),
      total,
      query,
    );
  }

  /**
   * Enciende o apaga los avisos de una línea para quien lo pide. Idempotente:
   * pedir dos veces lo mismo deja lo mismo.
   *
   * Solo sobre una línea que ve —404 si no, como cualquier recurso fuera de su
   * alcance—: silenciar lo que no ve no significa nada, y dejaría una fila que
   * reaparecería el día que le dieran esa línea.
   *
   * No toca `versionSesion`: no cambia permisos, y la audiencia se relee de la
   * base en cada mensaje, así que el cambio vale desde el siguiente.
   */
  async fijarAviso(usuarioId: string, alcance: string | undefined, lineaId: string, suena: boolean) {
    await this.porId(lineaId, alcance);

    await this.prisma.$transaction([
      suena
        ? this.prisma.silencioLinea.deleteMany({ where: { usuarioId, lineaId } })
        : this.prisma.silencioLinea.upsert({
            where: { usuarioId_lineaId: { usuarioId, lineaId } },
            create: { usuarioId, lineaId },
            update: {},
          }),
      this.prisma.auditLog.create({
        data: {
          entidad: "Usuario",
          entidadId: usuarioId,
          accion: "AVISOS_LINEAS",
          usuarioId,
          cambios: { lineaId, suena },
        },
      }),
    ]);
    return { lineaId, suena };
  }

  /** Quién ve la conversación. Para saber a quién le suena, `audiencia`. */
  async destinatarios(conversacionId: string): Promise<string[]> {
    return (await this.audiencia(conversacionId)).ven;
  }
}
