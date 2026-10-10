import { Controller, Param, ParseIntPipe, ParseUUIDPipe, Post } from '@nestjs/common';

import { alcanceAgente } from '../../common/auth/roles';
import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AsistenteChatService } from './asistente-chat.service';

/**
 * La sugerencia del asistente en un chat (modo SUGERIR, docs/asistente-ia.md).
 * Las mismas rutas y el mismo alcance que el resto del chat, en su propio
 * controlador: quien monta Conversaciones sin el asistente no lo arrastra.
 *
 * «Usar» solo la marca: el texto lo manda la agente desde su caja, como suyo,
 * después de revisarlo.
 */
@Roles('RECEPCION')
@Controller('conversaciones')
export class AsistenteChatController {
  constructor(private readonly asistente: AsistenteChatService) {}

  @Post(':id/asistente/sugerencias/:sugerenciaId/usar')
  usar(@Param('id') id: string, @Param('sugerenciaId', ParseUUIDPipe) sugerenciaId: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.asistente.resolverSugerencia(id, sugerenciaId, 'USADA', usuario.sub, alcanceAgente(usuario));
  }

  @Post(':id/asistente/sugerencias/:sugerenciaId/descartar')
  descartar(@Param('id') id: string, @Param('sugerenciaId', ParseUUIDPipe) sugerenciaId: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.asistente.resolverSugerencia(id, sugerenciaId, 'DESCARTADA', usuario.sub, alcanceAgente(usuario));
  }

  /** Envía una acción de la sugerencia: la tarjeta de una promoción o la imagen de un horario. */
  @Post(':id/asistente/sugerencias/:sugerenciaId/acciones/:indice')
  ejecutarAccion(
    @Param('id') id: string,
    @Param('sugerenciaId', ParseUUIDPipe) sugerenciaId: string,
    @Param('indice', ParseIntPipe) indice: number,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.asistente.ejecutarAccionSugerida(id, sugerenciaId, indice, usuario.sub, alcanceAgente(usuario));
  }
}
