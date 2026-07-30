import { Controller, Get, Param, Post, Query } from '@nestjs/common';

import { alcanceAgente } from '../../common/auth/roles';
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
    // Un agente solo ve lo suyo; admin y super admin ven todo el equipo.
    query.agenteId = alcanceAgente(usuario) ?? query.agenteId;
    return this.comisionesService.findAll(query);
  }

  @Post(':id/pagar')
  @Roles('ADMIN')
  marcarPagada(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.comisionesService.marcarPagada(id, usuario.sub);
  }
}
