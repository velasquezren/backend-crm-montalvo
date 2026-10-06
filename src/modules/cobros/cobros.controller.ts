import { Body, Controller, Get, Param, Put, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { ArchivoSubido } from '../../common/archivos/archivo-subido';
import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { BYTES_MAXIMOS_IMAGEN } from '../../common/storage/imagen-publica';
import { GuardarCobroDto } from './dto/guardar-cobro.dto';
import { CobrosService } from './cobros.service';

/** Se configura junto con la línea, en la misma pantalla y con el mismo rol. */
@Roles('SUPER_ADMIN')
@Controller('cobros')
export class CobrosController {
  constructor(private readonly service: CobrosService) {}

  @Get(':lineaId')
  obtener(@Param('lineaId') lineaId: string) {
    return this.service.editable(lineaId);
  }

  @Put(':lineaId')
  guardar(@Param('lineaId') lineaId: string, @Body() dto: GuardarCobroDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.guardar(lineaId, dto, usuario.sub);
  }

  /** `limits`: multer corta al pasar el tope en vez de leer el archivo entero a memoria. */
  @Put(':lineaId/qr')
  @UseInterceptors(FileInterceptor('archivo', { limits: { fileSize: BYTES_MAXIMOS_IMAGEN, files: 1 } }))
  subirQr(@Param('lineaId') lineaId: string, @UploadedFile() archivo: ArchivoSubido | undefined, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.subirQr(lineaId, archivo, usuario.sub);
  }
}
