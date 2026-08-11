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
import { PushService } from '../../common/push/push.service';

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
    private readonly pushService: PushService,
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
   * Notifica a todos los agentes conectados por WebSocket + dispara Web Push
   * Notification (VAPID) en segundo plano por si el navegador o PWA está cerrado.
   */
  emitirActividad(
    conversacionId: string,
    info?: { clienteNombre?: string; texto?: string; agenteId?: string | null },
  ): void {
    if (this.server) {
      this.server.emit('conversacion:actividad', { conversacionId });
    }

    const titulo = info?.clienteNombre ? `WhatsApp: ${info.clienteNombre}` : 'Mensaje de WhatsApp';
    const mensaje = info?.texto ? (info.texto.length > 80 ? `${info.texto.substring(0, 80)}…` : info.texto) : 'Tienes una actualización en el CRM';

    if (info?.agenteId) {
      void this.pushService.enviarAUsuario(info.agenteId, {
        titulo,
        mensaje,
        url: `/conversaciones?id=${conversacionId}`,
        tag: `chat-${conversacionId}`,
      });
    } else {
      void this.pushService.enviarATodosLosAgentes({
        titulo,
        mensaje,
        url: `/conversaciones?id=${conversacionId}`,
        tag: `chat-${conversacionId}`,
      });
    }
  }
}
