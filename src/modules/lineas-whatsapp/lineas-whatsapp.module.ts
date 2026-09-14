import { Module } from "@nestjs/common";
import { LineasWhatsappService } from "./lineas-whatsapp.service";
import { LineasWhatsappController } from "./lineas-whatsapp.controller";
@Module({
  controllers: [LineasWhatsappController],
  providers: [LineasWhatsappService],
  exports: [LineasWhatsappService],
})
export class LineasWhatsappModule {}
