import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { CreateRecursoMemoriaDto } from './dto/create-recurso-memoria.dto';
import { QueryRecursoMemoriaDto } from './dto/query-recurso-memoria.dto';
import { UpdateRecursoMemoriaDto } from './dto/update-recurso-memoria.dto';
import { MemoriaAgenteService } from './memoria-agente.service';

@Controller('memoria-agente')
export class MemoriaAgenteController {
  constructor(private readonly service: MemoriaAgenteService) {}

  @Get('cuota')
  consultarCuota(@CurrentUser() usuario: UsuarioJwt) {
    return this.service.consultarCuota(usuario.sub);
  }

  @Get()
  findAll(@Query() query: QueryRecursoMemoriaDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.findAll(usuario.sub, query);
  }

  @Post()
  create(@Body() dto: CreateRecursoMemoriaDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.create(usuario.sub, dto);
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  subirBinario(
    @Body() dto: CreateRecursoMemoriaDto,
    @UploadedFile() file: any,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.service.subirBinario(usuario.sub, dto, file);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateRecursoMemoriaDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.service.update(id, usuario.sub, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.remove(id, usuario.sub);
  }
}
