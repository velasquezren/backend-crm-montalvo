import { IsOptional, IsUUID } from 'class-validator';

/** DTO para asignar/desasignar agente a una conversación. agenteId = null desasigna. */
export class AsignarAgenteDto {
  @IsUUID()
  @IsOptional()
  /* `!` porque quien la rellena es el ValidationPipe, no un constructor. Es el
     mismo motivo por el que `@WebSocketServer() private server!: Server` lo lleva.
     Sin él, `strictPropertyInitialization` no puede distinguir un DTO de una
     clase a medio construir. */
  agenteId!: string | null;
}
