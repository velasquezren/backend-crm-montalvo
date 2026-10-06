import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { ArchivoSubido } from '../../common/archivos/archivo-subido';
import { fechaCivilClinica, fechaCivilDesdeTexto, textoDeFechaCivil } from '../../common/fechas/zona-clinica';
import { enSegundoPlano } from '../../common/fiabilidad/en-segundo-plano';
import { validarImagenPublica } from '../../common/storage/imagen-publica';
import { R2Service } from '../../common/storage/r2.service';
import { PrismaService } from '../../prisma/prisma.service';
import { GuardarCobroDto } from './dto/guardar-cobro.dto';
import { EstadoCobro, estadoDelCobro } from './cobro-reglas';

/** El QR tal como lo edita la pantalla de Líneas. */
export interface CobroEditable {
  lineaId: string;
  linea: { nombre: string; comercial: boolean };
  cobro: {
    activo: boolean;
    banco: string;
    titular: string;
    instrucciones: string | null;
    venceEl: string | null;
    imagenUrl: string | null;
  } | null;
  /** Si hoy se puede ofrecer «Pagar ahora» por esta línea, y si no, por qué. */
  estado: EstadoCobro | 'SIN_CONFIGURAR';
  actualizadoEn: Date | null;
  actualizadoPor: { id: string; nombre: string } | null;
}

/**
 * Lo que necesita el chat para mandar el QR. La imagen sale de R2 como cualquier
 * adjunto (URL firmada al despachar): no hay una ruta pública para el QR.
 */
export interface CobroListo {
  banco: string;
  titular: string;
  instrucciones: string | null;
  imagen: { clave: string; mime: string };
}

/**
 * Único dueño de `CobroLinea`: el QR de pago de cada línea. La conversación lo lee
 * con `listoPara` (PANORAMA, «Quién escribe cada tabla»).
 */
@Injectable()
export class CobrosService {
  private readonly logger = new Logger(CobrosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
  ) {}

  async editable(lineaId: string): Promise<CobroEditable> {
    const linea = await this.prisma.lineaWhatsapp.findUnique({
      where: { id: lineaId },
      select: { nombre: true, comercial: true, cobro: { include: { actualizadoPor: { select: { id: true, nombre: true } } } } },
    });
    if (!linea) throw new NotFoundException('Línea no encontrada');
    const c = linea.cobro;
    return {
      lineaId,
      linea: { nombre: linea.nombre, comercial: linea.comercial },
      cobro: c
        ? {
            activo: c.activo,
            banco: c.banco,
            titular: c.titular,
            instrucciones: c.instrucciones,
            venceEl: c.venceEl ? textoDeFechaCivil(c.venceEl) : null,
            /* Firmada, para la vista previa de quien lo configura. */
            imagenUrl: c.imagenClave ? await this.r2.urlFirmada(c.imagenClave) : null,
          }
        : null,
      estado: c ? estadoDelCobro(c, fechaCivilClinica(new Date())) : 'SIN_CONFIGURAR',
      actualizadoEn: c?.actualizadoEn ?? null,
      actualizadoPor: c?.actualizadoPor ?? null,
    };
  }

  async guardar(lineaId: string, dto: GuardarCobroDto, usuarioId: string): Promise<CobroEditable> {
    await this.exigirLinea(lineaId);
    const venceEl = dto.venceEl ? fechaCivilDesdeTexto(dto.venceEl) : null;
    if (dto.venceEl && !venceEl) throw new BadRequestException('La fecha de vencimiento no es válida.');
    const actual = await this.prisma.cobroLinea.findUnique({ where: { lineaId }, select: { imagenId: true } });
    /* Encenderlo exige un QR que se pueda usar hoy: un «Pagar ahora» que manda un
       QR vencido o ninguno deja a la paciente sin forma de pagar. */
    if (dto.activo) {
      const estado = estadoDelCobro({ activo: true, imagenId: actual?.imagenId ?? null, venceEl }, fechaCivilClinica(new Date()));
      if (estado === 'SIN_QR') throw new BadRequestException('Sube la imagen del QR antes de activar el cobro.');
      if (estado === 'VENCIDO') throw new BadRequestException('Ese QR ya venció: sube uno vigente o corrige la fecha.');
    }
    const datos = {
      activo: dto.activo,
      banco: dto.banco,
      titular: dto.titular,
      instrucciones: dto.instrucciones ?? null,
      venceEl,
      actualizadoPorId: usuarioId,
    };
    await this.prisma.$transaction([
      this.prisma.cobroLinea.upsert({ where: { lineaId }, create: { lineaId, ...datos }, update: datos }),
      this.prisma.auditLog.create({
        data: { entidad: 'CobroLinea', entidadId: lineaId, accion: 'COBRO_ACTUALIZADO', usuarioId, cambios: { ...datos, venceEl: dto.venceEl ?? null } },
      }),
    ]);
    return this.editable(lineaId);
  }

  /**
   * Sube (o reemplaza) la imagen del QR. Va a R2 con un id nuevo: la URL pública
   * es inmutable y Meta la guarda en caché, así que un QR nuevo es otra URL.
   */
  async subirQr(lineaId: string, archivo: ArchivoSubido | undefined, usuarioId: string): Promise<CobroEditable> {
    if (!archivo) throw new BadRequestException('Falta la imagen del QR.');
    const imagen = validarImagenPublica(archivo.buffer);
    if ('error' in imagen) throw new BadRequestException(imagen.error);
    /* Un QR se escanea: por debajo de esto la cámara del teléfono no lo lee bien. */
    if (Math.min(imagen.ancho, imagen.alto) < 300) throw new BadRequestException('El QR es muy pequeño: sube una imagen de al menos 300 × 300 píxeles.');
    if (!this.r2.habilitado) throw new ServiceUnavailableException('El almacenamiento de imágenes no está configurado.');
    await this.exigirLinea(lineaId);

    const imagenId = randomUUID();
    const clave = `cobros/${lineaId}/${imagenId}.${imagen.extension}`;
    await this.r2.subir(clave, new Uint8Array(archivo.buffer).slice().buffer, imagen.mime);
    try {
      await this.prisma.$transaction(async tx => {
        const datos = { imagenId, imagenClave: clave, imagenMime: imagen.mime, imagenBytes: imagen.bytes, actualizadoPorId: usuarioId };
        /* Sin datos del banco todavía, nace apagado y sin texto: hay que completarlo antes de activarlo. */
        await tx.cobroLinea.upsert({ where: { lineaId }, create: { lineaId, banco: '', titular: '', ...datos }, update: datos });
        await tx.auditLog.create({ data: { entidad: 'CobroLinea', entidadId: lineaId, accion: 'QR_SUBIDO', usuarioId, cambios: { ancho: imagen.ancho, alto: imagen.alto } } });
      });
    } catch (error) {
      this.borrarDeR2(clave);
      throw error;
    }
    /* El QR anterior NO se borra de R2: cada «QR de pago» ya enviado lo cita como su
       imagen (el hilo la muestra y un reintento la vuelve a firmar). Es una imagen
       chica; borrarla dejaría esos mensajes rotos. */
    return this.editable(lineaId);
  }

  /** El QR que se puede mandar hoy por esta línea, o `null`. Ante la duda, no se ofrece pagar. */
  async listoPara(lineaId: string): Promise<CobroListo | null> {
    const c = await this.prisma.cobroLinea.findUnique({ where: { lineaId } });
    if (!c?.imagenClave || !c.imagenMime || !c.banco || !c.titular) return null;
    if (estadoDelCobro(c, fechaCivilClinica(new Date())) !== 'LISTO') return null;
    return { banco: c.banco, titular: c.titular, instrucciones: c.instrucciones, imagen: { clave: c.imagenClave, mime: c.imagenMime } };
  }

  private async exigirLinea(lineaId: string): Promise<void> {
    const linea = await this.prisma.lineaWhatsapp.findUnique({ where: { id: lineaId }, select: { id: true } });
    if (!linea) throw new NotFoundException('Línea no encontrada');
  }

  private borrarDeR2(clave: string) {
    void enSegundoPlano(`borrar ${clave} de R2`, this.logger, () => this.r2.eliminar(clave));
  }
}

