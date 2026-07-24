import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { CreateLeadPresencialDto } from './dto/create-lead-presencial.dto';
import { QueryLeadDto } from './dto/query-lead.dto';
import { UpdateEstadoLeadDto } from './dto/update-estado-lead.dto';
import { LeadsService } from './leads.service';

@Controller('leads')
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Get()
  findAll(@Query() query: QueryLeadDto, @CurrentUser() usuario: UsuarioJwt) {
    const soloAgenteId = usuario.rol === 'ADMIN' ? undefined : usuario.sub;
    return this.leadsService.findAll(query, soloAgenteId);
  }

  /** Conteos por estado para las columnas del kanban (RF-17). */
  @Get('resumen')
  resumen(@Query() query: QueryLeadDto, @CurrentUser() usuario: UsuarioJwt) {
    const soloAgenteId = usuario.rol === 'ADMIN' ? undefined : usuario.sub;
    return this.leadsService.resumenPorEstado(query, soloAgenteId);
  }

  @Post('presencial')
  createPresencial(@Body() dto: CreateLeadPresencialDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.leadsService.createPresencial(dto, usuario.sub);
  }

  @Patch(':id/estado')
  updateEstado(@Param('id') id: string, @Body() dto: UpdateEstadoLeadDto) {
    return this.leadsService.updateEstado(id, dto.estado);
  }

  @Patch(':id/agente')
  asignarAgente(@Param('id') id: string, @Body('agenteId') agenteId: string | null) {
    return this.leadsService.asignarAgente(id, agenteId);
  }
}
