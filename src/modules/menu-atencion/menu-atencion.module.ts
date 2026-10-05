import { Module } from '@nestjs/common';

import { MenuAtencionController } from './menu-atencion.controller';
import { MenuAtencionService } from './menu-atencion.service';

@Module({
  controllers: [MenuAtencionController],
  providers: [MenuAtencionService],
  exports: [MenuAtencionService],
})
export class MenuAtencionModule {}
