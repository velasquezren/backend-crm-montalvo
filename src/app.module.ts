import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';

import { AuditModule } from './common/audit/audit.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { AuthModule } from './modules/auth/auth.module';
import { ClientesModule } from './modules/clientes/clientes.module';
import { ComisionesModule } from './modules/comisiones/comisiones.module';
import { ConversacionesModule } from './modules/conversaciones/conversaciones.module';
import { KpisModule } from './modules/kpis/kpis.module';
import { LeadsModule } from './modules/leads/leads.module';
import { UsuariosModule } from './modules/usuarios/usuarios.module';
import { VentasModule } from './modules/ventas/ventas.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuditModule,
    AuthModule,
    UsuariosModule,
    ClientesModule,
    LeadsModule,
    ConversacionesModule,
    VentasModule,
    ComisionesModule,
    KpisModule,
  ],
  providers: [
    /* RNF-01: todo endpoint exige JWT (salvo @Public) y valida roles */
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
