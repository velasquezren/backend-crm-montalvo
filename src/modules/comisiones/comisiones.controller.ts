import { Controller, Get, Param, Post, Query } from '@nestjs/common';

import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ComisionesService } from './comisiones.service';
import { QueryComisionDto } from './dto/query-comision.dto';

@Controller('comisiones')
export class ComisionesController {
  constructor(private readonly comisionesService: ComisionesService) {}

  /**
   * Un agente solo ve sus propias comisiones; un admin ve todas (RF-14/RF-15).
   * El filtro por agenteId del query solo aplica para admins.
   */
  @Get()
  findAll(@Query() query: QueryComisionDto, @CurrentUser() usuario: UsuarioJwt) {
    if (usuario.rol !== 'ADMIN') {
      query.agenteId = usuario.sub;
    }
    return this.comisionesService.findAll(query);
  }

  @Post(':id/pagar')
  @Roles('ADMIN')
  marcarPagada(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.comisionesService.marcarPagada(id, usuario.sub);
  }
}
