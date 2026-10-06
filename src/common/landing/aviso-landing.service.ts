import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { enSegundoPlano } from '../fiabilidad/en-segundo-plano';

/** Las partes de la landing que se pueden renovar por separado (`app/api/revalidar` del repo de la landing). */
export type EtiquetaLanding = 'promociones' | 'directorio';

/** Un mismo gesto (subir tres banners, guardar ficha y horario) se avisa una sola vez. */
const ESPERA_AGRUPAR_MS = 1_500;
/** La landing responde en milisegundos; si tarda más, se renovará sola por tiempo. */
const ESPERA_RESPUESTA_MS = 5_000;

/**
 * Avisa a la landing (Next.js en Vercel) de que cambió algo que publica, para
 * que deje de servir lo que tenía guardado: una promoción pausada por un
 * precio mal escrito desaparece al instante, no a los cinco minutos.
 *
 * Es un aviso, no una dependencia: nunca bloquea ni hace fallar la edición que
 * lo provoca. Si la landing no responde, sus páginas se renuevan solas cada
 * cinco minutos (`REVALIDAR_SEGUNDOS` en la landing), así que perder un aviso
 * solo retrasa el cambio, no lo pierde.
 *
 * Sin `LANDING_REVALIDAR_URL` y `LANDING_REVALIDAR_SECRETO` queda apagado,
 * igual que R2 o WhatsApp sin sus credenciales.
 */
@Injectable()
export class AvisoLandingService implements OnModuleDestroy {
  private readonly logger = new Logger(AvisoLandingService.name);
  private readonly url: string | null;
  private readonly secreto: string | null;
  private readonly pendientes = new Set<EtiquetaLanding>();
  private temporizador: NodeJS.Timeout | null = null;

  constructor(config: ConfigService) {
    this.url = config.get<string>('LANDING_REVALIDAR_URL')?.trim() || null;
    this.secreto = config.get<string>('LANDING_REVALIDAR_SECRETO')?.trim() || null;
  }

  get habilitado(): boolean {
    return this.url !== null && this.secreto !== null;
  }

  /** Programa el aviso; vuelve enseguida. Se llama después de guardar, nunca dentro de la transacción. */
  avisar(...etiquetas: EtiquetaLanding[]): void {
    if (!this.habilitado || etiquetas.length === 0) return;
    for (const etiqueta of etiquetas) this.pendientes.add(etiqueta);
    if (this.temporizador) return;
    this.temporizador = setTimeout(() => enSegundoPlano('aviso a la landing', this.logger, () => this.enviar()), ESPERA_AGRUPAR_MS);
    // Un aviso pendiente no mantiene vivo el proceso al apagarlo.
    this.temporizador.unref();
  }

  /** Al apagar, lo pendiente sale ya: un reinicio por despliegue no se come el último cambio. */
  async onModuleDestroy(): Promise<void> {
    if (!this.temporizador) return;
    clearTimeout(this.temporizador);
    await this.enviar();
  }

  private async enviar(): Promise<void> {
    this.temporizador = null;
    const etiquetas = [...this.pendientes];
    this.pendientes.clear();
    if (etiquetas.length === 0 || !this.url || !this.secreto) return;
    try {
      const respuesta = await fetch(this.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.secreto}`, 'content-type': 'application/json' },
        body: JSON.stringify({ etiquetas }),
        signal: AbortSignal.timeout(ESPERA_RESPUESTA_MS),
      });
      if (!respuesta.ok) {
        this.logger.warn(`La landing respondió ${respuesta.status} al aviso de ${etiquetas.join(', ')}: se renovará sola en minutos.`);
      }
    } catch (error) {
      const motivo = error instanceof Error ? error.message : String(error);
      this.logger.warn(`No se pudo avisar a la landing (${etiquetas.join(', ')}): ${motivo}. Se renovará sola en minutos.`);
    }
  }
}
