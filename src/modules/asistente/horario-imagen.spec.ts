import { writeFileSync } from 'node:fs';

import { R2Service } from '../../common/storage/r2.service';
import { AgendaMedicosCrmService } from '../agenda/agenda-medicos-crm.service';
import { escaparXml, svgDelHorario } from './horario-imagen';
import { ImagenHorarioService } from './imagen-horario.service';

const DATOS = {
  medico: 'Dra. Argentina Ruiz Ames',
  especialidad: 'Ginecología y Obstetricia',
  bloques: [
    { diaSemana: 2, inicioMinuto: 600, finMinuto: 750 },
    { diaSemana: 4, inicioMinuto: 600, finMinuto: 750 },
    { diaSemana: 4, inicioMinuto: 900, finMinuto: 1080 },
    { diaSemana: 6, inicioMinuto: 480, finMinuto: 630 },
  ],
};

describe('el SVG del horario', () => {
  it('lleva el nombre, la especialidad y cada bloque con su hora de fin', () => {
    const svg = svgDelHorario(DATOS);
    expect(svg).toContain('Dra. Argentina Ruiz Ames');
    expect(svg).toContain('Ginecología y Obstetricia');
    expect(svg).toContain('10:00 – 12:30');
    expect(svg).toContain('15:00 – 18:00');
    /* Lunes, miércoles y viernes no atiende: lo dice, no deja la fila vacía. */
    expect(svg.match(/No atiende/g)).toHaveLength(3);
  });

  it('un nombre con caracteres de XML no rompe la imagen', () => {
    expect(escaparXml('Dr. <Pérez> & "Hijos"')).toBe('Dr. &lt;Pérez&gt; &amp; &quot;Hijos&quot;');
    expect(svgDelHorario({ ...DATOS, medico: 'Dr. <b>X</b>' })).not.toContain('<b>');
  });

  it('un nombre larguísimo se achica o se corta en vez de salirse', () => {
    const svg = svgDelHorario({ ...DATOS, medico: 'Dr. '.padEnd(120, 'Nombre Larguísimo ') });
    expect(svg).toContain('…');
  });
});

describe('la imagen PNG', () => {
  it('el motor WASM dibuja un PNG de 1080 de ancho con la letra del proyecto', async () => {
    const servicio = new ImagenHorarioService({} as AgendaMedicosCrmService, {} as R2Service);
    const png = await servicio.dibujar(svgDelHorario(DATOS));
    expect(Buffer.from(png.subarray(0, 8)).toString('hex')).toBe('89504e470d0a1a0a');
    /* Ancho en la cabecera IHDR (bytes 16-19). */
    expect(Buffer.from(png.subarray(16, 20)).readUInt32BE(0)).toBe(1080);
    if (process.env['GUARDAR_PNG_HORARIO']) writeFileSync(process.env['GUARDAR_PNG_HORARIO'], png);
  });

  it('se dibuja una vez por versión del horario y se reutiliza la clave de R2', async () => {
    const horarioSemanal = jest.fn().mockResolvedValue({ nombre: DATOS.medico, especialidad: DATOS.especialidad, bloques: DATOS.bloques });
    const subir = jest.fn().mockResolvedValue(undefined);
    const leer = jest.fn().mockResolvedValue(null);
    const servicio = new ImagenHorarioService({ horarioSemanal } as unknown as AgendaMedicosCrmService, { habilitado: true, subir, leer } as unknown as R2Service);
    const a = await servicio.de(7);
    const b = await servicio.de(7);
    expect(a).toEqual(b);
    expect(a?.key).toMatch(/^asistente\/horarios\/7-[0-9a-f]{16}\.png$/);
    expect(subir).toHaveBeenCalledTimes(1);
  });

  it('sin R2, o un médico sin horario, no hay imagen: quien llama manda el texto', async () => {
    const sinR2 = new ImagenHorarioService({} as AgendaMedicosCrmService, { habilitado: false } as unknown as R2Service);
    expect(await sinR2.de(7)).toBeNull();
    const sinHorario = new ImagenHorarioService({ horarioSemanal: jest.fn().mockResolvedValue(null) } as unknown as AgendaMedicosCrmService, { habilitado: true } as unknown as R2Service);
    expect(await sinHorario.de(7)).toBeNull();
  });
});
