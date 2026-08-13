import { Module } from '@nestjs/common';

import { AnaliticaComisionesService } from './analitica-comisiones.service';
import { CalculoComisionesService } from './calculo-comisiones.service';
import { ConfiguracionComisionesService } from './configuracion-comisiones.service';
import { ResumenAnualService } from './resumen-anual.service';
import { ExportacionComisionesService } from './exportacion-comisiones.service';
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
  providers: [
    ResumenAnualService,
    PlanillaComisionesService,
    CalculoComisionesService,
    ConfiguracionComisionesService,
    AnaliticaComisionesService,
    ExportacionComisionesService,
  ],
  exports: [PlanillaComisionesService],
})
export class PlanillaComisionesModule {}
