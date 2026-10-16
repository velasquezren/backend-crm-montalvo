import { BadRequestException, ExecutionContext, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { HorarioFilemakerDto } from './dto/horario-filemaker.dto';
import { prepararHorarioFilemaker } from './horario-filemaker';
import { HorarioFilemakerGuard } from './horario-filemaker.guard';
import { DIAS_AGENDA } from './horario-html';

export const horarioSintetico = (): HorarioFilemakerDto => ({
  registroId: 'hm-sintetico-7', medicoCodigo: 'M07', revision: 1, estado: 'ACTIVO', sucursal: '', minutosConsulta: 30,
  dias: DIAS_AGENDA.map(dia => ({ dia, mananaInicio: dia === 'Lunes' ? '10:00' : '', mananaUltima: dia === 'Lunes' ? '12:30' : '', tardeInicio: '', tardeUltima: '' })),
});

describe('horarios de consulta de FileMaker', () => {
  it('incluye la última cita: 12:30 ocupa hasta las 13:00', () => {
    const p = prepararHorarioFilemaker(horarioSintetico());
    expect(p.activas.map(c => c.hora)).toEqual(['10:00', '10:30', '11:00', '11:30', '12:00', '12:30']);
    expect(p.bloques).toEqual([{ diaSemana: 1, inicioMinuto: 600, finMinuto: 780 }]);
  });
  it('adapta 08:30–11:45 a 15 minutos para todo el médico sin redondear', () => {
    const dto = horarioSintetico();
    Object.assign(dto.dias[0], { mananaInicio: '08:30', mananaUltima: '11:45', tardeInicio: '14:00', tardeUltima: '18:00' });
    const p = prepararHorarioFilemaker(dto);
    expect(p.minutosConsulta).toBe(15);
    expect(p.activas.filter(c => c.hora < '12:00').map(c => c.hora)).toEqual([
      '08:30', '08:45', '09:00', '09:15', '09:30', '09:45', '10:00', '10:15', '10:30', '10:45', '11:00', '11:15', '11:30', '11:45',
    ]);
    expect(p.bloques).toEqual([{ diaSemana: 1, inicioMinuto: 510, finMinuto: 720 }, { diaSemana: 1, inicioMinuto: 840, finMinuto: 1095 }]);
    expect(p.datos.minutosConsulta).toBe(30); // cuerpo original estable para reintentar
  });
  it('admite 15 explícito incluso para una única consulta y mantiene 30 por defecto', () => {
    const dto = horarioSintetico(); dto.minutosConsulta = 15;
    dto.dias[0].mananaInicio = dto.dias[0].mananaUltima = '08:45';
    expect(prepararHorarioFilemaker(dto).bloques).toEqual([{ diaSemana: 1, inicioMinuto: 525, finMinuto: 540 }]);
    expect(prepararHorarioFilemaker(horarioSintetico()).minutosConsulta).toBe(30);
  });
  it('permite media hora empezando a :15 sin inventar cupos intermedios', () => {
    const dto = horarioSintetico(); dto.dias[0].mananaInicio = '08:15'; dto.dias[0].mananaUltima = '09:15';
    const p = prepararHorarioFilemaker(dto);
    expect(p.minutosConsulta).toBe(30);
    expect(p.activas.map(c => c.hora)).toEqual(['08:15', '08:45', '09:15']);
  });
  it('rechaza el solapamiento entre turnos aunque sus inicios sean distintos', () => {
    const dto = horarioSintetico(); dto.dias[0].tardeInicio = '12:45'; dto.dias[0].tardeUltima = '13:15';
    expect(() => prepararHorarioFilemaker(dto)).toThrow('superponen');
  });
  it('respeta tarde a las 12:30 y no duplica el extremo compartido', () => {
    const dto = horarioSintetico(); dto.dias[0].tardeInicio = '12:30'; dto.dias[0].tardeUltima = '13:00';
    const p = prepararHorarioFilemaker(dto);
    expect(p.activas.filter(c => c.hora === '12:30')).toHaveLength(1);
    expect(p.activas).toHaveLength(7);
    expect(p.html.split('TARDE')[1]).toContain('12:30-13:00');
  });
  it('conserva un descanso sin ofrecer las horas intermedias', () => {
    const dto = horarioSintetico(); dto.dias[0].mananaUltima = '10:30'; dto.dias[0].tardeInicio = '12:30'; dto.dias[0].tardeUltima = '13:00';
    expect(prepararHorarioFilemaker(dto).bloques).toEqual([
      { diaSemana: 1, inicioMinuto: 600, finMinuto: 660 }, { diaSemana: 1, inicioMinuto: 750, finMinuto: 810 },
    ]);
  });
  it('un horario inactivo apaga cupos pero conserva los tramos del origen', () => {
    const dto = horarioSintetico(); dto.estado = 'INACTIVO';
    const p = prepararHorarioFilemaker(dto);
    expect(p.activas).toEqual([]); expect(p.html).toBe(''); expect(p.datos.dias[0].mananaInicio).toBe('10:00');
  });
  it.each(['tramo incompleto', 'invertido', 'fuera de grilla', 'día duplicado', 'superposición'])('rechaza %s antes de escribir', caso => {
    const dto = horarioSintetico();
    if (caso === 'tramo incompleto') dto.dias[0].mananaUltima = '';
    if (caso === 'invertido') dto.dias[0].mananaUltima = '09:30';
    if (caso === 'fuera de grilla') dto.dias[0].mananaUltima = '12:10';
    if (caso === 'día duplicado') dto.dias[1].dia = 'Lunes';
    if (caso === 'superposición') { dto.dias[0].tardeInicio = '12:00'; dto.dias[0].tardeUltima = '14:00'; }
    expect(() => prepararHorarioFilemaker(dto)).toThrow(BadRequestException);
  });
  it('la huella no depende del orden de días, propiedades ni de la revisión', () => {
    const dto = horarioSintetico(), otro = horarioSintetico(); otro.dias.reverse(); otro.revision = 2; otro.medicoCodigo = 'm07';
    otro.dias = otro.dias.map(d => ({ tardeUltima: d.tardeUltima, tardeInicio: d.tardeInicio, mananaUltima: d.mananaUltima, mananaInicio: d.mananaInicio, dia: d.dia }));
    expect(prepararHorarioFilemaker(dto).huella).toBe(prepararHorarioFilemaker(otro).huella);
  });
  it('el contrato rechaza minutos distintos, días ausentes, revisiones de texto y claves desconocidas', async () => {
    for (const cambios of [{ minutosConsulta: 10 }, { dias: [] }, { revision: '1' }, { inesperado: 'x' }]) {
      const errores = await validate(plainToInstance(HorarioFilemakerDto, { ...horarioSintetico(), ...cambios }), { whitelist: true, forbidNonWhitelisted: true });
      expect(errores.length).toBeGreaterThan(0);
    }
    expect(await validate(plainToInstance(HorarioFilemakerDto, horarioSintetico()))).toEqual([]);
  });
});

describe('credencial propia de horarios', () => {
  const token = 'secreto-sintetico-filemaker-horarios-2026';
  const contexto = (authorization?: string) => ({ switchToHttp: () => ({ getRequest: () => ({ headers: { authorization } }) }) }) as ExecutionContext;
  it('solo admite el token configurado y falla cerrado si la integración está apagada', () => {
    const config = new ConfigService({ FILEMAKER_HORARIOS_ACTIVO: 'on', FILEMAKER_HORARIOS_TOKEN: token });
    const guard = new HorarioFilemakerGuard(config);
    expect(guard.canActivate(contexto(`Bearer ${token}`))).toBe(true);
    for (const valor of [undefined, 'Bearer ', 'Bearer otro', `Basic ${token}`, `Bearer ${'x'.repeat(64)}`]) {
      expect(() => guard.canActivate(contexto(valor))).toThrow(UnauthorizedException);
    }
    expect(() => new HorarioFilemakerGuard(new ConfigService({})).canActivate(contexto(`Bearer ${token}`))).toThrow(ServiceUnavailableException);
  });
});
