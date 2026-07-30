import { Module } from '@nestjs/common';

import { CalculoComisionesService } from './calculo-comisiones.service';
import { ConfiguracionComisionesService } from './configuracion-comisiones.service';
import { PlanillaComisionesController } from './planilla-comisiones.controller';
import { PlanillaComisionesService } from './planilla-comisiones.service';

/**
 * Planilla de comisiones — liquidación mensual del equipo comercial a partir
 * del export de FileMaker.
 *
 * Dominio autónomo: no consume ni modifica los módulos Ventas/Comisiones del
 * CRM (que modelan otra cosa: la venta puntual de un agente y su comisión).
 */
@Module({
  controllers: [PlanillaComisionesController],
  providers: [PlanillaComisionesService, CalculoComisionesService, ConfiguracionComisionesService],
  exports: [PlanillaComisionesService],
})
export class PlanillaComisionesModule {}
