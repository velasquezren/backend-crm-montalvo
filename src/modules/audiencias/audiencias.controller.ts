import { Controller, Get, Query } from '@nestjs/common';

import { Roles } from '../../common/decorators/roles.decorator';
import { AudienciasService } from './audiencias.service';
import { QueryAudienciaDto } from './dto/query-audiencia.dto';

@Controller('audiencias')
@Roles('ADMIN')
export class AudienciasController {
  constructor(private readonly audiencias: AudienciasService) {}

  /** Quiénes recibirían una campaña hoy, con el embudo de por qué el resto no. */
  @Get()
  segmentar(@Query() query: QueryAudienciaDto) {
    return this.audiencias.segmentar(query);
  }
}
