import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';

import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreateUsuarioDto } from './dto/create-usuario.dto';
import { UpdateUsuarioDto } from './dto/update-usuario.dto';
import { UsuariosService } from './usuarios.service';

/** Gestión de agentes — solo administradores. */
@Controller('usuarios')
@Roles('ADMIN')
export class UsuariosController {
  constructor(private readonly usuariosService: UsuariosService) {}

  @Post()
  create(@Body() dto: CreateUsuarioDto) {
    return this.usuariosService.create(dto);
  }

  @Get()
  findAll() {
    return this.usuariosService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.usuariosService.findOne(id);
  }

  /** Se pasa el id del admin que ejecuta para impedir que se bloquee a sí mismo. */
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateUsuarioDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.usuariosService.update(id, dto, usuario.sub);
  }

  @Delete(':id')
  desactivar(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.usuariosService.desactivar(id, usuario.sub);
  }

  @Delete(':id/hard')
  eliminarDefinitivamente(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.usuariosService.eliminarDefinitivamente(id, usuario.sub);
  }
}
