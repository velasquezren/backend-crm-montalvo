import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';

import { alcanceAgente } from '../../common/auth/roles';
import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CategoriaPacienteService } from './categoria-paciente.service';
import { ClientesService } from './clientes.service';
import { CreateClienteDto } from './dto/create-cliente.dto';
import { CreateInteresDto } from './dto/create-interes.dto';
import { FijarCategoriaDto } from './dto/fijar-categoria.dto';
import { QueryClienteDto } from './dto/query-cliente.dto';
import { UpdateClienteDto } from './dto/update-cliente.dto';

@Controller('clientes')
export class ClientesController {
  constructor(
    private readonly clientesService: ClientesService,
    private readonly categorias: CategoriaPacienteService,
  ) {}

  @Post()
  create(@Body() dto: CreateClienteDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.clientesService.create(dto, alcanceAgente(usuario));
  }

  @Get()
  findAll(@Query() query: QueryClienteDto, @CurrentUser() usuario: UsuarioJwt) {
    const soloAgenteId = alcanceAgente(usuario);
    return this.clientesService.findAll(query, soloAgenteId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    const soloAgenteId = alcanceAgente(usuario);
    return this.clientesService.findOne(id, soloAgenteId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateClienteDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    const soloAgenteId = alcanceAgente(usuario);
    return this.clientesService.update(id, dto, usuario.sub, soloAgenteId);
  }

  @Post(':id/intereses')
  registrarInteres(@Param('id') id: string, @Body() dto: CreateInteresDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.clientesService.registrarInteres(id, dto, alcanceAgente(usuario));
  }

  /**
   * Fija la categoría a mano, o la devuelve a automática con `null`. Solo
   * SUPER_ADMIN: las agentes son ADMIN para cooperar en el chat, y la
   * categoría decide a quién va una campaña.
   */
  @Put(':id/categoria')
  @Roles('SUPER_ADMIN')
  fijarCategoria(@Param('id') id: string, @Body() dto: FijarCategoriaDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.categorias.fijar(id, dto.categoria, usuario.sub);
  }

  @Post(':id/recalcular-categoria')
  recalcularCategoria(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.clientesService.actualizarCategoria(id, alcanceAgente(usuario));
  }

  /** Servicios que se le realizaron al paciente (desde las planillas importadas). */
  @Get(':id/historial')
  historial(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.clientesService.historialServicios(id, alcanceAgente(usuario));
  }
}
