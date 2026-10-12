import { writeFileSync } from 'node:fs';

import { R2Service } from '../../common/storage/r2.service';
import { AgendaDelDia, armarAgendaDelDia } from '../agenda/agenda-medico-citas';
import { AgendaMedicosCrmService } from '../agenda/agenda-medicos-crm.service';
import {
  ANCHO_AGENDA, fechaLarga, FILAS_MAXIMAS, pieDeLaImagen, resumenEnPalabras, svgDeAgendaMedico, textoListado, textoResumen,
} from './agenda-medico-imagen';
import { ImagenAgendaMedicoService } from './imagen-agenda-medico.service';
import { ImagenHorarioService } from './imagen-horario.service';

const MEDICO = 'Dra. Claudia Azogue';
const DIA = '2026-10-12';
const AGENDA = armarAgendaDelDia(DIA,
  [{ hora: '09:00', paciente: 'Ana Pérez' }, { hora: '09:45', paciente: 'Luis Gómez' }],
  [{ hora: '12:00', paciente: 'Carla Soto', estado: 'PAGADO' }, { hora: '15:00', paciente: 'Dina Rojas', estado: 'PENDIENTE' }]);
const VACIA = armarAgendaDelDia(DIA, [], []);
const MUCHAS = armarAgendaDelDia(DIA, Array.from({ length: 60 }, (_, i) => ({ hora: `${String(8 + Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`, paciente: `Paciente ${i + 1}` })), []);

describe('el texto de la agenda', () => {
  it('la fecha se escribe en español sin pasar por una zona horaria', () => {
    expect(fechaLarga('2026-10-12')).toBe('lunes 12 de octubre de 2026');
    expect(fechaLarga('2026-01-01')).toBe('jueves 1 de enero de 2026');
    expect(fechaLarga('mañana')).toBe('mañana');
  });

  it('el resumen cuenta bien en singular y plural, y dice cuando no hay nada', () => {
    expect(resumenEnPalabras(AGENDA)).toBe('4 citas: 2 confirmadas y 2 pendientes.');
    expect(resumenEnPalabras(armarAgendaDelDia(DIA, [{ hora: '09:00', paciente: 'A' }], []))).toBe('1 cita: 1 confirmada.');
    expect(resumenEnPalabras(VACIA)).toBe('No hay citas registradas.');
  });

  it('«cuántas tengo»: solo cantidades, con el desglose por estado y la nota de qué es pendiente', () => {
    const t = textoResumen(MEDICO, AGENDA);
    expect(t).toContain('Agenda de Dra. Claudia Azogue');
    expect(t).toContain('lunes 12 de octubre de 2026');
    expect(t).toContain('• Confirmadas: 2');
    expect(t).toContain('• Por confirmar: 1');
    expect(t).toContain('• Pago por verificar: 1');
    expect(t).toContain('recepción todavía no cerró');
    /* Es un resumen: ni un nombre de paciente. */
    expect(t).not.toMatch(/Ana|Luis|Carla|Dina/);
  });

  it('un día vacío se dice sin rodeos y sin nota de pendientes', () => {
    expect(textoResumen(MEDICO, VACIA)).toContain('No tienes citas registradas para este día.');
    expect(textoListado(MEDICO, VACIA)).toContain('No tienes citas registradas para este día.');
    expect(textoResumen(MEDICO, VACIA)).not.toContain('recepción todavía');
  });

  it('el listado en texto lleva hora, paciente y estado de cada cita', () => {
    const t = textoListado(MEDICO, AGENDA);
    expect(t).toContain('09:00 · Ana Pérez · Confirmada');
    expect(t).toContain('12:00 · Carla Soto · Pago por verificar');
    expect(t).toContain('15:00 · Dina Rojas · Por confirmar');
  });

  it('el listado largo se corta con un aviso, y el pie de la imagen nunca lleva la lista', () => {
    const t = textoListado(MEDICO, MUCHAS);
    expect(t).toContain('… y 15 citas más.');
    expect(t.length).toBeLessThan(4096);
    const pie = pieDeLaImagen(MEDICO, AGENDA);
    expect(pie).not.toMatch(/Ana|Luis|Carla|Dina/);
    expect(pie.length).toBeLessThan(1024);
  });
});

describe('el SVG de la agenda', () => {
  it('lleva el médico, la fecha, las cantidades y cada cita con su hora y su estado', () => {
    const svg = svgDeAgendaMedico(MEDICO, AGENDA);
    for (const esperado of [MEDICO, 'lunes 12 de octubre de 2026', '09:00', 'Ana Pérez', 'Luis Gómez', 'Carla Soto', 'Dina Rojas', 'Confirmada', 'Por confirmar', 'Pago por verificar']) {
      expect(svg).toContain(esperado);
    }
  });

  it('separa la mañana de la tarde, con cuántas hay en cada una, y el total en la cabecera', () => {
    const svg = svgDeAgendaMedico(MEDICO, AGENDA);
    expect(svg).toContain('>MAÑANA<');
    expect(svg).toContain('>3 citas<');
    expect(svg).toContain('>TARDE<');
    expect(svg).toContain('>1 cita<');
    /* Dina (15:00) va después del título de la tarde; Carla (12:00), antes. */
    expect(svg.indexOf('Carla Soto')).toBeLessThan(svg.indexOf('>TARDE<'));
    expect(svg.indexOf('Dina Rojas')).toBeGreaterThan(svg.indexOf('>TARDE<'));
    expect(svg).toMatch(/text-anchor="end">4<\/text>/);
    /* Un día solo de mañana no dibuja una sección de tarde vacía. */
    expect(svgDeAgendaMedico(MEDICO, armarAgendaDelDia(DIA, [{ hora: '09:00', paciente: 'Ana Pérez' }], []))).not.toContain('>TARDE<');
  });

  it('es determinista: los mismos datos dan exactamente el mismo dibujo', () => {
    expect(svgDeAgendaMedico(MEDICO, AGENDA)).toBe(svgDeAgendaMedico(MEDICO, structuredClone(AGENDA)));
    expect(svgDeAgendaMedico(MEDICO, AGENDA)).not.toBe(svgDeAgendaMedico(MEDICO, VACIA));
  });

  it('un nombre con caracteres de XML no rompe ni inyecta nada en la imagen', () => {
    const a: AgendaDelDia = armarAgendaDelDia(DIA, [{ hora: '09:00', paciente: '<script>alert(1)</script> & "Hijos"' }], []);
    const svg = svgDeAgendaMedico('Dr. <b>X</b>', a);
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('<b>');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('un día vacío dice que no hay citas; uno enorme dibuja un tope de filas y cuenta el resto', () => {
    expect(svgDeAgendaMedico(MEDICO, VACIA)).toContain('No hay citas registradas para este día');
    const svg = svgDeAgendaMedico(MEDICO, MUCHAS);
    expect(svg).toContain(`Paciente ${FILAS_MAXIMAS}<`);
    expect(svg).not.toContain(`Paciente ${FILAS_MAXIMAS + 1}<`);
    expect(svg).toContain('… y 30 citas más');
  });

  it('un nombre de paciente larguísimo se achica o se corta en vez de salirse', () => {
    const svg = svgDeAgendaMedico(MEDICO, armarAgendaDelDia(DIA, [{ hora: '09:00', paciente: 'Nombre '.repeat(40) }], []));
    expect(svg).toContain('…');
  });
});

describe('la imagen PNG de la agenda', () => {
  it('el motor dibuja un PNG de 1080 de ancho con los datos de verdad', async () => {
    const motor = new ImagenHorarioService({} as AgendaMedicosCrmService, {} as R2Service);
    const png = await motor.dibujar(svgDeAgendaMedico(MEDICO, AGENDA));
    expect(Buffer.from(png.subarray(0, 8)).toString('hex')).toBe('89504e470d0a1a0a');
    expect(Buffer.from(png.subarray(16, 20)).readUInt32BE(0)).toBe(ANCHO_AGENDA);
    if (process.env['GUARDAR_PNG_AGENDA']) writeFileSync(process.env['GUARDAR_PNG_AGENDA'], png);
  });

  it('la clave de R2 es la huella del dibujo: la misma agenda es el mismo archivo y se sube una vez', async () => {
    const dibujar = jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    const guardados = new Set<string>();
    const r2 = {
      habilitado: true,
      leer: jest.fn(async (k: string) => (guardados.has(k) ? { cuerpo: null } : null)),
      subir: jest.fn(async (k: string) => { guardados.add(k); }),
    };
    const servicio = new ImagenAgendaMedicoService({ dibujar } as unknown as ImagenHorarioService, r2 as unknown as R2Service);
    const a = await servicio.de(MEDICO, AGENDA);
    const b = await servicio.de(MEDICO, structuredClone(AGENDA));
    expect(a).toEqual(b);
    expect(a?.key).toMatch(/^asistente\/agenda-medico\/[0-9a-f]{24}\.png$/);
    expect(dibujar).toHaveBeenCalledTimes(1);
    /* Otra cita nueva es otro archivo. */
    const c = await servicio.de(MEDICO, armarAgendaDelDia(DIA, [{ hora: '09:00', paciente: 'Otra' }], []));
    expect(c?.key).not.toBe(a?.key);
  });

  it('sin R2, o si el motor falla, no hay imagen y no se rompe el turno: quien llama manda el texto', async () => {
    const sinR2 = new ImagenAgendaMedicoService({} as ImagenHorarioService, { habilitado: false } as unknown as R2Service);
    expect(await sinR2.de(MEDICO, AGENDA)).toBeNull();
    const falla = new ImagenAgendaMedicoService(
      { dibujar: jest.fn().mockRejectedValue(new Error('wasm')) } as unknown as ImagenHorarioService,
      { habilitado: true, leer: jest.fn().mockResolvedValue(null), subir: jest.fn() } as unknown as R2Service,
    );
    expect(await falla.de(MEDICO, AGENDA)).toBeNull();
  });
});
