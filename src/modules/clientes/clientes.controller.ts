import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { ClientesService } from './clientes.service';
import { CreateClienteDto } from './dto/create-cliente.dto';
import { CreateInteresDto } from './dto/create-interes.dto';
import { QueryClienteDto } from './dto/query-cliente.dto';
import { UpdateClienteDto } from './dto/update-cliente.dto';

@Controller('clientes')
export class ClientesController {
  constructor(private readonly clientesService: ClientesService) {}

  @Post()
  create(@Body() dto: CreateClienteDto) {
    return this.clientesService.create(dto);
  }

  @Get()
  findAll(@Query() query: QueryClienteDto, @CurrentUser() usuario: UsuarioJwt) {
    const soloAgenteId = usuario.rol === 'ADMIN' ? undefined : usuario.sub;
    return this.clientesService.findAll(query, soloAgenteId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    const soloAgenteId = usuario.rol === 'ADMIN' ? undefined : usuario.sub;
    return this.clientesService.findOne(id, soloAgenteId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateClienteDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    const soloAgenteId = usuario.rol === 'ADMIN' ? undefined : usuario.sub;
    return this.clientesService.update(id, dto, usuario.sub, soloAgenteId);
  }

  @Post(':id/intereses')
  registrarInteres(@Param('id') id: string, @Body() dto: CreateInteresDto) {
    return this.clientesService.registrarInteres(id, dto);
  }

  @Post(':id/recalcular-categoria')
  recalcularCategoria(@Param('id') id: string) {
    return this.clientesService.actualizarCategoria(id);
  }
}
