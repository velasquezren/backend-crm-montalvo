import { Body, Controller, Get, Header, HttpCode, Param, ParseIntPipe, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ArchivoSubido } from '../../common/archivos/archivo-subido';
import { Public } from '../../common/decorators/public.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { BYTES_MAXIMOS_IMAGEN } from '../../common/storage/imagen-publica';
import { AgendaReservasService } from './agenda-reservas.service';
import { AgendaService } from './agenda.service';
import { QueryDisponibilidadAgendaDto, QueryMedicosAgendaDto } from './dto/query-agenda.dto';
import { CrearReservaAgendaDto, PagoReservaAgendaDto } from './dto/reserva-agenda.dto';

/**
 * La agenda para la landing. Las lecturas y las reservas las llama el
 * navegador de la paciente directamente (CORS solo para el origen de la
 * landing, sin cookies: ver `main.ts`), así el límite por IP es por paciente y
 * no compartido entre todas las visitas que salen desde Vercel.
 */
@Public()
@Controller('publico/agenda')
export class AgendaPublicaController {
  constructor(
    private readonly agenda: AgendaService,
    private readonly reservas: AgendaReservasService,
  ) {}

  @Get('especialidades')
  @Header('Cache-Control', 'no-store')
  especialidades(@Query() query: PaginationDto) { return this.agenda.especialidades(query); }

  @Get('medicos')
  @Header('Cache-Control', 'no-store')
  medicos(@Query() query: QueryMedicosAgendaDto) { return this.agenda.medicos(query); }

  @Get('disponibilidad')
  @Header('Cache-Control', 'no-store')
  disponibilidad(@Query() query: QueryDisponibilidadAgendaDto) { return this.agenda.disponibilidad(query); }

  /** Cinco reservas cada 10 minutos por IP: suficiente para una familia, poco para un bot. */
  @Post('reservas')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Throttle({ general: { limit: 5, ttl: 600_000 } })
  reservar(@Body() dto: CrearReservaAgendaDto) { return this.reservas.reservar(dto); }

  /** La referencia va en el cuerpo, no en la ruta: las rutas quedan en el log. */
  @Post('reservas/pago')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Throttle({ general: { limit: 10, ttl: 600_000 } })
  @UseInterceptors(FileInterceptor('comprobante', { limits: { fileSize: BYTES_MAXIMOS_IMAGEN, files: 1, fields: 5 } }))
  pagar(@Body() dto: PagoReservaAgendaDto, @UploadedFile() archivo: ArchivoSubido | undefined) {
    return this.reservas.registrarPago(dto, archivo);
  }

  /** La landing la muestra con un <img>: sin CORP cross-origin, helmet la bloquearía. */
  @Get('qr/:bancoId')
  @Header('Cache-Control', 'public, max-age=600')
  @Header('Cross-Origin-Resource-Policy', 'cross-origin')
  qr(@Param('bancoId', ParseIntPipe) bancoId: number) { return this.reservas.qr(bancoId); }
}
