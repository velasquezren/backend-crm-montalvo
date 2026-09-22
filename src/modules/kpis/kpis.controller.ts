import { Controller, Get, Query } from '@nestjs/common';

import { alcanceAgente } from '../../common/auth/roles';
import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { QueryKpisDto } from './dto/query-kpis.dto';
import { KpisService } from './kpis.service';

@Controller('kpis')
export class KpisController {
  constructor(private readonly kpisService: KpisService) {}

  /** Un agente ve sus propios números; un admin ve los globales (RF-16). */
  @Get('resumen')
  resumen(@Query() query: QueryKpisDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.kpisService.resumen(query.periodo ?? 'MES', alcanceAgente(usuario));
  }
}
