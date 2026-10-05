import { LineasWhatsappService } from '../lineas-whatsapp/lineas-whatsapp.service';
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
    private readonly lineas: LineasWhatsappService,
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

  /**
   * Emite a cada socket con sesión vigente que pase `aQuien`, con el payload
   * que le toca a ESA usuaria.
   *
   * El payload es por usuaria porque un mismo mensaje de la paciente no es lo
   * mismo para todas: a quien silenció la línea le llega el refresco de la
   * bandeja sin la marca `entrante`, que es la que hace sonar la pestaña. Así
   * el push y el aviso en pantalla obedecen a la misma regla —`audiencia`— en
   * vez de a dos que acabarían divergiendo.
   */
  private async emitirAutenticados(
    evento: string,
    aQuien: (acceso: AccesoAutenticado) => boolean,
    payloadPara: (usuarioId: string) => object,
  ): Promise<void> {
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
      else if (client.connected && aQuien(acceso)) client.emit(evento, payloadPara(acceso.sub));
    }
  }

  /**
   * Algo cambió en esta conversación: que las pestañas abiertas se refresquen.
   *
   * Es barato y silencioso, así que lo llama TODO —el agente que envía, el
   * acuse de entrega de Meta, la media que termina de subir—. Por eso **no
   * manda notificación push**: ver `notificarEntrante`.
   *
   * La audiencia se calcula DESPUÉS del cambio. Si el cambio saca la conversación
   * de la vista de alguien (una agente reclama un chat del pool y las demás dejan
   * de verlo), esa persona ya no está en la audiencia y se quedaría con la fila
   * vieja hasta el refresco de respaldo: `tambienA` es para avisarle a ella —
   * `quienesVen` ANTES de aplicar el cambio—. Su refresco recibe `null` y la quita.
   */
  /** Quién ve la conversación ahora mismo: tómalo antes de un cambio que pueda sacarla de la vista de alguien. */
  quienesVen(conversacionId: string): Promise<string[]> {
    return this.lineas.destinatarios(conversacionId);
  }

  emitirActividad(conversacionId: string, tambienA: readonly string[] = []): void {
    void this.lineas.destinatarios(conversacionId)
      .then(ven => {
        const alcanzadas = new Set([...ven, ...tambienA]);
        return this.emitirAutenticados('conversacion:actividad', a => alcanzadas.has(a.sub), () => ({ conversacionId }));
      })
      .catch(() => this.logger.warn('No se pudo difundir la conversación'));
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
   * toca a quien la agarre primero — salvo a quien silenció esa línea, que la
   * sigue viendo llegar sin que le suene. Ver `LineasWhatsappService.audiencia`.
   */
  notificarEntrante(
    conversacionId: string,
    info: { clienteNombre?: string; texto?: string },
  ): void {
    const aviso = {
      titulo: info.clienteNombre ? `WhatsApp: ${info.clienteNombre}` : 'Mensaje de WhatsApp',
      mensaje: resumir(info.texto) ?? 'Tienes un mensaje nuevo',
      url: `/conversaciones?id=${conversacionId}`,
      /* Mismo `tag` por conversación: cinco mensajes seguidos reemplazan la
         notificación anterior en vez de apilar cinco en la pantalla. */
      tag: `chat-${conversacionId}`,
      /* Hay una paciente esperando: que atraviese el ahorro de batería. La
         vigencia es la de por defecto, una hora — después la bandeja ya lo
         muestra y el aviso tarde solo es ruido. */
      entrega: { urgente: true },
    };

    /* Una sola consulta de audiencia para las dos salidas. `ven` recibe el
       refresco de la bandeja; solo `avisar` recibe la marca que hace sonar la
       pestaña y el push al teléfono. Van por separado para que un fallo en una
       no se lleve la otra: sin socket, el teléfono aún debe sonar. */
    void this.lineas.audiencia(conversacionId).then(({ ven, avisar }) => {
      const alcanzadas = new Set(ven);
      const suenan = new Set(avisar);
      void this.emitirAutenticados(
        'conversacion:actividad',
        a => alcanzadas.has(a.sub),
        sub => ({ conversacionId, ...(suenan.has(sub) ? { entrante: true } : {}) }),
      ).catch(() => this.logger.warn('No se pudo difundir la conversación'));

      void (async () => {
        for (let i = 0; i < avisar.length; i += 5) {
          await Promise.all(avisar.slice(i, i + 5).map(id => this.pushService.enviarAUsuario(id, aviso)));
        }
      })().catch(() => this.logger.warn('No se pudo notificar la conversación'));
    }).catch(() => this.logger.warn('No se pudo calcular quién recibe la conversación'));
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
    void this.emitirAutenticados('actividad:recordatorio', a => a.sub === agenteId, () => ({ actividadId, agenteId }))
      .catch(() => this.logger.warn('No se pudo difundir el recordatorio'));
  }
}

/** Primera línea del mensaje, acotada a lo que cabe en una notificación. */
function resumir(texto: string | undefined): string | undefined {
  const limpio = texto?.trim();
  if (!limpio) return undefined;
  return limpio.length > 80 ? `${limpio.slice(0, 80)}…` : limpio;
}
