import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { alcanceAgente } from '../../common/auth/roles';
import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AsignarAgenteLeadDto } from './dto/asignar-agente-lead.dto';
import { CreateLeadPresencialDto } from './dto/create-lead-presencial.dto';
import { QueryLeadDto } from './dto/query-lead.dto';
import { UpdateEstadoLeadDto } from './dto/update-estado-lead.dto';
import { LeadsService } from './leads.service';

@Controller('leads')
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Get()
  findAll(@Query() query: QueryLeadDto, @CurrentUser() usuario: UsuarioJwt) {
    const soloAgenteId = alcanceAgente(usuario);
    return this.leadsService.findAll(query, soloAgenteId);
  }

  /** Conteos por estado para las columnas del kanban (RF-17). */
  @Get('resumen')
  resumen(@Query() query: QueryLeadDto, @CurrentUser() usuario: UsuarioJwt) {
    const soloAgenteId = alcanceAgente(usuario);
    return this.leadsService.resumenPorEstado(query, soloAgenteId);
  }

  @Post('presencial')
  createPresencial(@Body() dto: CreateLeadPresencialDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.leadsService.createPresencial(dto, usuario.sub);
  }

  /**
   * Mover una tarjeta del kanban a otra columna — cualquier agente autenticado,
   * pero solo sobre un lead dentro de su alcance (el suyo, el de su cliente, o
   * sin asignar). Antes no repetía el chequeo de `findAll`/`resumen`, así que
   * cualquier agente podía cambiar el estado de CUALQUIER lead del sistema por
   * UUID — el mismo agujero que ya se cerró en Clientes y Conversaciones
   * (ver `crm-backend-module`).
   */
  @Patch(':id/estado')
  updateEstado(
    @Param('id') id: string,
    @Body() dto: UpdateEstadoLeadDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    const soloAgenteId = alcanceAgente(usuario);
    return this.leadsService.updateEstado(id, dto.estado, soloAgenteId);
  }

  /**
   * Reasignar el agente responsable — solo ADMIN, igual que el mismo gesto en
   * Conversaciones (`ConversacionesController.asignarAgente`): cambia quién
   * cobra la comisión de la paciente, así que no es una acción de agente.
   */
  @Patch(':id/agente')
  @Roles('ADMIN')
  asignarAgente(
    @Param('id') id: string,
    @Body() dto: AsignarAgenteLeadDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.leadsService.asignarAgente(id, dto.agenteId, usuario.sub);
  }
}
