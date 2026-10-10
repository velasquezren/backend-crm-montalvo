import { Module } from '@nestjs/common';

import { StorageModule } from '../../common/storage/storage.module';
import { AgendaModule } from '../agenda/agenda.module';
import { AsistenteLineasService } from './asistente-lineas.service';
import { AsistenteController } from './asistente.controller';
import { ConversacionAsistente } from './conversacion-asistente';
import { HerramientasAsistenteService } from './herramientas';
import { ImagenHorarioService } from './imagen-horario.service';
import { ClasificadorMensajes, LectorComprobantes, ModeloConversacional } from './modelo.port';
import { ClasificadorVertex, ClienteVertex, ConfiguracionIA, LectorVertex, ModeloVertex } from './vertex/proveedor-vertex';

/**
 * El asistente de IA (docs/asistente-ia.md): el proveedor, el catálogo, el
 * bucle y la configuración por línea. No conoce los chats: quien lo usa en una
 * conversación es `AsistenteChatService`, en Conversaciones, que es el dueño de
 * los mensajes y de los automáticos.
 *
 * Los puertos (`ModeloConversacional`, …) se cablean a Vertex aquí y en ningún
 * otro sitio: cambiar de proveedor es cambiar estas tres líneas.
 */
@Module({
  imports: [AgendaModule, StorageModule],
  controllers: [AsistenteController],
  providers: [
    ConfiguracionIA,
    ClienteVertex,
    { provide: ModeloConversacional, useClass: ModeloVertex },
    { provide: ClasificadorMensajes, useClass: ClasificadorVertex },
    { provide: LectorComprobantes, useClass: LectorVertex },
    HerramientasAsistenteService,
    ConversacionAsistente,
    ImagenHorarioService,
    AsistenteLineasService,
  ],
  exports: [ConversacionAsistente, ModeloConversacional, ClasificadorMensajes, LectorComprobantes, ImagenHorarioService, AsistenteLineasService],
})
export class AsistenteModule {}
