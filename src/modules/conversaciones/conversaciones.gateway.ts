import {  } from '@nestjs/common';
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

  constructor(
    private readonly jwtService: JwtService,
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
   * Algo cambió en esta conversación: que las pestañas abiertas se refresquen.
   *
   * Es barato y silencioso, así que lo llama TODO —el agente que envía, el
   * acuse de entrega de Meta, la media que termina de subir—. Por eso **no
   * manda notificación push**: ver `notificarEntrante`.
   */
  emitirActividad(conversacionId: string): void {
    this.server?.emit('conversacion:actividad', { conversacionId });
  }

  /**
   * Llegó un mensaje **del paciente**: refresca y además avisa al teléfono.
   *
   * Separado de `emitirActividad` a propósito. Estaban fundidos, y como los
   * ocho puntos que refrescan el inbox pasaban por ahí, cada tilde de entrega
   * de Meta, cada envío de la propia agente y hasta el acuse automático de
   * madrugada disparaban un push a todos los dispositivos suscritos. Una
   * notificación que suena cuando no ha pasado nada se desactiva en una semana,
   * y entonces tampoco suena la que sí importaba.
   *
   * Con dueña, solo a ella; sin dueña, la conversación está en el pool y le
   * toca a quien la agarre primero.
   */
  notificarEntrante(
    conversacionId: string,
    info: { clienteNombre?: string; texto?: string; agenteId?: string | null },
  ): void {
    this.emitirActividad(conversacionId);

    const aviso = {
      titulo: info.clienteNombre ? `WhatsApp: ${info.clienteNombre}` : 'Mensaje de WhatsApp',
      mensaje: resumir(info.texto) ?? 'Tienes un mensaje nuevo',
      url: `/conversaciones?id=${conversacionId}`,
      /* Mismo `tag` por conversación: cinco mensajes seguidos reemplazan la
         notificación anterior en vez de apilar cinco en la pantalla. */
      tag: `chat-${conversacionId}`,
    };

    void (info.agenteId
      ? this.pushService.enviarAUsuario(info.agenteId, aviso)
      : this.pushService.enviarATodosLosAgentes(aviso));
  }

  /**
   * Un recordatorio de `Actividad` entró en la ventana de aviso (ver
   * `ActividadesService.barrerRecordatoriosPendientes`). Broadcast global,
   * igual que `emitirActividad`: la seguridad real la pone el REST escopado
   * cuando el frontend pida el detalle (`GET /actividades/:id`), esto es
   * solo el "algo pasó". `agenteId` viaja para que el frontend descarte sin
   * pedir nada si el aviso no es suyo — ninguna otra agente necesita hacer
   * un fetch (aunque fallaría en 404) por cada recordatorio ajeno.
   *
   * Este gateway ya no es solo de Conversaciones — es el canal `/realtime`
   * compartido de toda la sesión (un socket, todo lo que empuja el backend).
   * Se queda en este módulo por ahora: moverlo de carpeta es un refactor
   * aparte y lo que importa de verdad es que sea UN solo socket compartido,
   * no dos conexiones por pestaña.
   */
  emitirRecordatorioActividad(actividadId: string, agenteId: string): void {
    this.server?.emit('actividad:recordatorio', { actividadId, agenteId });
  }
}

/** Primera línea del mensaje, acotada a lo que cabe en una notificación. */
function resumir(texto: string | undefined): string | undefined {
  const limpio = texto?.trim();
  if (!limpio) return undefined;
  return limpio.length > 80 ? `${limpio.slice(0, 80)}…` : limpio;
}
