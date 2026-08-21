import { Controller, Get, HttpCode, HttpStatus, Logger, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { Public } from '../decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * `GET /health` — para systemd/monitoreo y para verificar un despliegue sin
 * pelear con curls sueltos (ver la sección de verificación en la memoria de
 * despliegue). No sustituye los dos chequeos de invariantes (`/auth/login`
 * vacío → 400, `/planilla-comisiones/periodos` sin token → 401): esos prueban
 * que el ValidationPipe y el guard siguen vivos. Este prueba que el proceso
 * responde y que la base está alcanzable.
 *
 * `@Public()` + `@SkipThrottle()`: un monitor externo (o systemd) lo llama sin
 * sesión y con más frecuencia que el límite general de 120/min.
 */
@Controller('health')
@Public()
@SkipThrottle()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async verificar(): Promise<{ status: 'ok'; baseDatos: 'ok'; timestamp: string; uptimeSegundos: number }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      this.logger.error('Health-check: la base de datos no responde', error instanceof Error ? error.stack : String(error));
      throw new ServiceUnavailableException('La base de datos no responde');
    }

    return {
      status: 'ok',
      baseDatos: 'ok',
      timestamp: new Date().toISOString(),
      uptimeSegundos: Math.round(process.uptime()),
    };
  }
}
