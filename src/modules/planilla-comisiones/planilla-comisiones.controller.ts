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
import { ClasifComision, TipoVendedora } from '@prisma/client';

import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AnaliticaComisionesService } from './analitica-comisiones.service';
import { CalculoComisionesService } from './calculo-comisiones.service';
import { ConfiguracionComisionesService } from './configuracion-comisiones.service';
import { ResumenAnualService } from './resumen-anual.service';
import { ExportacionComisionesService } from './exportacion-comisiones.service';
import { ExportacionMetricasService } from './exportacion-metricas.service';
import { ExportacionWordService } from './exportacion-word.service';
import {
  ActualizarNivelCirugiaDto,
  ActualizarNivelTipoARADto,
  ActualizarObjetivoDto,
  GuardarMapeoCaptacionDto,
  ActualizarParametroDto,
  ActualizarTarifaPlanDto,
  ActualizarTarifaRaDto,
  ActualizarTarifaServicioDto,
  ActualizarVendedoraDto,
  CrearVendedoraDto,
  CrearReglaDto,
} from './dto/configuracion.dto';
import { QueryAnualDto } from './dto/query-anual.dto';
import {
  AjustarVentaDto,
  AprobarPeriodoDto,
  ImportarExcelDto,
  MotivoPeriodoDto,
  QueryInformeDto,
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
    private readonly exportacionWord: ExportacionWordService,
    private readonly exportacionMetricas: ExportacionMetricasService,
    private readonly resumenAnual: ResumenAnualService,
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

  /**
   * Tipo de cambio vigente, para el selector Bs / $us de la barra superior.
   *
   * Va abierto a AGENTE —el resto del controlador es ADMIN— porque el selector
   * vive en el navbar y lo ve todo el mundo. No expone nada sensible: es el
   * mismo número que ya aparece impreso en cualquier factura de la clínica, sin
   * ninguna cifra de comisiones detrás.
   *
   * Hasta ahora el frontend lo llevaba escrito a mano (6,97) y por tanto no se
   * enteraba si administración importaba un mes con otro tipo de cambio: al
   * pasar la tabla a dólares dividía por un número que no era el del periodo.
   */
  @Get('tipo-cambio')
  @Roles('AGENTE')
  tipoCambioVigente() {
    return this.planilla.tipoCambioVigente();
  }

  @Get('periodos')
  listarPeriodos(@Query() query: QueryPeriodosDto) {
    return this.planilla.listarPeriodos(query);
  }

  @Get('periodos/:id')
  obtenerPeriodo(@Param('id') id: string) {
    return this.planilla.obtenerPeriodo(id);
  }

  /* ── Cierre del mes ─────────────────────────────────────────────────────
   *
   * **No hay un endpoint que reciba el estado destino.** El que había
   * (`PATCH /periodos/:id/estado`) aceptaba cualquier valor del enum sin
   * comprobar el salto: `CERRADO → BORRADOR` entraba, y con él la posibilidad
   * de recalcular un mes ya pagado. Cada paso es ahora su propia ruta, con sus
   * permisos y los datos que exige.
   *
   * Criterio de permisos, y no es cosmético:
   *
   * - **Preparar es ADMIN** (`revision`): administración arma el mes y lo manda
   *   a revisar.
   * - **Decidir es SUPER_ADMIN** (aprobar, rechazar, reabrir, pagar). Rechazar
   *   también, aunque devuelva el mes a un estado más laxo: invalida las firmas
   *   de los demás, y eso no puede quedar en manos de quien preparó la planilla.
   * - **Reabrir era ADMIN y ahora es SUPER_ADMIN.** Estaba al revés: borrar un
   *   periodo pedía SUPER_ADMIN pero reabrirlo no, así que cualquier ADMIN podía
   *   reabrir un mes cerrado y desde ahí recalcularlo o borrarlo.
   */

  /** Quién aprobó, quién falta y qué impide avanzar. */
  @Get('periodos/:id/revision')
  revision(@Param('id') id: string) {
    return this.planilla.revision(id);
  }

  @Post('periodos/:id/revision')
  enviarARevision(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.planilla.enviarARevision(id, usuario.sub);
  }

  @Post('periodos/:id/aprobar')
  @Roles('SUPER_ADMIN')
  aprobar(
    @Param('id') id: string,
    @Body() dto: AprobarPeriodoDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.planilla.aprobar(id, usuario.sub, dto.comentario);
  }

  @Post('periodos/:id/rechazar')
  @Roles('SUPER_ADMIN')
  rechazar(
    @Param('id') id: string,
    @Body() dto: MotivoPeriodoDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.planilla.rechazar(id, usuario.sub, dto.motivo);
  }

  @Post('periodos/:id/reabrir')
  @Roles('SUPER_ADMIN')
  reabrir(
    @Param('id') id: string,
    @Body() dto: MotivoPeriodoDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.planilla.reabrir(id, usuario.sub, dto.motivo);
  }

  @Post('periodos/:id/pagar')
  @Roles('SUPER_ADMIN')
  registrarPago(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.planilla.registrarPago(id, usuario.sub);
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

  /**
   * Vista de un año entero: cada vendedora con sus doce meses y sus cuatro
   * trimestres. Es lo único del módulo que cruza periodos.
   *
   * Va antes de las rutas `periodos/:id` a propósito: `anual` no es un id.
   */
  @Get('anual')
  @Roles('ADMIN')
  verResumenAnual(@Query() query: QueryAnualDto) {
    return this.resumenAnual.porAnio(query.anio ?? new Date().getFullYear());
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
  async exportar(
    @Param('id') id: string,
    @Query() query: QueryInformeDto,
    @Res({ passthrough: false }) res: Response,
  ) {
    const nombre = await this.exportacion.nombreArchivo(id);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    await this.exportacion.exportar(id, res, query.incluirOcultas ?? false);
    res.end();
  }

  /**
   * El informe del mes en Word: el documento que administración revisa, edita
   * si hace falta y firma.
   *
   * Lleva las tres firmas, y `Elaborado`/`Revisado` salen del usuario que lo
   * genera — por eso hace falta el `@CurrentUser()` que el Excel no necesita.
   *
   * A diferencia del Excel no va en streaming: un .docx es un ZIP y se arma
   * entero antes de poder escribirse. No es un problema de memoria porque el
   * documento pesa unos 10 KB — son diez filas y tres firmas, no las 500 del
   * detalle.
   */
  @Get('periodos/:id/exportar-word')
  async exportarWord(
    @Param('id') id: string,
    @Query() query: QueryInformeDto,
    @CurrentUser() usuario: UsuarioJwt,
    @Res({ passthrough: false }) res: Response,
  ) {
    const nombre = await this.exportacionWord.nombreArchivo(id);
    const documento = await this.exportacionWord.generar(id, {
      incluirOcultas: query.incluirOcultas ?? false,
      usuarioId: usuario.sub,
    });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    res.end(documento);
  }

  /**
   * Las métricas del mes en PDF: el acompañante del informe Word.
   *
   * No lleva firmas ni pide usuario — no se firma, se imprime y se adjunta. Va
   * en streaming como el Excel: son gráficos, no un ZIP que haya que cerrar.
   */
  @Get('periodos/:id/exportar-metricas')
  async exportarMetricas(
    @Param('id') id: string,
    @Query() query: QueryInformeDto,
    @Res({ passthrough: false }) res: Response,
  ) {
    const nombre = await this.exportacionMetricas.nombreArchivo(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    await this.exportacionMetricas.exportar(id, res, {
      incluirOcultas: query.incluirOcultas ?? false,
    });
  }

  @Get('periodos/:id/reporte/consolidado')
  reporteConsolidado(@Param('id') id: string, @Query() query: QueryInformeDto) {
    return this.calculo.reporteConsolidado(id, query.incluirOcultas ?? false);
  }

  @Get('periodos/:id/reporte/planilla')
  reportePlanilla(@Param('id') id: string) {
    return this.calculo.reportePlanilla(id);
  }

  @Get('periodos/:id/reporte/bonos')
  reporteBonos(@Param('id') id: string) {
    return this.calculo.reporteBonos(id);
  }

  /**
   * Todas las líneas de desglose (tipo/canal/unidad de negocio) de todas las
   * vendedoras liquidadas, en una sola lista filtrable — para responder
   * "¿cuánto cobramos de Tipo B este mes?" sin abrir el Excel.
   */
  @Get('periodos/:id/reporte/desglose')
  reporteDesglose(@Param('id') id: string, @Query() query: QueryInformeDto) {
    return this.calculo.reporteDesglose(id, query.incluirOcultas ?? false);
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

  /**
   * Alta manual. Es SUPER_ADMIN por lo mismo que importar: se está creando una
   * fila de planilla, y `codigo` es la clave que cruza con el agente del CRM.
   */
  @Post('vendedoras')
  @Roles('SUPER_ADMIN')
  crearVendedora(@Body() dto: CrearVendedoraDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.planilla.crearVendedora(dto, usuario.sub);
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

  /*
   * Criterio de permisos de la configuración: **leerla es ADMIN, cambiarla es
   * SUPER_ADMIN**. No es cosmético — estos valores deciden cuánto cobra cada
   * persona, y una tarifa mal puesta se propaga a todas las liquidaciones que
   * se recalculen después. Antes cada endpoint heredaba o no el rol según lo que
   * recordara quien lo escribió: las metas de un mes pedían SUPER_ADMIN y las
   * metas base —que afectan TODOS los meses— se quedaban en ADMIN.
   */

  @Get('configuracion')
  configuracionCompleta() {
    return this.configuracion.listarTodo();
  }

  @Patch('configuracion/tarifas-plan/:clave')
  @Roles('SUPER_ADMIN')
  actualizarTarifaPlan(@Param('clave') clave: string, @Body() dto: ActualizarTarifaPlanDto) {
    return this.configuracion.actualizarTarifaPlan(clave, dto);
  }

  @Patch('configuracion/tarifas-servicio/:clasif')
  @Roles('SUPER_ADMIN')
  actualizarTarifaServicio(
    @Param('clasif') clasif: ClasifComision,
    @Body() dto: ActualizarTarifaServicioDto,
  ) {
    return this.configuracion.actualizarTarifaServicio(clasif, dto);
  }

  @Patch('configuracion/niveles-cirugia/:nivel')
  @Roles('SUPER_ADMIN')
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

  @Patch('configuracion/niveles-tipo-a-ra/:nivel')
  @Roles('SUPER_ADMIN')
  actualizarNivelTipoARA(
    @Param('nivel') nivel: string,
    @Body() dto: ActualizarNivelTipoARADto,
  ) {
    const numero = Number(nivel);
    if (!Number.isInteger(numero)) {
      throw new BadRequestException('El nivel debe ser un número entero');
    }
    return this.configuracion.actualizarNivelTipoARA(numero, dto);
  }

  @Patch('configuracion/tarifas-ra/:id')
  @Roles('SUPER_ADMIN')
  actualizarTarifaRa(@Param('id') id: string, @Body() dto: ActualizarTarifaRaDto) {
    return this.configuracion.actualizarTarifaRa(id, dto);
  }

  @Get('periodos/:id/objetivos')
  objetivosDelPeriodo(@Param('id') id: string) {
    return this.configuracion.objetivosParaPeriodo(id);
  }

  @Put('periodos/:id/objetivos/:tipo')
  @Roles('SUPER_ADMIN')
  guardarObjetivoDePeriodo(
    @Param('id') id: string,
    @Param('tipo') tipo: TipoVendedora,
    @Body() dto: ActualizarObjetivoDto,
  ) {
    return this.configuracion.guardarObjetivoDePeriodo(id, tipo, dto);
  }

  @Delete('periodos/:id/objetivos/:tipo')
  @Roles('SUPER_ADMIN')
  eliminarObjetivoDePeriodo(@Param('id') id: string, @Param('tipo') tipo: TipoVendedora) {
    return this.configuracion.eliminarObjetivoDePeriodo(id, tipo);
  }

  @Put('configuracion/captacion/:valor')
  @Roles('SUPER_ADMIN')
  guardarCaptacion(@Param('valor') valor: string, @Body() dto: GuardarMapeoCaptacionDto) {
    return this.configuracion.guardarMapeoCaptacion(valor, dto.canal);
  }

  @Delete('configuracion/captacion/:valor')
  @Roles('SUPER_ADMIN')
  eliminarCaptacion(@Param('valor') valor: string) {
    return this.configuracion.eliminarMapeoCaptacion(valor);
  }

  @Patch('configuracion/objetivos/:id')
  @Roles('SUPER_ADMIN')
  actualizarObjetivo(@Param('id') id: string, @Body() dto: ActualizarObjetivoDto) {
    return this.configuracion.actualizarObjetivo(id, dto);
  }

  @Patch('configuracion/parametros/:clave')
  @Roles('SUPER_ADMIN')
  actualizarParametro(@Param('clave') clave: string, @Body() dto: ActualizarParametroDto) {
    return this.configuracion.actualizarParametro(clave, dto);
  }

  /* ── Diccionario de clasificación ───────────────────────────────────── */

  /**
   * Crea la regla del diccionario Y la aplica de inmediato a las filas de
   * cualquier periodo abierto que ya estaban importadas sin clasificar y
   * calzan con ella — no solo a la próxima importación. Antes había que
   * reimportar el mes para que "Clasificar como…" surtiera efecto; recalcular
   * el mismo periodo no volvía a leer el diccionario. Ver
   * `PlanillaComisionesService.reclasificarConRegla`.
   */
  @Post('configuracion/reglas')
  @Roles('SUPER_ADMIN')
  async crearRegla(@Body() dto: CrearReglaDto) {
    const regla = await this.configuracion.crearRegla(dto);
    const filasActualizadas = await this.planilla.reclasificarConRegla(regla);
    return { ...regla, filasActualizadas };
  }

  @Patch('configuracion/reglas/:id')
  @Roles('SUPER_ADMIN')
  actualizarRegla(@Param('id') id: string, @Body() dto: CrearReglaDto) {
    return this.configuracion.actualizarRegla(id, dto);
  }

  @Delete('configuracion/reglas/:id')
  @Roles('SUPER_ADMIN')
  eliminarRegla(@Param('id') id: string) {
    return this.configuracion.eliminarRegla(id);
  }
}
