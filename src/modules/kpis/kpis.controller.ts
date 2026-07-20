import { Controller, Get, Query } from '@nestjs/common';

import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { KpisService } from './kpis.service';

@Controller('kpis')
export class KpisController {
  constructor(private readonly kpisService: KpisService) {}

  /** Un agente ve sus propios números; un admin ve los globales (RF-16). */
  @Get('resumen')
  resumen(
    @CurrentUser() usuario: UsuarioJwt,
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
  ) {
    const soloAgenteId = usuario.rol === 'ADMIN' ? undefined : usuario.sub;
    return this.kpisService.resumen(desde, hasta, soloAgenteId);
  }
}
