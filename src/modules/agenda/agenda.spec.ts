import { ConfigService } from '@nestjs/config';
import { AgendaVpsClient } from './agenda-vps.client';
import { AgendaService } from './agenda.service';
import { disponibilidadDeAgenda, fechaConsultable, medicoDeAgenda, paginaAgenda, especialidadDeAgenda } from './agenda.contrato';
import { precioDelVps } from './agenda.sql';

describe('Agenda: límites, privacidad y fallos cerrados', () => {
  it('solo acepta hoy..hoy+29 en La Paz, incluido cambio de mes y año', () => {
    const ahora = new Date('2026-12-31T02:00:00Z'); // 30/12 en Bolivia
    expect(fechaConsultable('2026-12-30', ahora)).toBe(true);
    expect(fechaConsultable('2027-01-28', ahora)).toBe(true);
    for (const f of ['2026-12-29','2027-01-29','2026-02-30','2026-2-03','']) expect(fechaConsultable(f, ahora)).toBe(false);
  });
  it('no inventa precio a partir de cero, NULL, negativos o datos malformados', () => {
    for (const p of [null, '0.00', '-10.00', '400', 400, 'NaN','99999999.99']) expect(precioDelVps(p)).toBeNull();
    expect(precioDelVps('400.25')).toEqual({importeCentavos:40025,moneda:'BOB'});
  });
  it('proyecta únicamente datos públicos y no campos añadidos por el origen', () => {
    expect(medicoDeAgenda({id:'1',especialidadId:'e',nombre:'Profesional',horarioInformativo:null,modalidad:'ONLINE',precio:null,password:'privado',telefono:'privado',paciente:'privado'}))
      .toEqual({id:'1',especialidadId:'e',nombre:'Profesional',horarioInformativo:null,modalidad:'ONLINE',precio:null});
  });
  const base = () => ({version:1,medicoId:'1',fecha:'2026-10-07',zonaHoraria:'America/La_Paz',consultadoEn:new Date().toISOString(),estado:'DISPONIBLE',horarios:[{id:'1_0900',hora:'09:00'}]});
  it('rechaza horas antiguas, duplicadas, de otro médico o inconsistentes con el estado', () => {
    for (const cambio of [{consultadoEn:new Date(Date.now()-61000).toISOString()},{medicoId:'2'},{estado:'SIN_CUPOS'},{horarios:[{id:'a',hora:'09:00'},{id:'b',hora:'09:00'}]}]) {
      expect(() => disponibilidadDeAgenda({...base(),...cambio},'1','2026-10-07')).toThrow();
    }
    expect(disponibilidadDeAgenda(base(),'1','2026-10-07').horarios).toHaveLength(1);
  });
  it('una página incompleta nunca se interpreta como catálogo completo', () => {
    expect(() => paginaAgenda({version:1,pagina:1,limite:25,total:26,totalPaginas:2,datos:[]},1,25,especialidadDeAgenda)).toThrow();
  });
  it('apagada no abre ninguna conexión, ni aunque queden datos en caché', async () => {
    const cliente = new AgendaVpsClient(new ConfigService({AGENDA_VPS_LECTURA:'off'}));
    await expect(cliente.leer('especialidades',new URLSearchParams())).rejects.toMatchObject({status:503});
    expect(() => new AgendaService(cliente).especialidades({})).toThrow();
  });
  it('catálogo deduplica cargas y disponibilidad siempre se consulta de nuevo', async () => {
    const cliente = new AgendaVpsClient(new ConfigService({AGENDA_VPS_LECTURA:'on'}));
    const leer = jest.spyOn(cliente,'leer').mockResolvedValue({version:1,pagina:1,limite:25,total:0,totalPaginas:1,datos:[]});
    const servicio = new AgendaService(cliente);
    await Promise.all([servicio.especialidades({}),servicio.especialidades({})]);
    expect(leer).toHaveBeenCalledTimes(1);
    const fecha = new Intl.DateTimeFormat('en-CA',{timeZone:'America/La_Paz',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    leer.mockResolvedValue({...base(),fecha});
    await servicio.disponibilidad({medicoId:'1',fecha});
    await servicio.disponibilidad({medicoId:'1',fecha});
    expect(leer).toHaveBeenCalledTimes(3);
  });
  it('una caída no se memoriza como catálogo vacío y el siguiente intento recupera', async () => {
    const cliente = new AgendaVpsClient(new ConfigService({AGENDA_VPS_LECTURA:'on'}));
    jest.spyOn(cliente,'leer').mockRejectedValueOnce(cliente.noDisponible()).mockResolvedValue({version:1,pagina:1,limite:25,total:0,totalPaginas:1,datos:[]});
    const servicio = new AgendaService(cliente);
    await expect(servicio.especialidades({})).rejects.toMatchObject({status:503});
    expect((await servicio.especialidades({})).datos).toEqual([]);
  });
});
