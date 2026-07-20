import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { EstadoVenta } from '@prisma/client';
import { IsEnum } from 'class-validator';

import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
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

  /** Un agente ve solo sus ventas; un admin ve todas (visibilidad por rol). */
  @Get()
  findAll(@Query() query: QueryVentaDto, @CurrentUser() usuario: UsuarioJwt) {
    if (usuario.rol !== 'ADMIN') {
      query.agenteId = usuario.sub;
    }
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
