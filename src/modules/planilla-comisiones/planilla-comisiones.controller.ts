import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Put,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { ClasifComision, EstadoPeriodo } from '@prisma/client';
import { IsEnum } from 'class-validator';

import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AnaliticaComisionesService } from './analitica-comisiones.service';
import { CalculoComisionesService } from './calculo-comisiones.service';
import { ConfiguracionComisionesService } from './configuracion-comisiones.service';
import { ExportacionComisionesService } from './exportacion-comisiones.service';
import {
  ActualizarNivelCirugiaDto,
  ActualizarObjetivoDto,
  GuardarMapeoCaptacionDto,
  ActualizarParametroDto,
  ActualizarTarifaPlanDto,
  ActualizarTarifaRaDto,
  ActualizarTarifaServicioDto,
  ActualizarVendedoraDto,
  CrearReglaDto,
} from './dto/configuracion.dto';
import {
  AjustarVentaDto,
  ImportarExcelDto,
  QueryPeriodosDto,
  QueryVentasImportadasDto,
} from './dto/planilla.dto';
import { PlanillaComisionesService } from './planilla-comisiones.service';

/** Lo que entrega multer. Se declara a mano para no arrastrar `any` ni @types/multer. */
interface ArchivoSubido {
  originalname: string;
  buffer: Buffer;
  size: number;
  mimetype: string;
}

/** Tope del Excel mensual: el VPS tiene poca RAM y un mes real pesa muy por debajo. */
const TAMANO_MAXIMO_BYTES = 15 * 1024 * 1024;

const EXTENSIONES_VALIDAS = ['.xlsx', '.xls'];

class CambiarEstadoPeriodoDto {
  @IsEnum(EstadoPeriodo)
  estado!: EstadoPeriodo;
}

/**
 * Planilla de comisiones (liquidación mensual desde el Excel de FileMaker).
 *
 * El módulo entero es de ADMIN para arriba: son datos de remuneración de todo el
 * equipo, no información que un agente deba ver. Por eso no hay escopado por
 * agente aquí — el guard de roles corta antes.
 *
 * Cargar y borrar planillas queda además reservado al SUPER_ADMIN: es quien
 * administra los códigos de empresa de los que depende toda la liquidación.
 */
@Roles('ADMIN')
@Controller('planilla-comisiones')
export class PlanillaComisionesController {
  constructor(
    private readonly planilla: PlanillaComisionesService,
    private readonly calculo: CalculoComisionesService,
    private readonly configuracion: ConfiguracionComisionesService,
    private readonly analitica: AnaliticaComisionesService,
    private readonly exportacion: ExportacionComisionesService,
  ) {}

  /* ── Importación y periodos ─────────────────────────────────────────── */

  @Post('importar')
  @Roles('SUPER_ADMIN')
  @UseInterceptors(FileInterceptor('archivo'))
  importar(
    @UploadedFile() archivo: ArchivoSubido | undefined,
    @Body() dto: ImportarExcelDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    if (!archivo) {
      throw new BadRequestException('Falta el archivo Excel (campo "archivo")');
    }
    if (archivo.size > TAMANO_MAXIMO_BYTES) {
      throw new BadRequestException(
        `El archivo pesa ${(archivo.size / 1024 / 1024).toFixed(1)} MB; el máximo es 15 MB`,
      );
    }
    const nombre = archivo.originalname.toLowerCase();
    if (!EXTENSIONES_VALIDAS.some(ext => nombre.endsWith(ext))) {
      throw new BadRequestException('El archivo debe ser un Excel (.xlsx o .xls)');
    }

    return this.planilla.importar(archivo.buffer, archivo.originalname, dto, usuario.sub);
  }

  @Get('periodos')
  listarPeriodos(@Query() query: QueryPeriodosDto) {
    return this.planilla.listarPeriodos(query);
  }

  @Get('periodos/:id')
  obtenerPeriodo(@Param('id') id: string) {
    return this.planilla.obtenerPeriodo(id);
  }

  @Patch('periodos/:id/estado')
  cambiarEstado(
    @Param('id') id: string,
    @Body() dto: CambiarEstadoPeriodoDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.planilla.cambiarEstado(id, dto.estado, usuario.sub);
  }

  @Delete('periodos/:id')
  @Roles('SUPER_ADMIN')
  eliminarPeriodo(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.planilla.eliminarPeriodo(id, usuario.sub);
  }

  /* ── Revisión de la clasificación ───────────────────────────────────── */

  @Get('periodos/:id/ventas')
  listarVentas(@Param('id') id: string, @Query() query: QueryVentasImportadasDto) {
    return this.planilla.listarVentas(id, query);
  }

  @Get('periodos/:id/alertas')
  alertas(@Param('id') id: string) {
    return this.planilla.alertas(id);
  }

  @Patch('ventas/:id')
  ajustarVenta(
    @Param('id') id: string,
    @Body() dto: AjustarVentaDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.planilla.ajustarVenta(id, dto, usuario.sub);
  }

  /* ── Cálculo y reportes ─────────────────────────────────────────────── */

  @Post('periodos/:id/calcular')
  calcular(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.calculo.calcular(id, usuario.sub);
  }

  /** Informe completo del mes: categorías, canales, servicios y evolución diaria. */
  @Get('periodos/:id/analitica')
  analiticaPeriodo(@Param('id') id: string) {
    return this.analitica.analitica(id);
  }

  /**
   * Descarga el informe del mes en Excel. Se escribe en streaming sobre la
   * respuesta, así que el libro no pasa entero por memoria.
   */
  @Get('periodos/:id/exportar')
  async exportar(@Param('id') id: string, @Res({ passthrough: false }) res: Response) {
    const nombre = await this.exportacion.nombreArchivo(id);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    await this.exportacion.exportar(id, res);
    res.end();
  }

  @Get('periodos/:id/reporte/consolidado')
  reporteConsolidado(@Param('id') id: string) {
    return this.calculo.reporteConsolidado(id);
  }

  @Get('periodos/:id/reporte/planilla')
  reportePlanilla(@Param('id') id: string) {
    return this.calculo.reportePlanilla(id);
  }

  @Get('periodos/:id/reporte/bonos')
  reporteBonos(@Param('id') id: string) {
    return this.calculo.reporteBonos(id);
  }

  @Get('periodos/:periodoId/reporte/vendedora/:vendedoraId')
  reportePorVendedora(
    @Param('periodoId') periodoId: string,
    @Param('vendedoraId') vendedoraId: string,
  ) {
    return this.calculo.reportePorVendedora(periodoId, vendedoraId);
  }

  /* ── Vendedoras ─────────────────────────────────────────────────────── */

  @Get('vendedoras')
  listarVendedoras() {
    return this.planilla.listarVendedoras();
  }

  @Patch('vendedoras/:id')
  actualizarVendedora(
    @Param('id') id: string,
    @Body() dto: ActualizarVendedoraDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.planilla.actualizarVendedora(id, dto, usuario.sub);
  }

  /* ── Panel de configuración ─────────────────────────────────────────── */

  @Get('configuracion')
  configuracionCompleta() {
    return this.configuracion.listarTodo();
  }

  @Patch('configuracion/tarifas-plan/:clave')
  actualizarTarifaPlan(@Param('clave') clave: string, @Body() dto: ActualizarTarifaPlanDto) {
    return this.configuracion.actualizarTarifaPlan(clave, dto);
  }

  @Patch('configuracion/tarifas-servicio/:clasif')
  actualizarTarifaServicio(
    @Param('clasif') clasif: ClasifComision,
    @Body() dto: ActualizarTarifaServicioDto,
  ) {
    return this.configuracion.actualizarTarifaServicio(clasif, dto);
  }

  @Patch('configuracion/niveles-cirugia/:nivel')
  actualizarNivelCirugia(
    @Param('nivel') nivel: string,
    @Body() dto: ActualizarNivelCirugiaDto,
  ) {
    const numero = Number(nivel);
    if (!Number.isInteger(numero)) {
      throw new BadRequestException('El nivel debe ser un número entero');
    }
    return this.configuracion.actualizarNivelCirugia(numero, dto);
  }

  @Patch('configuracion/tarifas-ra/:id')
  actualizarTarifaRa(@Param('id') id: string, @Body() dto: ActualizarTarifaRaDto) {
    return this.configuracion.actualizarTarifaRa(id, dto);
  }

  @Put('configuracion/captacion/:valor')
  guardarCaptacion(@Param('valor') valor: string, @Body() dto: GuardarMapeoCaptacionDto) {
    return this.configuracion.guardarMapeoCaptacion(valor, dto.canal);
  }

  @Delete('configuracion/captacion/:valor')
  eliminarCaptacion(@Param('valor') valor: string) {
    return this.configuracion.eliminarMapeoCaptacion(valor);
  }

  @Patch('configuracion/objetivos/:id')
  actualizarObjetivo(@Param('id') id: string, @Body() dto: ActualizarObjetivoDto) {
    return this.configuracion.actualizarObjetivo(id, dto);
  }

  @Patch('configuracion/parametros/:clave')
  actualizarParametro(@Param('clave') clave: string, @Body() dto: ActualizarParametroDto) {
    return this.configuracion.actualizarParametro(clave, dto);
  }

  /* ── Diccionario de clasificación ───────────────────────────────────── */

  @Post('configuracion/reglas')
  crearRegla(@Body() dto: CrearReglaDto) {
    return this.configuracion.crearRegla(dto);
  }

  @Patch('configuracion/reglas/:id')
  actualizarRegla(@Param('id') id: string, @Body() dto: CrearReglaDto) {
    return this.configuracion.actualizarRegla(id, dto);
  }

  @Delete('configuracion/reglas/:id')
  eliminarRegla(@Param('id') id: string) {
    return this.configuracion.eliminarRegla(id);
  }
}
