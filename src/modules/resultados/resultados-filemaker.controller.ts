import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';
import { AvisosFilemakerGuard } from './avisos-filemaker.guard';
import { AvisoFilemakerDto } from './dto/aviso-filemaker.dto';
import { ResultadosService } from './resultados.service';

/**
 * El botón de WhatsApp del guion de ecografía de FileMaker: justo después de
 * subir el informe al portal, pide al CRM que avise al paciente.
 *
 * El envío es el MISMO que el botón «Enviar aviso» de la pantalla Resultados
 * (`ResultadosService.entregar`): revalida el informe en el portal, cruza la
 * ficha, reserva contra el doble envío y audita. FileMaker no habla con Meta
 * ni con el portal desde aquí; el CRM sigue siendo el único emisor.
 *
 * Responde 200 también cuando NO envía (ya enviado, sin ficha, enlace
 * vencido…), con `enviado: false` y el motivo en palabras de la asistente: el
 * guion lee un solo JSON en vez de interpretar códigos HTTP, que en
 * `Insertar desde URL` llegan como errores de FileMaker poco legibles. Los
 * fallos de credencial, configuración o validación sí son 4xx/5xx.
 */
@Controller('integraciones/filemaker/resultados')
export class ResultadosFilemakerController {
  constructor(private readonly service: ResultadosService) {}

  @Post(':informeId/avisar')
  @HttpCode(200)
  @Public()
  @UseGuards(AvisosFilemakerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }))
  avisar(@Param('informeId', ParseUUIDPipe) informeId: string, @Body() dto: AvisoFilemakerDto) {
    return this.service.avisarDesdeFilemaker(informeId, dto.usuario);
  }
}
