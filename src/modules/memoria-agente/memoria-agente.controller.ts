import { ArchivoSubido } from './archivo-subido';
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

  /**
   * El límite va aquí, no solo en el service.
   *
   * `FileInterceptor` sin `limits` deja que multer lea el archivo COMPLETO en
   * memoria y solo después el service comprueba `file.size`: para cuando se
   * rechaza un vídeo de 400 MB, ya está entero en la RAM de un VPS que tiene
   * 1,7 GB y un núcleo, compartidos con el webhook de WhatsApp. Con `limits`,
   * multer corta el flujo al pasarse y nunca llega a reservar esa memoria.
   *
   * El tope de aquí es deliberadamente mayor que el del service (5 MB): este
   * corta la sangría, y el service sigue siendo el que define la regla de
   * negocio y devuelve el mensaje que lee la agente.
   */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024, files: 1 } }))
  subirBinario(
    @Body() dto: CreateRecursoMemoriaDto,
    @UploadedFile() file: ArchivoSubido,
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
