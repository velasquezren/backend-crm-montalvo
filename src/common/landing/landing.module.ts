import { Module } from '@nestjs/common';

import { AvisoLandingService } from './aviso-landing.service';

/** El aviso a la landing pública. Lo consumen Promociones y Directorio. */
@Module({
  providers: [AvisoLandingService],
  exports: [AvisoLandingService],
})
export class LandingModule {}
