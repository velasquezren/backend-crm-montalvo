import { ConfigService } from '@nestjs/config';
import { AgendaVpsClient } from './agenda-vps.client';
import { AgendaService } from './agenda.service';
import { disponibilidadDeAgenda, fechaConsultable, medicoDeAgenda, paginaAgenda, especialidadDeAgenda, todosLosMedicosDeAgenda } from './agenda.contrato';
import { consultarAgendaSql, precioDelVps } from './agenda.sql';
import { DirectorioService } from '../directorio/directorio.service';

/** El directorio aporta fotos de fichas publicadas a la reserva web y las ausencias (vacaciones) de cada médico. */
const directorio = (fotos: Map<number, string> = new Map(), ausencias: Map<number, { id: string; desde: string; hasta: string; motivo: string | null }[]> = new Map()) =>
  ({ fotosPublicasDeAgenda: jest.fn().mockResolvedValue(fotos), ausenciasDeAgenda: jest.fn().mockResolvedValue(ausencias) }) as unknown as DirectorioService;

/** Hoy en La Paz más `n` días, como AAAA-MM-DD. */
const diaLaPaz = (n = 0) => {
  const hoy = new Intl.DateTimeFormat('en-CA',{timeZone:'America/La_Paz',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const d = new Date(`${hoy}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
};

describe('Agenda: vacaciones del médico (ausencias del CRM)', () => {
  const vacaciones = new Map([[1, [{ id: 'x', desde: diaLaPaz(2), hasta: diaLaPaz(4), motivo: 'Vacaciones' }]]]);
  const cliente = () => new AgendaVpsClient(new ConfigService({AGENDA_VPS_LECTURA:'on'}));

  it('los días de vacaciones no se ofrecen y se dice desde cuándo vuelve', async () => {
    const c = cliente();
    jest.spyOn(c,'leer').mockResolvedValue({version:1,medicoId:'1',zonaHoraria:'America/La_Paz',fechas:[1,2,3,4,5].map(diaLaPaz)});
    const r = await new AgendaService(c, directorio(new Map(), vacaciones)).dias({medicoId:'1'});
    expect(r.fechas).toEqual([diaLaPaz(1), diaLaPaz(5)]);
    expect(r.ausencias).toEqual([{ desde: diaLaPaz(2), hasta: diaLaPaz(4), motivo: 'Vacaciones', vuelve: diaLaPaz(5) }]);
  });

  it('un día de vacaciones sale SIN_ATENCION y sin horas, aunque la agenda las tenga libres', async () => {
    const c = cliente();
    const fecha = diaLaPaz(3);
    jest.spyOn(c,'leer').mockResolvedValue({version:1,medicoId:'1',fecha,zonaHoraria:'America/La_Paz',consultadoEn:new Date().toISOString(),estado:'DISPONIBLE',horarios:[{id:'1_0900',hora:'09:00'}]});
    const r = await new AgendaService(c, directorio(new Map(), vacaciones)).disponibilidad({medicoId:'1',fecha});
    expect(r).toMatchObject({ estado: 'SIN_ATENCION', horarios: [], ausencia: { desde: diaLaPaz(2), hasta: diaLaPaz(4), vuelve: diaLaPaz(5) } });
    /* El id interno de la ausencia no sale hacia la web ni el asistente. */
    expect(r.ausencia).not.toHaveProperty('id');
  });

  it('sin vacaciones, la respuesta de la agenda sale tal cual', async () => {
    const c = cliente();
    const fechas = [1,2].map(diaLaPaz);
    jest.spyOn(c,'leer').mockResolvedValue({version:1,medicoId:'1',zonaHoraria:'America/La_Paz',fechas});
    expect(await new AgendaService(c, directorio()).dias({medicoId:'1'})).toEqual({medicoId:'1',zonaHoraria:'America/La_Paz',fechas});
  });
});

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
      .toEqual({id:'1',especialidadId:'e',nombre:'Profesional',horarioInformativo:null,modalidad:'ONLINE',precio:null,fotoUrl:null});
  });
  it('la foto solo se arma con una versión válida, nunca con lo que mande el origen', () => {
    const base = {id:'7',especialidadId:'e',nombre:'Profesional',horarioInformativo:null,modalidad:'ONLINE',precio:null};
    expect(medicoDeAgenda({...base,fotoVersion:'0123456789abcdef'}).fotoUrl).toMatch(/\/publico\/agenda\/fotos\/7\/0123456789abcdef$/);
    expect(() => medicoDeAgenda({...base,fotoVersion:'../../etc/passwd'})).toThrow();
    expect(medicoDeAgenda({...base,fotoUrl:'https://otro.test/x.jpg'}).fotoUrl).toBeNull();
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
    expect(() => new AgendaService(cliente, directorio()).especialidades({})).toThrow();
  });
  it('catálogo deduplica cargas y disponibilidad siempre se consulta de nuevo', async () => {
    const cliente = new AgendaVpsClient(new ConfigService({AGENDA_VPS_LECTURA:'on'}));
    const leer = jest.spyOn(cliente,'leer').mockResolvedValue({version:1,pagina:1,limite:25,total:0,totalPaginas:1,datos:[]});
    const servicio = new AgendaService(cliente, directorio());
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
    const servicio = new AgendaService(cliente, directorio());
    await expect(servicio.especialidades({})).rejects.toMatchObject({status:503});
    expect((await servicio.especialidades({})).datos).toEqual([]);
  });
  it('todos los médicos: una sola lectura (dos consultas), con su especialidad y en caché', async () => {
    const E = 'e'.repeat(64);
    const sql: string[] = [];
    const db = {
      execute: jest.fn(async (q: string) => {
        sql.push(q);
        return q.includes('FROM horarios')
          ? [[{ medico_pk: 1, dia: 'Lunes', primera: '09:00', ultima: '12:00' }]]
          : [[{ medico_pk: 1, nombre: 'Juan Carlos Montalvo', sigla: 'Dr.', foto: null, horario_publicado: 1, precio_con: '300.00', especialidad_id: E, especialidad_nombre: 'Ginecología' }]];
      }),
      query: jest.fn(),
    };
    const crudo = await consultarAgendaSql(db as never, 'todos', new URLSearchParams());
    expect(sql).toHaveLength(2);
    expect(sql[0]).toContain("WHERE m.estado = 'ACTIVO'");
    expect(sql[0]).toContain('LIMIT 1000');
    expect(todosLosMedicosDeAgenda(crudo)).toEqual([{
      medico: { id: '1', especialidadId: E, nombre: 'Dr. Juan Carlos Montalvo', horarioInformativo: 'Lunes: entre 09:00 y 12:00', modalidad: 'ONLINE', precio: { importeCentavos: 30000, moneda: 'BOB' }, fotoUrl: null },
      especialidad: { id: E, nombre: 'Ginecología' },
    }]);

    const cliente = new AgendaVpsClient(new ConfigService({AGENDA_VPS_LECTURA:'on'}));
    const leer = jest.spyOn(cliente,'leer').mockResolvedValue(crudo);
    const servicio = new AgendaService(cliente, directorio());
    await Promise.all([servicio.todosLosMedicos(), servicio.todosLosMedicos()]);
    await servicio.todosLosMedicos();
    expect(leer).toHaveBeenCalledTimes(1);
    expect(leer).toHaveBeenCalledWith('todos', expect.any(URLSearchParams));
  });
  it('todos los médicos: lo malformado o duplicado no pasa, y una caída es 503', async () => {
    const E = 'e'.repeat(64);
    const fila = (id: string, esp = E) => ({ medico: {id,especialidadId:E,nombre:'P',horarioInformativo:null,modalidad:'ONLINE',precio:null}, especialidad: {id:esp,nombre:'G'} });
    expect(() => todosLosMedicosDeAgenda({version:1,datos:[fila('1'),fila('1')]})).toThrow();
    expect(() => todosLosMedicosDeAgenda({version:1,datos:[fila('1','f'.repeat(64))]})).toThrow();
    expect(() => todosLosMedicosDeAgenda({version:2,datos:[]})).toThrow();
    const cliente = new AgendaVpsClient(new ConfigService({AGENDA_VPS_LECTURA:'on'}));
    jest.spyOn(cliente,'leer').mockResolvedValue({version:1,datos:'no'});
    await expect(new AgendaService(cliente, directorio()).todosLosMedicos()).rejects.toMatchObject({status:503});
  });
  it('la foto de la ficha web publicada gana a la de ScriptCase; si el directorio falla, queda la de ScriptCase', async () => {
    const cliente = new AgendaVpsClient(new ConfigService({AGENDA_VPS_LECTURA:'on'}));
    const medico = (id: string) => ({id,especialidadId:'e'.repeat(64),nombre:'Profesional',horarioInformativo:null,modalidad:'ONLINE',precio:null,fotoVersion:'0123456789abcdef'});
    jest.spyOn(cliente,'leer').mockResolvedValue({version:1,pagina:1,limite:25,total:2,totalPaginas:1,datos:[medico('1'),medico('2')]});
    const conFoto = new AgendaService(cliente, directorio(new Map([[1, 'https://crm.test/publico/directorio/fotos/x']])));
    const r = await conFoto.medicos({ especialidadId: 'e'.repeat(64) });
    expect(r.datos.map(m => m.fotoUrl)).toEqual(['https://crm.test/publico/directorio/fotos/x', expect.stringMatching(/\/publico\/agenda\/fotos\/2\//)]);
    const caido = { fotosPublicasDeAgenda: jest.fn().mockRejectedValue(new Error('sin base')) } as unknown as DirectorioService;
    const r2 = await new AgendaService(cliente, caido).medicos({ especialidadId: 'e'.repeat(64) });
    expect(r2.datos[0].fotoUrl).toMatch(/\/publico\/agenda\/fotos\/1\//);
  });
});
