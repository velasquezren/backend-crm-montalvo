import { Global, Module } from '@nestjs/common';

import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/** Global: cualquier módulo de dominio puede inyectar AuditService (RF-19). */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
