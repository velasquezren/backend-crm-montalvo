import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { enSegundoPlano } from '../../common/fiabilidad/en-segundo-plano';
import { PrismaService } from '../../prisma/prisma.service';

import { DespachadorSalienteService, proximoReintento } from './despachador-saliente.service';

const INTERVALO_BARRIDO_MS = 60 * 1000;

/** Cuántos mensajes como mucho se reintentan en un barrido. */
const TOPE_BARRIDO = 50;

/**
 * Cuántos se despachan a la vez. Mismo razonamiento —y mismo número— que el
 * barrido de recordatorios de Actividades: el VPS tiene un núcleo y 1,7 GB, y
 * este barrido comparte el pool de Prisma con las agentes. Soltar cincuenta
 * envíos de golpe no acelera el barrido: hace lento el chat que alguien está
 * abriendo.
 */
const CONCURRENCIA = 5;

/** La ventana de servicio al cliente de WhatsApp, en milisegundos. */
const VENTANA_CSW_MS = 24 * 60 * 60 * 1000;

/**
 * Vuelve a intentar los envíos que **constan** como no salidos.
 *
 * F06 entrega 2. La entrega 1 dejó los fallos visibles en el journal pero sin
 * recuperación: «un mensaje que no salió queda en FALLIDO y una agente lo
 * reintenta a mano». Esto automatiza exactamente la mitad segura de ese trabajo.
 *
 * **Solo la mitad segura, y esa es la regla que gobierna el archivo entero.**
 * Un mensaje en INCIERTO —la red se cayó con el POST ya viajando— no se toca
 * nunca desde aquí: pudo haber llegado, y reenviarlo sería duplicárselo a la
 * paciente. Ese caso lo resuelve el `statuses` de Meta, que vuelve con el
 * `biz_opaque_callback_data`; si no vuelve nunca, la fila queda a la vista para
 * que decida una persona. Aquí solo entra FALLIDO, que significa que Meta
 * rechazó el cuerpo o que ni siquiera se pudo salir a la red.
 *
 * Tres cosas que no son de estilo:
 *
 * 1. **Se reclama la fila con un UPDATE condicionado antes de despachar.** Dos
 *    barridos solapados —un `systemctl restart` a destiempo, un intervalo que
 *    se atrasa— leerían la misma fila y mandarían el mensaje dos veces. El
 *    `where` exige que `proximoIntento` siga vencido; de dos intentos
 *    concurrentes, exactamente uno afecta una fila. Es el mismo patrón de
 *    "reclamar del pool" que usa `enviarMensaje` con `agenteId: null`.
 * 2. **La reclamación agenda el turno siguiente**, y por eso el despacho lleva
 *    `reintento: true`: si el despachador volviera a agendar, el backoff se
 *    reiniciaría en cada vuelta y un mensaje muerto se reintentaría cada minuto
 *    para siempre.
 * 3. **Se comprueba la ventana de 24 h antes de gastar el intento.** Fuera de
 *    la CSW, Meta rechaza el texto libre pase lo que pase; insistir solo gasta
 *    cuota y llena el journal de errores que no dicen nada nuevo.
 */
@Injectable()
export class ReintentoSalienteService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReintentoSalienteService.name);
  private intervalo?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly despachador: DespachadorSalienteService,
  ) {}

  onModuleInit(): void {
    /* Igual que los otros dos barridos: la suite instancia los services a mano,
       esto es por si algún día alguien bootstrapea el módulo entero. */
    if (process.env.NODE_ENV === 'test') return;

    this.intervalo = setInterval(
      () =>
        void enSegundoPlano('barrido de reintentos de envío', this.logger, () =>
          this.barrerEnviosPendientes(),
        ),
      INTERVALO_BARRIDO_MS,
    );
    /* `.unref()` para no ser el motivo por el que el proceso sigue vivo. */
    this.intervalo.unref();
  }

  onModuleDestroy(): void {
    if (this.intervalo) clearInterval(this.intervalo);
  }

  /**
   * Expuesto (no `private`) para que la prueba pueda esperar su promesa — el
   * `setInterval` lo dispara con `void`, igual que los otros barridos.
   *
   * Devuelve cuántas filas se reclamaron, que no es lo mismo que cuántas
   * salieron: el resultado de cada envío lo anota el despachador.
   */
  async barrerEnviosPendientes(): Promise<number> {
    const ahora = new Date();

    const pendientes = await this.prisma.mensaje.findMany({
      where: { estadoEnvio: 'FALLIDO', proximoIntento: { lte: ahora } },
      select: {
        id: true,
        conversacionId: true,
        contenido: true,
        mediaKey: true,
        intentosEnvio: true,
        conversacion: { select: { cliente: { select: { telefono: true } } } },
      },
      orderBy: { proximoIntento: 'asc' },
      take: TOPE_BARRIDO,
    });

    if (pendientes.length === TOPE_BARRIDO) {
      /* Un tope que se alcanza significa envíos esperando otro minuto. Se avisa
         o el día que pase se descubre porque una paciente no recibió el suyo. */
      this.logger.warn(
        `El barrido de reintentos llegó al tope de ${TOPE_BARRIDO}; quedan envíos para la vuelta siguiente.`,
      );
    }

    let reclamados = 0;
    for (let i = 0; i < pendientes.length; i += CONCURRENCIA) {
      const tanda = pendientes.slice(i, i + CONCURRENCIA);
      const resultados = await Promise.all(tanda.map(m => this.reintentarUno(m, ahora)));
      reclamados += resultados.filter(Boolean).length;
    }
    return reclamados;
  }

  /** Un try/catch POR ELEMENTO: que un mensaje reviente no se lleva la tanda. */
  private async reintentarUno(
    mensaje: {
      id: string;
      conversacionId: string;
      contenido: string;
      mediaKey: string | null;
      intentosEnvio: number;
      conversacion: { cliente: { telefono: string } };
    },
    ahora: Date,
  ): Promise<boolean> {
    try {
      const intentos = mensaje.intentosEnvio + 1;
      const { count } = await this.prisma.mensaje.updateMany({
        /* La reclamación. Ver la nota 1 de la cabecera. */
        where: { id: mensaje.id, estadoEnvio: 'FALLIDO', proximoIntento: { lte: ahora } },
        data: { intentosEnvio: intentos, proximoIntento: proximoReintento(intentos, ahora) },
      });
      if (count === 0) return false; // otro barrido se lo llevó, o ya se resolvió

      if (!(await this.ventanaAbierta(mensaje.conversacionId, ahora))) {
        await this.prisma.mensaje.updateMany({
          where: { id: mensaje.id },
          data: { proximoIntento: null },
        });
        this.logger.warn(
          `Mensaje ${mensaje.id}: se deja de reintentar, la ventana de 24 h está cerrada. Hace falta una plantilla.`,
        );
        return false;
      }

      await this.despachador.texto(
        {
          mensajeId: mensaje.id,
          conversacionId: mensaje.conversacionId,
          telefono: mensaje.conversacion.cliente.telefono,
          reintento: true,
        },
        mensaje.contenido,
        mensaje.mediaKey ?? undefined,
      );
      return true;
    } catch (error) {
      this.logger.error(`Falló el reintento del mensaje ${mensaje.id}`, error);
      return false;
    }
  }

  /**
   * ¿Sigue abierta la ventana de servicio al cliente?
   *
   * Se mide desde el último mensaje **ENTRANTE**, que es lo que la abre — no
   * desde el último de la conversación, que suele ser nuestro. Es el mismo
   * cálculo que hace `verificarVentana24h` antes de dejar escribir a la agente;
   * está aquí y no llamando a `ConversacionesService` para no cerrar un ciclo
   * entre los dos servicios, y ambos leen la misma tabla del mismo dominio.
   *
   * La ventana de 72 h del Free Entry Point no cuenta: solo habilita plantillas
   * sin costo, nunca texto libre.
   */
  private async ventanaAbierta(conversacionId: string, ahora: Date): Promise<boolean> {
    const ultimoEntrante = await this.prisma.mensaje.findFirst({
      where: { conversacionId, direccion: 'ENTRANTE' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    return (
      ultimoEntrante !== null &&
      ahora.getTime() - ultimoEntrante.createdAt.getTime() < VENTANA_CSW_MS
    );
  }
}
