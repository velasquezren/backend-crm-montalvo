import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { ServiciosController } from './servicios.controller';
import { ServiciosService } from './servicios.service';

/** Historial de servicios. Solo lectura: no exporta el service porque nadie más lo consume. */
@Module({
  imports: [PrismaModule],
  controllers: [ServiciosController],
  providers: [ServiciosService],
})
export class ServiciosModule {}
