import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

/**
 * ConversacionesGateway — RF-09/RF-10, empuje en tiempo real.
 *
 * Antes, el inbox solo se refrescaba por polling cada 15s (ver
 * `conversaciones.page.ts`): un mensaje nuevo tardaba hasta 15s en aparecer.
 * Este gateway avisa a los clientes conectados en cuanto se crea un mensaje
 * (entrante por webhook o saliente por un agente), para que disparen un
 * reload dirigido en vez de esperar el próximo tick del polling.
 *
 * El payload es deliberadamente mínimo — solo `conversacionId` — nunca datos
 * del paciente: el contenido real se sigue trayendo por REST, que es donde
 * se aplica el escopado por rol. El socket es únicamente la señal de "algo
 * cambió", no un canal de datos.
 */
/* Mismo origen permitido que la API REST (ver main.ts). Se lee de `process.env`
   directo, no por ConfigService: los argumentos del decorador se evalúan al
   cargar el módulo, antes de que exista el contenedor de DI. */
const ORIGENES_PERMITIDOS = (process.env.CORS_ORIGINS ?? 'http://localhost:4200')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

@WebSocketGateway({
  namespace: '/realtime',
  cors: { origin: ORIGENES_PERMITIDOS, credentials: true },
})
export class ConversacionesGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private server!: Server;

  private readonly logger = new Logger(ConversacionesGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  /** Mismo JWT que la API REST — el token viaja en el handshake, no en la URL. */
  async handleConnection(client: Socket): Promise<void> {
    const token = client.handshake.auth?.['token'] as string | undefined;
    if (!token) {
      client.disconnect(true);
      return;
    }
    try {
      await this.jwtService.verifyAsync(token);
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect(): void {
    /* No hay estado de sesión que limpiar: la sala es global (ver nota abajo). */
  }

  /**
   * Notifica a todos los agentes conectados. No se segmenta por agente/rol
   * porque el payload no lleva datos — cada cliente decide, con el
   * `conversacionId`, si le importa (chat abierto o lista visible) y en tal
   * caso dispara su propio reload autenticado, que sí aplica el escopado.
   */
  emitirActividad(conversacionId: string): void {
    if (!this.server) {
      this.logger.warn('Gateway sin server adjunto todavía; se omite el push');
      return;
    }
    this.server.emit('conversacion:actividad', { conversacionId });
  }
}
