import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import { alcanceAgente, tieneAlcanceGlobal } from "../../common/auth/roles";
import {
  CurrentUser,
  UsuarioJwt,
} from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { PaginationDto } from "../../common/dto/pagination.dto";
import { ActualizarLineaDto } from "./dto/actualizar-linea.dto";
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
