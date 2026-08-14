import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { EstadoVenta } from '@prisma/client';
import { IsEnum } from 'class-validator';

import { alcanceAgente } from '../../common/auth/roles';
import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ArchivoSubido } from './archivo-subido';
import { CreateVentaDto } from './dto/create-venta.dto';
import { QueryVentaDto } from './dto/query-venta.dto';
import { VentasService } from './ventas.service';

class CambiarEstadoDto {
  @IsEnum(EstadoVenta)
  estado!: EstadoVenta;
}

@Controller('ventas')
export class VentasController {
  constructor(private readonly ventasService: VentasService) {}

  @Post()
  create(@Body() dto: CreateVentaDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.ventasService.create(dto, usuario.sub);
  }

  @Post('comprobante')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024, files: 1 } }))
  subirComprobante(
    @UploadedFile() file: ArchivoSubido,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.ventasService.subirComprobante(file, usuario.sub);
  }

  /** Un agente ve solo sus ventas; un admin ve todas (visibilidad por rol). */
  @Get()
  findAll(@Query() query: QueryVentaDto, @CurrentUser() usuario: UsuarioJwt) {
    // Un agente solo ve lo suyo; admin y super admin ven todo el equipo.
    query.agenteId = alcanceAgente(usuario) ?? query.agenteId;
    return this.ventasService.findAll(query);
  }

  @Patch(':id/estado')
  @Roles('ADMIN')
  cambiarEstado(
    @Param('id') id: string,
    @Body() dto: CambiarEstadoDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.ventasService.cambiarEstado(id, dto.estado, usuario.sub);
  }
}
