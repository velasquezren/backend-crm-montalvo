import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../prisma/prisma.service';
import { TareaPeriodica } from '../trabajos/tarea-periodica.decorator';

const ESPERA_MS = 10_000;

/**
 * El latido hacia un monitor externo de «interruptor de hombre muerto»
 * (healthchecks.io o el propio de Uptime Kuma, modo *push*): cada cinco minutos,
 * si la base responde, el CRM avisa que sigue vivo; si no, avisa `/fail`. Si el
 * proceso se cae, el VPS se apaga o el programador de tareas deja de correr, el
 * aviso no llega y es el monitor —desde fuera— quien alerta.
 *
 * Complementa, no reemplaza, un monitor que pida `GET /health` por la URL
 * pública: ese ve además Apache, TLS y el DNS. **Apagado sin `LATIDO_URL`.**
 * No manda nada de la clínica: una petición vacía a la URL del monitor.
 */
@Injectable()
export class LatidoService {
  private readonly logger = new Logger(LatidoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @TareaPeriodica({ nombre: 'latido-monitor', descripcion: 'latido al monitor externo', cron: '*/5 * * * *', cadaMs: 5 * 60 * 1000, limiteSegundos: 60 })
  async latir(): Promise<'VIVO' | 'FALLA' | 'APAGADO'> {
    const url = this.config.get<string>('LATIDO_URL')?.trim().replace(/\/+$/, '');
    if (!url) return 'APAGADO';
    let estado: 'VIVO' | 'FALLA' = 'VIVO';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      estado = 'FALLA';
    }
    try {
      await fetch(estado === 'VIVO' ? url : `${url}/fail`, { method: 'POST', signal: AbortSignal.timeout(ESPERA_MS) });
    } catch (error) {
      /* El monitor caído no es un fallo del CRM: lo verá él mismo como latido ausente. */
      this.logger.warn(`El latido no llegó al monitor: ${error instanceof Error ? error.name : 'error'}`);
    }
    return estado;
  }
}
