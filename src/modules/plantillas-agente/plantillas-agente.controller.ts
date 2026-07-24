import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { CreatePlantillaAgenteDto } from './dto/create-plantilla-agente.dto';
import { UpdatePlantillaAgenteDto } from './dto/update-plantilla-agente.dto';
import { PlantillasAgenteService } from './plantillas-agente.service';

@Controller('plantillas-agente')
export class PlantillasAgenteController {
  constructor(private readonly service: PlantillasAgenteService) {}

  @Get()
  findAll(@CurrentUser() usuario: UsuarioJwt) {
    return this.service.findAll(usuario.sub);
  }

  @Post()
  create(@Body() dto: CreatePlantillaAgenteDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.create(usuario.sub, dto);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePlantillaAgenteDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.service.update(id, usuario.sub, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.remove(id, usuario.sub);
  }
}
