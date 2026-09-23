import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { alcanceAgente } from '../../common/auth/roles';
import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ArchivoSubido } from './archivo-subido';
import { CambiarEstadoDto } from './dto/cambiar-estado.dto';
import { CorregirOrigenDto } from './dto/corregir-origen.dto';
import { CreateVentaDto } from './dto/create-venta.dto';
import { QueryVentaDto } from './dto/query-venta.dto';
import { CatalogoClinicoService } from '../planilla-comisiones/catalogo-clinico.service';
import { VentasService } from './ventas.service';

@Controller('ventas')
export class VentasController {
  constructor(
    private readonly ventasService: VentasService,
    private readonly catalogo: CatalogoClinicoService,
  ) {}

  /**
   * Servicios y médicos que la clínica ya facturó, para autocompletar el modal.
   *
   * Sin rol: lo consume toda agente al registrar una venta. No expone nada de
   * la planilla —ni importes, ni comisiones, ni pacientes—: solo los nombres de
   * los servicios, los de los médicos y cuántas veces aparece cada uno, que es
   * lo que ordena las sugerencias.
   */
  @Get('catalogo')
  obtenerCatalogo() {
    return this.catalogo.obtener();
  }

  @Post()
  create(@Body() dto: CreateVentaDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.ventasService.create(dto, usuario.sub, alcanceAgente(usuario));
  }

  @Post('comprobante')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024, files: 1 } }))
  subirComprobante(
    @UploadedFile() file: ArchivoSubido,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.ventasService.subirComprobante(file, usuario.sub);
  }

  /** Un agente ve solo sus ventas; un admin ve todas (visibilidad por rol). */
  @Get()
  findAll(@Query() query: QueryVentaDto, @CurrentUser() usuario: UsuarioJwt) {
    // Un agente solo ve lo suyo; admin y super admin ven todo el equipo.
    query.agenteId = alcanceAgente(usuario) ?? query.agenteId;
    return this.ventasService.findAll(query);
  }

  /** Tarjetas y gráficos de la pantalla: sobre todo lo filtrado, con el mismo alcance que el listado. */
  @Get('resumen')
  resumen(@Query() query: QueryVentaDto, @CurrentUser() usuario: UsuarioJwt) {
    query.agenteId = alcanceAgente(usuario) ?? query.agenteId;
    return this.ventasService.resumen(query);
  }

  @Patch(':id/estado')
  @Roles('ADMIN')
  cambiarEstado(
    @Param('id') id: string,
    @Body() dto: CambiarEstadoDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.ventasService.cambiarEstado(id, dto.estado, usuario.sub, dto.motivoPerdida);
  }

  /**
   * Corregir de qué lead vino una venta ya registrada — CAMP-1.
   *
   * Endpoint específico y no un `PATCH /ventas/:id` general: lo único que hace
   * falta corregir es la atribución. Un CRUD genérico sobre Venta abriría a
   * edición el importe, el estado y el agente, que es justo lo que RF-12
   * protege. `leadId: null` quita la atribución.
   *
   * Sin `@Roles`: el guard global exige AGENTE, el mismo listón que registrar
   * la venta —quien pudo equivocarse puede corregirse—, y `alcanceAgente` la
   * limita a sus propias ventas. RECEPCION no llega.
   */
  @Patch(':id/origen')
  corregirOrigen(
    @Param('id') id: string,
    @Body() dto: CorregirOrigenDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.ventasService.corregirOrigen(id, dto, usuario.sub, alcanceAgente(usuario));
  }
}
