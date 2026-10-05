import { Body, Controller, Get, Param, Put } from '@nestjs/common';

import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { GuardarMenuDto } from './dto/guardar-menu.dto';
import { MenuAtencionService } from './menu-atencion.service';

/** Se configura junto con la línea, en la misma pantalla y con el mismo rol. */
@Roles('SUPER_ADMIN')
@Controller('menu-atencion')
export class MenuAtencionController {
  constructor(private readonly service: MenuAtencionService) {}

  @Get(':lineaId')
  obtener(@Param('lineaId') lineaId: string) {
    return this.service.editable(lineaId);
  }

  /** Reemplaza el menú entero: es un documento que se edita y guarda de una vez. */
  @Put(':lineaId')
  guardar(@Param('lineaId') lineaId: string, @Body() dto: GuardarMenuDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.guardar(lineaId, dto, usuario.sub);
  }
}
