import { Body, Controller, Delete, Get, Header, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AvisosCajaService } from './avisos-caja.service';
import { AgregarNumeroCajaDto } from './dto/avisos-caja.dto';

/**
 * Los WhatsApp de caja que reciben el aviso de comprobante nuevo. Solo
 * administración: el servicio lo vuelve a exigir, que el rol del decorador es el
 * suelo y no la regla.
 */
@Roles('ADMIN')
@Controller('agenda/avisos-caja')
export class AvisosCajaController {
  constructor(private readonly avisos: AvisosCajaService) {}

  /** `?refrescar=1` vuelve a preguntarle a Meta por la plantilla (tras crearla o aprobarla). */
  @Get()
  @Header('Cache-Control', 'private, no-store')
  ver(@CurrentUser() usuario: UsuarioJwt, @Query('refrescar') refrescar?: string) {
    return this.avisos.vista(usuario, { refrescar: refrescar === '1' });
  }

  @Post()
  agregar(@Body() dto: AgregarNumeroCajaDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.avisos.agregar(dto.nombre, dto.telefono, usuario);
  }

  @Delete(':id')
  quitar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.avisos.quitar(id, usuario);
  }
}
