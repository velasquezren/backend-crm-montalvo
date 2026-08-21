import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AuditModule } from './common/audit/audit.module';
import { HealthModule } from './common/health/health.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { LoggingInterceptor } from './common/logging/logging.interceptor';
import { RolesGuard } from './common/guards/roles.guard';
import { AuthModule } from './modules/auth/auth.module';
import { ClientesModule } from './modules/clientes/clientes.module';
import { ConversacionesModule } from './modules/conversaciones/conversaciones.module';
import { KpisModule } from './modules/kpis/kpis.module';
import { LeadsModule } from './modules/leads/leads.module';
import { MemoriaAgenteModule } from './modules/memoria-agente/memoria-agente.module';
import { PushModule } from './common/push/push.module';
import { PlanillaComisionesModule } from './modules/planilla-comisiones/planilla-comisiones.module';
import { PlantillasAgenteModule } from './modules/plantillas-agente/plantillas-agente.module';
import { UsuariosModule } from './modules/usuarios/usuarios.module';
import { ServiciosModule } from './modules/servicios/servicios.module';
import { VentasModule } from './modules/ventas/ventas.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    /* Límite de peticiones global (RNF-01). El login lo endurece aún más
       con su propio @Throttle — ver auth.controller.ts. */
    ThrottlerModule.forRoot([{ name: 'general', ttl: 60_000, limit: 120 }]),
    PrismaModule,
    AuditModule,
    HealthModule,
    PushModule,
    AuthModule,
    UsuariosModule,
    ClientesModule,
    LeadsModule,
    ConversacionesModule,
    ServiciosModule,
    VentasModule,
    KpisModule,
    PlantillasAgenteModule,
    MemoriaAgenteModule,
    PlanillaComisionesModule,
  ],
  providers: [
    /* RNF-01: límite de peticiones → JWT (salvo @Public) → validación de roles */
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    /* Una línea de log por petición exitosa, con el requestId de asignarRequestId. */
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
export class AppModule {}
