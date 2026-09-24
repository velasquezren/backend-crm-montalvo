import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EstadoVenta, Prisma } from '../../prisma/prisma-client';
import { randomUUID } from 'crypto';

import { AuditService } from '../../common/audit/audit.service';
import { R2Service } from '../../common/storage/r2.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { LeadsService } from '../leads/leads.service';
import { ArchivoSubido } from './archivo-subido';
import { CorregirOrigenDto } from './dto/corregir-origen.dto';
import { CreateVentaDto } from './dto/create-venta.dto';
import { QueryVentaDto } from './dto/query-venta.dto';
import { terminoBusqueda } from '../../common/dto/busqueda';
import { calcularPaginacion, paginar } from '../../common/dto/pagination.dto';

/** Carpeta de R2 donde vive TODO comprobante, y solo eso. */
const PREFIJO_COMPROBANTES = 'comprobantes/';

/** Lo que puede ser el respaldo de un pago: una foto del QR o un PDF. */
const MIME_COMPROBANTE = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
];

/**
 * La clave de R2 la manda el navegador, así que es entrada de usuario, no un
 * dato de confianza aunque venga de nuestro propio endpoint de subida.
 *
 * Sin esta comprobación, registrar una venta con
 * `comprobanteKey: "memoria/<otra-agente>/…"` hacía que el detalle devolviera
 * una URL firmada de ESE objeto: el bucket entero —fotos de pacientes de otros
 * chats, recursos de la memoria de otra agente— legible desde un formulario de
 * ventas. Es el mismo agujero que ya cerramos en el proxy de descarga, entrando
 * por otra puerta.
 *
 * Se exige la carpeta del agente, no solo `comprobantes/`: el endpoint de subida
 * siempre escribe `comprobantes/<usuarioId>/…`, así que cualquier flujo legítimo
 * pasa, y una clave ajena no.
 */
function esComprobantePropio(clave: string, agenteId: string): boolean {
  return clave.startsWith(`${PREFIJO_COMPROBANTES}${agenteId}/`);
}

/** Una fila del resumen: cuántas ventas y cuánto suman, por estado, método o módulo. */
export interface GrupoVentas {
  clave: string | null;
  cantidad: number;
  monto: number;
}

export interface ResumenVentas {
  porEstado: GrupoVentas[];
  porMetodo: GrupoVentas[];
  porModulo: GrupoVentas[];
}

/** Lo que devuelve cada lectura o comando de una venta. */
const INCLUDE_VENTA = {
  cliente: { select: { id: true, nombre: true, telefono: true, pac: true } },
  agente: { select: { id: true, nombre: true } },
  lead: { select: { id: true, origen: true, anuncioId: true } },
} satisfies Prisma.VentaInclude;

/** Extensión del archivo según su tipo, no según el nombre que puso quien lo subió. */
const EXTENSION_COMPROBANTE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
};

/**
 * Módulo Ventas — RF-11/RF-12.
 * Una venta GANADA dispara (vía services de otros módulos, nunca su BD):
 *   1. ClientesService.actualizarCategoria() → recategorización (RF-21)
 *   2. LeadsService.marcarConvertidos()      → cierre automático de oportunidades
 * El agente que cierra queda fijado desde el JWT y no existe endpoint para cambiarlo.
 */
@Injectable()
export class VentasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clientesService: ClientesService,
    private readonly leadsService: LeadsService,
    private readonly audit: AuditService,
    private readonly r2: R2Service,
  ) {}

  async create(dto: CreateVentaDto, agenteId: string, soloAgenteId?: string) {
    // Validar también el alcance antes de guardar la venta y sus efectos.
    await this.clientesService.findOne(dto.clienteId, soloAgenteId);

    if (dto.comprobanteKey && !esComprobantePropio(dto.comprobanteKey, agenteId)) {
      throw new BadRequestException(
        'El comprobante no corresponde a un archivo subido por esta agente.',
      );
    }

    /* Un leadId de otro cliente no cuela en silencio: sin este chequeo, un
       UUID válido pero ajeno quedaría vinculado a la venta y `marcarConvertidos`
       nunca encontraría el lead a cerrar (está scopeado por clienteId), así
       que el error saldría a la luz recién al leer los reportes de atribución. */
    if (dto.leadId && !(await this.leadsService.esDelCliente(dto.leadId, dto.clienteId))) {
      throw new BadRequestException('El lead indicado no corresponde a este cliente.');
    }

    const estado = dto.estado ?? 'GANADA';
    if (estado === 'PERDIDA' && !dto.motivoPerdida?.trim()) {
      throw new BadRequestException('Para registrar una venta como perdida hay que indicar el motivo.');
    }

    /* La venta y sus efectos (categoría, cierre de leads) van en UNA transacción.
       Separados, un fallo entre ellos dejaba la venta guardada sin sus efectos,
       y el reintento con la misma `clientRequestId` devolvía esa venta sin
       repetirlos: quedaban así para siempre. */
    let venta;
    try {
      venta = await this.prisma.$transaction(async tx => {
        const creada = await tx.venta.create({
          data: {
            clientRequestId: dto.clientRequestId ?? null,
            clienteId: dto.clienteId,
            agenteId,
            producto: dto.producto,
            monto: dto.monto,
            estado,
            metodoPago: dto.metodoPago ?? null,
            comprobante: dto.comprobante ?? null,
            comprobanteKey: dto.comprobanteKey ?? null,
            comprobanteMime: dto.comprobanteMime ?? null,
            comprobanteNombre: dto.comprobanteNombre ?? null,
            medico: dto.medico ?? null,
            modulo: dto.modulo ?? null,
            notas: dto.notas ?? null,
            leadId: dto.leadId ?? null,
            motivoPerdida: estado === 'PERDIDA' ? dto.motivoPerdida!.trim() : null,
          },
          include: INCLUDE_VENTA,
        });
        if (creada.estado === 'GANADA') {
          await this.clientesService.actualizarCategoria(creada.clienteId, undefined, tx);
          await this.leadsService.marcarConvertidos(creada.clienteId, creada.leadId, tx);
        }
        return creada;
      });
    } catch (error) {
      /* La misma intención otra vez —doble envío, o reintento tras perder la
         respuesta—: se devuelve la venta que ya existe y NO se repiten la
         auditoría, la categoría ni el cierre de leads. Una clave ajena (de otra
         agente) no revela nada: sigue el error original. */
      const yaRegistrada = await this.ventaDeLaMismaIntencion(error, dto.clientRequestId, agenteId);
      if (!yaRegistrada) throw error;
      return yaRegistrada;
    }

    await this.audit.registrar('Venta', venta.id, 'CREADA', agenteId, {
      producto: venta.producto,
      monto: Number(venta.monto),
      estado: venta.estado,
      metodoPago: venta.metodoPago,
      comprobante: venta.comprobante,
      modulo: venta.modulo,
      medico: venta.medico,
      leadId: venta.leadId,
    });

    const comprobanteUrl = venta.comprobanteKey ? await this.firmarComprobante(venta.comprobanteKey) : null;
    return { ...venta, comprobanteUrl };
  }

  private async ventaDeLaMismaIntencion(error: unknown, clientRequestId: string | undefined, agenteId: string) {
    if (!clientRequestId) return null;
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return null;
    const venta = await this.prisma.venta.findUnique({ where: { clientRequestId }, include: INCLUDE_VENTA });
    if (!venta || venta.agenteId !== agenteId) return null;
    const comprobanteUrl = venta.comprobanteKey ? await this.firmarComprobante(venta.comprobanteKey) : null;
    return { ...venta, comprobanteUrl };
  }

  /**
   * Firma para leer, pero solo dentro de la carpeta de comprobantes.
   *
   * Segunda barrera, por si una clave de otro sitio llegara a estar guardada:
   * la primera es `esComprobantePropio` al crear. Ninguna fila existente puede
   * usar este módulo para leer fuera de lo suyo.
   */
  private async firmarComprobante(clave: string): Promise<string | null> {
    if (!clave.startsWith(PREFIJO_COMPROBANTES)) return null;
    return this.r2.urlFirmada(clave);
  }

  async subirComprobante(file: ArchivoSubido, usuarioId: string) {
    if (!this.r2.habilitado) {
      throw new BadRequestException('El almacenamiento de comprobantes no está disponible');
    }
    /* Sin esto, una petición sin adjunto reventaba con un 500 al leer
       `file.size` de undefined en vez de decir qué faltaba. */
    if (!file) {
      throw new BadRequestException('Se requiere adjuntar el archivo del comprobante');
    }
    if (file.size > 8 * 1024 * 1024) {
      throw new BadRequestException('El comprobante supera el límite de 8 MB');
    }
    /* Un comprobante es una foto del QR o un PDF. Sin lista blanca se podía
       subir un .html y servirlo firmado desde el dominio de R2. */
    if (!MIME_COMPROBANTE.includes(file.mimetype.split(';')[0].trim().toLowerCase())) {
      throw new BadRequestException(
        `Tipo de archivo no permitido (${file.mimetype}). El comprobante debe ser una imagen o un PDF.`,
      );
    }

    const idTemp = randomUUID();
    const extension = EXTENSION_COMPROBANTE[file.mimetype.split(';')[0].trim().toLowerCase()] ?? 'bin';
    const comprobanteKey = `comprobantes/${usuarioId}/${idTemp}.${extension}`;
    const ab = file.buffer.buffer.slice(
      file.buffer.byteOffset,
      file.buffer.byteOffset + file.buffer.byteLength,
    ) as ArrayBuffer;

    await this.r2.subir(comprobanteKey, ab, file.mimetype);
    const comprobanteUrl = await this.r2.urlFirmada(comprobanteKey);

    return {
      comprobanteKey,
      comprobanteMime: file.mimetype,
      comprobanteNombre: file.originalname,
      comprobanteUrl,
    };
  }

  /** El filtro del listado y del resumen: tienen que contar exactamente las mismas ventas. */
  private construirWhere(query: QueryVentaDto): Prisma.VentaWhereInput {
    const busqueda = terminoBusqueda(query.q);
    const condiciones: Prisma.VentaWhereInput[] = [];

    if (query.estado) {
      condiciones.push({ estado: query.estado });
    }
    if (query.agenteId) {
      condiciones.push({ agenteId: query.agenteId });
    }
    if (query.desde || query.hasta) {
      condiciones.push({
        createdAt: {
          gte: query.desde ? new Date(query.desde) : undefined,
          lte: query.hasta ? new Date(query.hasta) : undefined,
        },
      });
    }
    if (query.metodoPago) {
      condiciones.push({ metodoPago: query.metodoPago });
    }
    if (query.sinModulo) {
      condiciones.push({ modulo: null });
    } else if (query.modulo) {
      condiciones.push({ modulo: query.modulo });
    }
    if (query.comprobante === 'CON_COMPROBANTE') {
      condiciones.push({
        OR: [
          { comprobanteKey: { not: null } },
          { AND: [{ comprobante: { not: null } }, { comprobante: { not: '' } }] },
        ],
      });
    } else if (query.comprobante === 'SIN_COMPROBANTE') {
      condiciones.push({
        AND: [
          { comprobanteKey: null },
          { OR: [{ comprobante: null }, { comprobante: '' }] },
        ],
      });
    }

    if (busqueda) {
      condiciones.push({
        OR: [
          { cliente: { nombre: { contains: busqueda, mode: 'insensitive' } } },
          { cliente: { telefono: { contains: busqueda } } },
          { cliente: { ci: { contains: busqueda, mode: 'insensitive' } } },
          { cliente: { pac: { contains: busqueda, mode: 'insensitive' } } },
          { producto: { contains: busqueda, mode: 'insensitive' } },
          { medico: { contains: busqueda, mode: 'insensitive' } },
          { comprobante: { contains: busqueda, mode: 'insensitive' } },
        ],
      });
    }

    return condiciones.length > 0 ? { AND: condiciones } : {};
  }

  async findAll(query: QueryVentaDto) {
    const where = this.construirWhere(query);
    const { skip, take } = calcularPaginacion(query);

    const [datos, total] = await this.prisma.$transaction([
      this.prisma.venta.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: INCLUDE_VENTA,
        skip,
        take,
      }),
      this.prisma.venta.count({ where }),
    ]);

    const datosConUrl = await Promise.all(
      datos.map(async v => ({
        ...v,
        comprobanteUrl: v.comprobanteKey ? await this.firmarComprobante(v.comprobanteKey) : null,
      })),
    );

    return paginar(datosConUrl, total, query);
  }

  /**
   * Los números de las tarjetas y los gráficos, sobre TODO lo filtrado.
   *
   * Se calculaban en el navegador sobre la página visible: con más de 25
   * ventas, «Total cerrado» sumaba solo esas 25 y se leía como el total. Tres
   * `groupBy` con el mismo filtro que el listado, en un solo viaje.
   */
  async resumen(query: QueryVentaDto): Promise<ResumenVentas> {
    const where = this.construirWhere(query);
    const [porEstado, porMetodo, porModulo] = await this.prisma.$transaction([
      this.prisma.venta.groupBy({ by: ['estado'], where, orderBy: { estado: 'asc' }, _count: { _all: true }, _sum: { monto: true } }),
      this.prisma.venta.groupBy({ by: ['metodoPago'], where, orderBy: { metodoPago: 'asc' }, _count: { _all: true }, _sum: { monto: true } }),
      this.prisma.venta.groupBy({ by: ['modulo'], where, orderBy: { modulo: 'asc' }, _count: { _all: true }, _sum: { monto: true } }),
    ]);
    const grupo = (clave: string | null, f: { _count?: { _all?: number } | true; _sum?: { monto?: Prisma.Decimal | null } }) => ({
      clave,
      cantidad: typeof f._count === 'object' ? (f._count._all ?? 0) : 0,
      monto: Number(f._sum?.monto ?? 0),
    });
    return {
      porEstado: porEstado.map(f => grupo(f.estado, f)),
      porMetodo: porMetodo.map(f => grupo(f.metodoPago, f)),
      porModulo: porModulo.map(f => grupo(f.modulo, f)),
    };
  }

  /** Cambio de estado (solo ADMIN, garantizado en el controller) — RF-12: el agente no se toca. */
  async cambiarEstado(id: string, estado: EstadoVenta, adminId: string, motivoPerdida?: string) {
    const venta = await this.prisma.venta.findUnique({ where: { id } });
    if (!venta) {
      throw new NotFoundException(`Venta ${id} no encontrada`);
    }

    /* Mismo criterio que Lead.motivoPerdida: perder una venta sin decir por
       qué es irrecuperable a los tres meses. */
    if (estado === 'PERDIDA' && !motivoPerdida?.trim()) {
      throw new BadRequestException('Para marcar una venta como perdida hay que indicar el motivo.');
    }

    /* Sin cambio real no se escribe: «de GANADA a GANADA» en la bitácora es
       ruido, igual que en `corregirOrigen`. Una PERDIDA con otro motivo sí es
       un cambio. */
    if (venta.estado === estado && (estado !== 'PERDIDA' || venta.motivoPerdida === motivoPerdida!.trim())) {
      return this.detalleConComprobante(id);
    }

    /* En una transacción por lo mismo que `create`: si los efectos fallaban
       tras guardar el estado, el reintento caía en «sin cambio real» de arriba
       y ya nunca recalculaba la categoría ni cerraba los leads. */
    const actualizada = await this.prisma.$transaction(async tx => {
      const cambiada = await tx.venta.update({
        where: { id },
        data: {
          estado,
          // Al salir de PERDIDA el motivo deja de aplicar — mismo criterio que Lead.updateEstado.
          motivoPerdida: estado === 'PERDIDA' ? motivoPerdida!.trim() : null,
        },
        /* Sin esto volvía sin paciente, y el detalle —que reemplaza la venta
           abierta con esta respuesta— se rompía al leer `venta.cliente`. */
        include: INCLUDE_VENTA,
      });

      /* La categoría se recalcula al entrar Y al salir de GANADA: una venta
         anulada seguía contando y el paciente se quedaba en GOLD o SILVER por
         una compra que no existió. Los leads no se reabren — su estado cuenta lo
         que pasó cuando pasó (ver `corregirOrigen`). */
      if ((estado === 'GANADA') !== (venta.estado === 'GANADA')) {
        await this.clientesService.actualizarCategoria(cambiada.clienteId, undefined, tx);
      }
      if (estado === 'GANADA' && venta.estado !== 'GANADA') {
        await this.leadsService.marcarConvertidos(cambiada.clienteId, cambiada.leadId, tx);
      }
      return cambiada;
    });
    await this.audit.registrar('Venta', id, 'CAMBIO_ESTADO', adminId, {
      de: venta.estado,
      a: estado,
      motivoPerdida: estado === 'PERDIDA' ? actualizada.motivoPerdida : undefined,
    });

    const comprobanteUrl = actualizada.comprobanteKey ? await this.firmarComprobante(actualizada.comprobanteKey) : null;
    return { ...actualizada, comprobanteUrl };
  }

  /**
   * Corregir el lead de origen de una venta ya registrada — CAMP-1.
   *
   * Desde CAMP-1 `Venta.leadId` es dato de atribución: alimenta
   * `Venta → Lead → anuncioId`, que es lo que dirá de qué anuncio vino el
   * dinero. Un origen mal elegido entre varios leads no puede quedar sin más
   * arreglo que un UPDATE a mano en la base.
   *
   * **Solo toca `Venta.leadId`. A propósito no vuelve a correr
   * `marcarConvertidos`.** Esa función cierra leads, y rehacerla aquí
   * reescribiría la historia del embudo: pondría en CONVERTIDO el lead nuevo
   * —con su fecha de hoy, no la de la venta— y dejaría el anterior cerrado sin
   * venta que lo respalde, porque no existe la operación inversa. El estado de
   * un lead cuenta lo que pasó cuando pasó; la atribución cuenta de dónde vino
   * el dinero. Corregir lo segundo no es motivo para falsear lo primero.
   * Consecuencia conocida y aceptada: tras una corrección, el lead viejo puede
   * quedar CONVERTIDO sin venta asociada. Está documentado en
   * `docs/CAMP-1-atribucion-venta-lead.md`.
   *
   * Alcance: una agente corrige solo sus ventas; de ADMIN para arriba, todas.
   * Una venta ajena responde 404 —no 403— igual que el resto del módulo: que un
   * id exista no es información que deba filtrarse.
   */
  async corregirOrigen(
    id: string,
    dto: CorregirOrigenDto,
    usuarioId: string,
    soloAgenteId?: string,
  ) {
    const venta = await this.prisma.venta.findUnique({
      where: { id },
      select: { id: true, clienteId: true, agenteId: true, leadId: true },
    });
    if (!venta || (soloAgenteId && venta.agenteId !== soloAgenteId)) {
      throw new NotFoundException(`Venta ${id} no encontrada`);
    }

    /* Mismo criterio que `create`, y mismo mensaje: no se dice si el lead no
       existe o si es de otra paciente, porque distinguirlo permitiría sondear
       qué ids hay en la base. */
    if (dto.leadId && !(await this.leadsService.esDelCliente(dto.leadId, venta.clienteId))) {
      throw new BadRequestException('El lead indicado no corresponde a este cliente.');
    }

    /* Sin cambio real no se escribe: una entrada de bitácora que dice "de X a X"
       es ruido para quien la lea dentro de un año. */
    if (venta.leadId === dto.leadId) {
      return this.detalleConComprobante(id);
    }

    const actualizada = await this.prisma.venta.update({
      where: { id },
      data: { leadId: dto.leadId },
      include: INCLUDE_VENTA,
    });

    await this.audit.registrar('Venta', id, 'CAMBIO_ORIGEN', usuarioId, {
      de: venta.leadId,
      a: dto.leadId,
    });

    const comprobanteUrl = actualizada.comprobanteKey
      ? await this.firmarComprobante(actualizada.comprobanteKey)
      : null;
    return { ...actualizada, comprobanteUrl };
  }

  /** La venta con la misma forma que devuelve una corrección, sin escribir nada. */
  private async detalleConComprobante(id: string) {
    const venta = await this.prisma.venta.findUniqueOrThrow({
      where: { id },
      include: INCLUDE_VENTA,
    });
    const comprobanteUrl = venta.comprobanteKey
      ? await this.firmarComprobante(venta.comprobanteKey)
      : null;
    return { ...venta, comprobanteUrl };
  }
}
