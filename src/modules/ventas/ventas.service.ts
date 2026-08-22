import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EstadoVenta, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

import { AuditService } from '../../common/audit/audit.service';
import { R2Service } from '../../common/storage/r2.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { LeadsService } from '../leads/leads.service';
import { ArchivoSubido } from './archivo-subido';
import { CreateVentaDto } from './dto/create-venta.dto';
import { QueryVentaDto } from './dto/query-venta.dto';
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

  async create(dto: CreateVentaDto, agenteId: string) {
    /* valida que el cliente exista (lanza 404 si no) */
    await this.clientesService.findOne(dto.clienteId);

    if (dto.comprobanteKey && !esComprobantePropio(dto.comprobanteKey, agenteId)) {
      throw new BadRequestException(
        'El comprobante no corresponde a un archivo subido por esta agente.',
      );
    }

    /* Un leadId de otro cliente no cuela en silencio: sin este chequeo, un
       UUID válido pero ajeno quedaría vinculado a la venta y `marcarConvertidos`
       nunca encontraría el lead a cerrar (está scopeado por clienteId), así
       que el error saldría a la luz recién al leer los reportes de atribución. */
    if (dto.leadId) {
      const lead = await this.prisma.lead.findUnique({
        where: { id: dto.leadId },
        select: { id: true, clienteId: true },
      });
      if (!lead || lead.clienteId !== dto.clienteId) {
        throw new BadRequestException('El lead indicado no corresponde a este cliente.');
      }
    }

    const estado = dto.estado ?? 'GANADA';
    if (estado === 'PERDIDA' && !dto.motivoPerdida?.trim()) {
      throw new BadRequestException('Para registrar una venta como perdida hay que indicar el motivo.');
    }

    const venta = await this.prisma.venta.create({
      data: {
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
      include: {
        cliente: { select: { id: true, nombre: true, telefono: true } },
        agente: { select: { id: true, nombre: true } },
        lead: { select: { id: true, origen: true, anuncioId: true } },
      },
    });

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

    if (venta.estado === 'GANADA') {
      await this.clientesService.actualizarCategoria(venta.clienteId);
      await this.leadsService.marcarConvertidos(venta.clienteId, venta.leadId);
    }

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
    const extension = file.originalname.split('.').pop() || 'bin';
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

  async findAll(query: QueryVentaDto) {
    const where: Prisma.VentaWhereInput = {
      estado: query.estado,
      agenteId: query.agenteId,
      createdAt: {
        gte: query.desde ? new Date(query.desde) : undefined,
        lte: query.hasta ? new Date(query.hasta) : undefined,
      },
    };
    const { skip, take } = calcularPaginacion(query);

    const [datos, total] = await this.prisma.$transaction([
      this.prisma.venta.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          cliente: { select: { id: true, nombre: true, telefono: true, pac: true } },
          agente: { select: { id: true, nombre: true } },
          lead: { select: { id: true, origen: true, anuncioId: true } },
        },
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

    const actualizada = await this.prisma.venta.update({
      where: { id },
      data: {
        estado,
        // Al salir de PERDIDA el motivo deja de aplicar — mismo criterio que Lead.updateEstado.
        motivoPerdida: estado === 'PERDIDA' ? motivoPerdida!.trim() : null,
      },
    });
    await this.audit.registrar('Venta', id, 'CAMBIO_ESTADO', adminId, {
      de: venta.estado,
      a: estado,
      motivoPerdida: estado === 'PERDIDA' ? actualizada.motivoPerdida : undefined,
    });

    if (estado === 'GANADA' && venta.estado !== 'GANADA') {
      await this.clientesService.actualizarCategoria(actualizada.clienteId);
      await this.leadsService.marcarConvertidos(actualizada.clienteId, actualizada.leadId);
    }

    const comprobanteUrl = actualizada.comprobanteKey ? await this.firmarComprobante(actualizada.comprobanteKey) : null;
    return { ...actualizada, comprobanteUrl };
  }
}
