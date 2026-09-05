import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PushSubscription, Rol } from '../../prisma/prisma-client';
import * as webpush from 'web-push';

import { PrismaService } from '../../prisma/prisma.service';
import { SuscribirPushDto } from './dto/suscribir-push.dto';

export interface PushNotificationPayload {
  titulo: string;
  mensaje: string;
  url?: string;
  tag?: string;
  count?: number;
}

/**
 * Notificaciones Web Push (VAPID) al teléfono de las agentes.
 *
 * Sin `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` en el `.env` la función queda
 * **apagada**, igual que R2 y que WhatsApp Cloud. Antes se generaba un par de
 * llaves en memoria al arrancar, y eso es peor que no funcionar: las llaves
 * cambian en cada `systemctl restart`, y una suscripción creada con las
 * anteriores deja de servir sin que nadie se entere. Las agentes verían el
 * permiso concedido en el navegador y no volverían a recibir nada.
 */
@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private publicKey = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const publica = this.config.get<string>('VAPID_PUBLIC_KEY')?.trim();
    const privada = this.config.get<string>('VAPID_PRIVATE_KEY')?.trim();
    const subject =
      this.config.get<string>('VAPID_SUBJECT')?.trim() || 'mailto:soporte@clinicamontalvo.com';

    if (!publica || !privada) {
      this.logger.warn(
        'VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY ausentes: las notificaciones push quedan desactivadas. ' +
          'Genera un par con `npx web-push generate-vapid-keys` y añádelas al .env.',
      );
      return;
    }

    try {
      webpush.setVapidDetails(subject, publica, privada);
      this.publicKey = publica;
    } catch (error) {
      /* Llaves con formato inválido. Se deja apagado en vez de arrancar a
         medias: `sendNotification` fallaría en cada mensaje entrante. */
      this.logger.error('Llaves VAPID inválidas: las notificaciones push quedan desactivadas', error);
    }
  }

  /** `false` mientras no haya llaves válidas configuradas. */
  get habilitado(): boolean {
    return this.publicKey !== '';
  }

  /** Clave pública para `PushManager.subscribe()`. Vacía = función apagada. */
  getPublicKey(): { publicKey: string } {
    return { publicKey: this.publicKey };
  }

  async guardarSuscripcion(usuarioId: string, sub: SuscribirPushDto): Promise<{ ok: boolean }> {
    /* Una suscripción puede cambiar de dueña: el navegador la reutiliza y en un
       equipo compartido de recepción entra otra agente. `endpoint` es único, así
       que el upsert la reasigna en vez de reventar contra el índice. */
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: {
        usuarioId,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
      },
      update: {
        usuarioId,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
      },
    });

    return { ok: true };
  }

  /** Baja pedida por la usuaria: solo puede borrar las suyas. */
  async eliminarSuscripcionPropia(usuarioId: string, endpoint: string): Promise<{ ok: boolean }> {
    const { count } = await this.prisma.pushSubscription.deleteMany({
      where: { endpoint, usuarioId },
    });
    return { ok: count > 0 };
  }

  async enviarAUsuario(usuarioId: string, payload: PushNotificationPayload): Promise<void> {
    if (!this.habilitado) return;
    await this.despachar(
      await this.prisma.pushSubscription.findMany({ where: { usuarioId } }),
      payload,
    );
  }

  /** Para las conversaciones del pool: le toca a quien la agarre primero. */
  async enviarATodosLosAgentes(payload: PushNotificationPayload): Promise<void> {
    if (!this.habilitado) return;
    await this.despachar(await this.prisma.pushSubscription.findMany(), payload);
  }

  /**
   * Solo a quien puede hacer algo al respecto.
   *
   * Para avisos de plataforma —una restricción de Meta, una plantilla
   * rechazada—: despertar a toda la recepción con algo que solo un admin puede
   * resolver es la vía rápida a que se apaguen las notificaciones.
   *
   * El filtro va por la relación desde `pushSubscription`, así que este servicio
   * sigue consultando su propia tabla y no la de otro dominio.
   */
  async enviarAAdmins(payload: PushNotificationPayload): Promise<void> {
    if (!this.habilitado) return;
    await this.despachar(
      await this.prisma.pushSubscription.findMany({
        where: { usuario: { rol: { in: [Rol.ADMIN, Rol.SUPER_ADMIN] }, activo: true } },
      }),
      payload,
    );
  }

  /**
   * Manda el aviso a cada dispositivo y limpia los que ya no existen.
   *
   * Un 404/410 del servicio de push significa que la suscripción murió —el
   * navegador se desinstaló, la PWA se borró, el permiso se revocó—: se elimina
   * ahí mismo, o la tabla se llena de destinos muertos que se reintentan para
   * siempre. Cualquier otro error se registra y no se toca nada: puede ser un
   * corte transitorio y borrar por eso dejaría a la agente sin notificaciones.
   *
   * Nada de aquí lanza: esto corre en segundo plano detrás de un webhook que ya
   * respondió, y un fallo notificando no puede perder el mensaje de la paciente.
   */
  private async despachar(
    subs: PushSubscription[],
    payload: PushNotificationPayload,
  ): Promise<void> {
    if (subs.length === 0) return;
    const cuerpo = JSON.stringify(payload);

    await Promise.all(
      subs.map(async sub => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            cuerpo,
          );
        } catch (err: unknown) {
          const error = err as { statusCode?: number; message?: string };
          if (error.statusCode === 404 || error.statusCode === 410) {
            await this.prisma.pushSubscription
              .deleteMany({ where: { endpoint: sub.endpoint } })
              .catch(() => undefined);
            return;
          }
          this.logger.warn(
            `No se pudo notificar a ${sub.endpoint}: ${error.message ?? String(err)}`,
          );
        }
      }),
    );
  }
}
