import { Logger, UnauthorizedException } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { PushService } from '../../common/push/push.service';
import { AuthService } from '../auth/auth.service';
import { AccesoAutenticado } from '../auth/credencial';

const ORIGENES_PERMITIDOS = (process.env.CORS_ORIGINS ?? 'http://localhost:4200')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

@WebSocketGateway({
  namespace: '/realtime',
  cors: { origin: ORIGENES_PERMITIDOS, credentials: true },
})
export class ConversacionesGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private server!: Namespace;
  private readonly logger = new Logger(ConversacionesGateway.name);
  private readonly sesiones = new Map<string, { acceso: AccesoAutenticado; timer?: NodeJS.Timeout }>();

  constructor(
    private readonly authService: AuthService,
    private readonly pushService: PushService,
  ) {}

  /** Middleware: la conexión no se acepta mientras se consulta la sesión. */
  afterInit(server: Namespace): void {
    server.use((client, next) => {
      const token: unknown = client.handshake.auth?.['token'];
      void this.authService.validarAcceso(typeof token === 'string' ? token : '').then(acceso => {
        if (client.conn.readyState === 'closed') return;
        this.sesiones.set(client.id, { acceso });
        next();
      }).catch((error: unknown) => {
        const invalida = error instanceof UnauthorizedException;
        next(Object.assign(new Error(invalida ? 'Sesión inválida o expirada' : 'No se pudo comprobar la sesión'), {
          data: { status: invalida ? 401 : 503 },
        }));
      });
    });
  }

  handleConnection(client: Socket): void {
    const sesion = this.sesiones.get(client.id);
    if (!sesion || sesion.acceso.exp * 1000 <= Date.now()) { client.disconnect(true); return; }
    sesion.timer = setTimeout(() => client.disconnect(true), sesion.acceso.exp * 1000 - Date.now());
    sesion.timer.unref();
  }

  handleDisconnect(client: Socket): void {
    clearTimeout(this.sesiones.get(client.id)?.timer);
    this.sesiones.delete(client.id);
  }

  private async emitirAutenticados(evento: string, payload: object): Promise<void> {
    if (!this.server) return;
    const clientes = [...this.server.sockets.values()];
    const accesos = clientes.flatMap(c => {
      const sesion = this.sesiones.get(c.id);
      return sesion ? [sesion.acceso] : [];
    });
    const vigentes = await this.authService.accesosVigentes(accesos);
    for (const client of clientes) {
      const acceso = this.sesiones.get(client.id)?.acceso;
      if (!acceso || !vigentes.has(acceso) || acceso.exp * 1000 <= Date.now()) client.disconnect(true);
      else if (client.connected) client.emit(evento, payload);
    }
  }

  private difundir(evento: string, payload: object): void {
    void this.emitirAutenticados(evento, payload).catch(() => {
      // Si la base falla no se difunde; tampoco se declara inválida la sesión.
      this.logger.warn('No se pudo validar las sesiones para difundir un evento');
    });
  }

  /**
   * Algo cambió en esta conversación: que las pestañas abiertas se refresquen.
   *
   * Es barato y silencioso, así que lo llama TODO —el agente que envía, el
   * acuse de entrega de Meta, la media que termina de subir—. Por eso **no
   * manda notificación push**: ver `notificarEntrante`.
   */
  emitirActividad(conversacionId: string): void {
    this.difundir('conversacion:actividad', { conversacionId });
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
    this.difundir('actividad:recordatorio', { actividadId, agenteId });
  }
}

/** Primera línea del mensaje, acotada a lo que cabe en una notificación. */
function resumir(texto: string | undefined): string | undefined {
  const limpio = texto?.trim();
  if (!limpio) return undefined;
  return limpio.length > 80 ? `${limpio.slice(0, 80)}…` : limpio;
}
