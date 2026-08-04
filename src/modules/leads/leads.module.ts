import { Module } from '@nestjs/common';

import { MetaSignatureGuard } from '../../common/guards/meta-signature.guard';
import { ClientesModule } from '../clientes/clientes.module';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { MetaWebhookController } from './webhooks/meta-webhook.controller';

@Module({
  imports: [ClientesModule],
  controllers: [LeadsController, MetaWebhookController],
  providers: [LeadsService, MetaSignatureGuard],
  exports: [LeadsService],
})
export class LeadsModule {}
