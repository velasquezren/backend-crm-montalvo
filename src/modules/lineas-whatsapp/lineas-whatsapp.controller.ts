import { Body, Controller, Get, Param, Patch, Put, Query } from "@nestjs/common";
import { alcanceAgente, tieneAlcanceGlobal } from "../../common/auth/roles";
import {
  CurrentUser,
  UsuarioJwt,
} from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { PaginationDto } from "../../common/dto/pagination.dto";
import { ActualizarLineaDto } from "./dto/actualizar-linea.dto";
import { FijarAvisoDto } from "./dto/fijar-aviso.dto";
import { LineasWhatsappService } from "./lineas-whatsapp.service";

@Roles("RECEPCION")
@Controller("lineas-whatsapp")
export class LineasWhatsappController {
  constructor(private readonly service: LineasWhatsappService) {}
  @Get()
  listar(@Query() query: PaginationDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.listar(
      query,
      alcanceAgente(usuario),
      tieneAlcanceGlobal(usuario.rol),
    );
  }
  /**
   * Los avisos de QUIEN PREGUNTA, por línea. Cualquier rol: es su teléfono.
   * El usuario sale siempre del token y nunca de la URL ni del cuerpo — por eso
   * no hay `:usuarioId` aquí: no hay forma de pedir ni cambiar los de otra.
   */
  @Get("avisos")
  avisos(@Query() query: PaginationDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.avisosDe(usuario.sub, usuario.rol, query);
  }

  @Put(":id/avisos")
  fijarAviso(
    @Param("id") id: string,
    @Body() dto: FijarAvisoDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.service.fijarAviso(usuario.sub, usuario.rol, id, dto.suena);
  }

  @Patch(":id")
  @Roles("SUPER_ADMIN")
  actualizar(
    @Param("id") id: string,
    @Body() dto: ActualizarLineaDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.service.actualizar(id, dto, usuario.sub);
  }
}
