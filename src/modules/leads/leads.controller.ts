import { Body, Controller, Get, Post, Query } from '@nestjs/common';

import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { CreateLeadPresencialDto } from './dto/create-lead-presencial.dto';
import { QueryLeadDto } from './dto/query-lead.dto';
import { LeadsService } from './leads.service';

@Controller('leads')
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Get()
  findAll(@Query() query: QueryLeadDto, @CurrentUser() usuario: UsuarioJwt) {
    const soloAgenteId = usuario.rol === 'ADMIN' ? undefined : usuario.sub;
    return this.leadsService.findAll(query, soloAgenteId);
  }

  @Post('presencial')
  createPresencial(@Body() dto: CreateLeadPresencialDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.leadsService.createPresencial(dto, usuario.sub);
  }
}
