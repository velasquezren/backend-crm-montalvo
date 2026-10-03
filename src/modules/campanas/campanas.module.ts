import { Module } from '@nestjs/common';

import { ConversacionesModule } from '../conversaciones/conversaciones.module';
import { TipoCambioModule } from '../tipo-cambio/tipo-cambio.module';
import { AudienciasService } from './audiencias.service';
import { CampanasEnvioService } from './campanas-envio.service';
import { CampanasController } from './campanas.controller';
import { CampanasService } from './campanas.service';

/**
 * Campañas de Marketing por WhatsApp, de punta a punta: a quién (la
 * audiencia), qué se le manda y cómo va.
 *
 * - `AudienciasService`: quién recibiría una campaña hoy y por qué el resto
 *   no. Solo lee.
 * - `CampanasService`: congela una audiencia en una campaña y la controla
 *   (pausar, reanudar, cancelar), con sus métricas.
 * - `CampanasEnvioService`: el barrido que la manda, de a poco y en horario.
 *
 * La audiencia vivía en su propio módulo y su propia pantalla, pero no tiene
 * otro uso que armar una campaña: son un solo dominio. Nada se exporta;
 * nadie fuera de aquí necesita estas piezas.
 */
@Module({
  imports: [ConversacionesModule, TipoCambioModule],
  controllers: [CampanasController],
  providers: [AudienciasService, CampanasService, CampanasEnvioService],
})
export class CampanasModule {}
