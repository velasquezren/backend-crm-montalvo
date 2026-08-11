import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';
import { PrismaService } from '../../prisma/prisma.service';

export interface PushNotificationPayload {
  titulo: string;
  mensaje: string;
  url?: string;
  tag?: string;
  count?: number;
}

@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private publicKey = '';
  private privateKey = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const envPublic = this.config.get<string>('VAPID_PUBLIC_KEY');
    const envPrivate = this.config.get<string>('VAPID_PRIVATE_KEY');
    const subject = this.config.get<string>('VAPID_SUBJECT') ?? 'mailto:soporte@clinicamontalvo.com';

    if (envPublic && envPrivate) {
      this.publicKey = envPublic;
      this.privateKey = envPrivate;
    } else {
      // Si no están configuradas en .env, genera llaves VAPID en memoria para inicio directo
      const keys = webpush.generateVAPIDKeys();
      this.publicKey = keys.publicKey;
      this.privateKey = keys.privateKey;
      this.logger.log('Llaves VAPID generadas automáticamente para Web Push.');
    }

    try {
      webpush.setVapidDetails(subject, this.publicKey, this.privateKey);
    } catch (error) {
      this.logger.error('Error al inicializar VAPID Web Push', error);
    }
  }

  getPublicKey(): { publicKey: string } {
    return { publicKey: this.publicKey };
  }

  async guardarSuscripcion(
    usuarioId: string,
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  ): Promise<{ ok: boolean }> {
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      return { ok: false };
    }

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

  async eliminarSuscripcion(endpoint: string): Promise<void> {
    try {
      await this.prisma.pushSubscription.delete({ where: { endpoint } });
    } catch {
      // Ignorar si no existe
    }
  }

  async enviarAUsuario(usuarioId: string, payload: PushNotificationPayload): Promise<void> {
    const subs = await this.prisma.pushSubscription.findMany({
      where: { usuarioId },
    });

    if (subs.length === 0) return;

    const dataString = JSON.stringify(payload);

    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            dataString,
          );
        } catch (err: any) {
          // Si la suscripción expiró o ya no es válida (404/410), se elimina de la BD
          if (err?.statusCode === 404 || err?.statusCode === 410) {
            await this.eliminarSuscripcion(sub.endpoint);
          } else {
            this.logger.warn(`Error al enviar push notification a ${sub.endpoint}: ${err?.message}`);
          }
        }
      }),
    );
  }

  async enviarATodosLosAgentes(payload: PushNotificationPayload): Promise<void> {
    const subs = await this.prisma.pushSubscription.findMany({});
    if (subs.length === 0) return;

    const dataString = JSON.stringify(payload);

    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            dataString,
          );
        } catch (err: any) {
          if (err?.statusCode === 404 || err?.statusCode === 410) {
            await this.eliminarSuscripcion(sub.endpoint);
          }
        }
      }),
    );
  }
}
