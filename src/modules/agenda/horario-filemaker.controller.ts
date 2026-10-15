import { Body, Controller, HttpCode, Post, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { HorarioFilemakerDto } from './dto/horario-filemaker.dto';
import { HorarioFilemakerGuard } from './horario-filemaker.guard';
import { HorarioFilemakerService } from './horario-filemaker.service';

@Controller('integraciones/filemaker/horarios')
export class HorarioFilemakerController {
  constructor(private readonly horarios: HorarioFilemakerService) {}

  @Post()
  @HttpCode(200)
  @Public()
  @UseGuards(HorarioFilemakerGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }))
  sincronizar(@Body() dto: HorarioFilemakerDto) { return this.horarios.recibir(dto); }
}
