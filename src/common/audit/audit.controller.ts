import { Controller, Get, Param } from '@nestjs/common';

import { Roles } from '../decorators/roles.decorator';
import { AuditService } from './audit.service';

/** RF-20 — un admin puede ver el historial de cambios de cualquier registro crítico. */
@Controller('auditoria')
@Roles('ADMIN')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get(':entidad/:entidadId')
  historial(@Param('entidad') entidad: string, @Param('entidadId') entidadId: string) {
    return this.auditService.historial(entidad, entidadId);
  }
}
