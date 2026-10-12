import { writeFileSync } from 'node:fs';

import { R2Service } from '../../common/storage/r2.service';
import { AgendaMedicosCrmService } from '../agenda/agenda-medicos-crm.service';
import { svgDelHorario, textoBolivianos } from './horario-imagen';
import { escaparXml, iniciales } from './marca-imagen';
import { fotoEmbebible, ImagenHorarioService } from './imagen-horario.service';

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

  it('cada turno va a la columna de la hora en que empieza: mañana o tarde', () => {
    const svg = svgDelHorario(DATOS);
    expect(svg).toContain('>MAÑANA<');
    expect(svg).toContain('>TARDE<');
    /* El jueves tiene los dos turnos en la MISMA fila, uno en cada columna. */
    const manana = svg.indexOf('10:00 – 12:30', svg.indexOf('Jueves'));
    const tarde = svg.indexOf('15:00 – 18:00', svg.indexOf('Jueves'));
    expect(manana).toBeGreaterThan(0);
    expect(tarde).toBeGreaterThan(manana);
    const x = (hora: string) => Number(new RegExp(`<text x="([\\d.]+)"[^>]*>${hora}`).exec(svg)?.[1]);
    expect(x('15:00 – 18:00')).toBeGreaterThan(x('10:00 – 12:30'));
  });

  it('lleva el logo y el nombre de la clínica, y el precio de la consulta solo si lo hay', () => {
    expect(svgDelHorario(DATOS)).toContain('Clínica Montalvo');
    expect(svgDelHorario(DATOS)).toContain('<path');
    expect(svgDelHorario(DATOS)).not.toContain('Consulta Bs');
    expect(svgDelHorario({ ...DATOS, precioBs: 150 })).toContain('Ginecología y Obstetricia  ·  Consulta Bs 150');
    expect(textoBolivianos(150.5)).toBe('Bs 150,50');
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
    const fotoParaImagen = jest.fn().mockResolvedValue(null);
    const subir = jest.fn().mockResolvedValue(undefined);
    const leer = jest.fn().mockResolvedValue(null);
    const servicio = new ImagenHorarioService({ horarioSemanal, fotoParaImagen } as unknown as AgendaMedicosCrmService, { habilitado: true, subir, leer } as unknown as R2Service);
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

describe('la foto del médico en el horario', () => {
  const motor = new ImagenHorarioService({} as AgendaMedicosCrmService, {} as R2Service);
  /** Una «foto» PNG de verdad, dibujada por el mismo motor. */
  const fotoPng = () => motor.dibujar('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#C08457"/><circle cx="200" cy="160" r="90" fill="#7A4A2A"/></svg>');

  it('va en un retrato redondo con las iniciales debajo; sin foto, la cabecera es solo texto', async () => {
    const foto = fotoEmbebible({ bytes: await fotoPng() });
    expect(foto?.mime).toBe('image/png');
    const con = svgDelHorario({ ...DATOS, foto });
    expect(con).toContain('clip-path="url(#retrato)"');
    expect(con).toContain(`href="data:image/png;base64,${foto!.base64}"`);
    expect(con).toContain('>AR<');
    const sin = svgDelHorario(DATOS);
    expect(sin).not.toContain('<image');
    expect(sin).not.toContain('retrato');
  });

  it('solo JPEG y PNG, por sus bytes: lo demás no se dibuja', () => {
    expect(fotoEmbebible(null)).toBeNull();
    expect(fotoEmbebible({ bytes: Buffer.from('no soy una imagen') })).toBeNull();
    /* Un WebP mínimo válido: resvg no lo lee, así que no se manda al motor. */
    const webp = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=', 'base64');
    expect(fotoEmbebible({ bytes: webp })).toBeNull();
  });

  it('las iniciales dejan fuera el título', () => {
    expect(iniciales('Dra. Claudia Azogue')).toBe('CA');
    expect(iniciales('Dr Juan')).toBe('J');
    expect(iniciales('Lic. María José Rocha')).toBe('MJ');
    expect(iniciales('')).toBe('+');
  });

  it('el motor la dibuja, y una foto nueva es otra imagen en R2', async () => {
    const png = await fotoPng();
    const png2 = await motor.dibujar(svgDelHorario({ ...DATOS, foto: fotoEmbebible({ bytes: png }) }));
    expect(Buffer.from(png2.subarray(16, 20)).readUInt32BE(0)).toBe(1080);
    if (process.env['GUARDAR_PNG_HORARIO_FOTO']) writeFileSync(process.env['GUARDAR_PNG_HORARIO_FOTO'], png2);

    const horarioSemanal = jest.fn().mockResolvedValue({ nombre: DATOS.medico, especialidad: DATOS.especialidad, bloques: DATOS.bloques });
    const fotoParaImagen = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ bytes: png, tipo: 'image/png' });
    const r2 = { habilitado: true, subir: jest.fn().mockResolvedValue(undefined), leer: jest.fn().mockResolvedValue(null) };
    const servicio = new ImagenHorarioService({ horarioSemanal, fotoParaImagen } as unknown as AgendaMedicosCrmService, r2 as unknown as R2Service);
    const sinFoto = await servicio.de(7);
    const conFoto = await servicio.de(7);
    expect(sinFoto?.key).not.toBe(conFoto?.key);
    expect(fotoParaImagen).toHaveBeenCalledWith(7);
  });
});
