import { Module } from '@nestjs/common';

import { R2Service } from './r2.service';

/** Almacenamiento de archivos (Cloudflare R2). Lo consume ConversacionesModule. */
@Module({
  providers: [R2Service],
  exports: [R2Service],
})
export class StorageModule {}
