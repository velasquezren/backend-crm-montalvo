import { Controller, Get, Param, Query } from '@nestjs/common';

import { Roles } from '../../common/decorators/roles.decorator';
import { QueryMedicosDto, QueryPacientesDto, QueryServiciosDto } from './dto/query-servicios.dto';
import { ServiciosService } from './servicios.service';

/**
 * Historial de servicios de la clínica.
 *
 * Todo el módulo es **de solo lectura**: no hay un solo verbo que escriba, así
 * que consultarlo no puede alterar comisiones ni fichas. Por eso tampoco hace
 * falta distinguir permisos por endpoint — basta con el ADMIN de clase, igual
 * que en el resto de vistas de análisis.
 */
@Roles('ADMIN')
@Controller('servicios')
export class ServiciosController {
  constructor(private readonly servicios: ServiciosService) {}

  /** Resumen del historial: volumen, ingresos, módulos, top servicios y médicos. */
  @Get('dashboard')
  dashboard(@Query() query: QueryServiciosDto) {
    return this.servicios.dashboard(query);
  }

  /** Perfil de la base de pacientes: sexo, edad y procedencia. */
  @Get('demografia')
  demografia() {
    return this.servicios.demografia();
  }

  @Get('pacientes')
  pacientes(@Query() query: QueryPacientesDto) {
    return this.servicios.pacientes(query);
  }

  /** Ficha y línea de tiempo. Funciona aunque el paciente aún no exista en el CRM. */
  @Get('pacientes/:pac')
  historialPaciente(@Param('pac') pac: string) {
    return this.servicios.historialPaciente(pac);
  }

  @Get('medicos')
  medicos(@Query() query: QueryMedicosDto) {
    return this.servicios.medicos(query);
  }
}
