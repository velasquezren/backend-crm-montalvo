import { Module } from '@nestjs/common';

import { TipoCambioModule } from '../tipo-cambio/tipo-cambio.module';

import { AnaliticaComisionesService } from './analitica-comisiones.service';
import { CalculoComisionesService } from './calculo-comisiones.service';
import { CatalogoClinicoService } from './catalogo-clinico.service';
import { ConfiguracionComisionesService } from './configuracion-comisiones.service';
import { ResumenAnualService } from './resumen-anual.service';
import { ExportacionComisionesService } from './exportacion-comisiones.service';
import { ExportacionWordService } from './exportacion-word.service';
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
  imports: [TipoCambioModule],
  controllers: [PlanillaComisionesController],
  providers: [
    ResumenAnualService,
    CatalogoClinicoService,
    PlanillaComisionesService,
    CalculoComisionesService,
    ConfiguracionComisionesService,
    AnaliticaComisionesService,
    ExportacionComisionesService,
    ExportacionWordService,
  ],
  /* CatalogoClinicoService sale fuera porque Ventas lo necesita para
     autocompletar: es lectura derivada, no acceso a la planilla. */
  exports: [PlanillaComisionesService, CatalogoClinicoService],
})
export class PlanillaComisionesModule {}
