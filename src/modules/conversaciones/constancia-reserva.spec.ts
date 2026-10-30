import { writeFileSync } from 'node:fs';

import { R2Service } from '../../common/storage/r2.service';
import { Prisma } from '../../prisma/prisma-client';
import { AgendaMedicosCrmService } from '../agenda/agenda-medicos-crm.service';
import { FilaReservaAgenda } from '../agenda/agenda-consulta.sql';
import { ImagenHorarioService } from '../asistente/imagen-horario.service';
import { DatosConstancia, ESTADO_CONSTANCIA, svgDeConstancia, textoConstancia } from './constancia-reserva';
import { datosDeConstancia } from './constancia-reserva.service';

const DATOS: DatosConstancia = {
  reserva: 48213, fecha: '2026-10-15', hora: '09:30', paciente: 'María Fernanda López Quispe',
  medico: 'Dra. Claudia Azogue', especialidad: 'Ginecología y Obstetricia', montoBs: 150,
};

describe('la constancia de reserva', () => {
  it('el texto dice día, hora, médico y lo pagado', () => {
    const t = textoConstancia(DATOS);
    expect(t).toContain('Jueves 15 de octubre de 2026, 09:30');
    expect(t).toContain('Dra. Claudia Azogue · Ginecología y Obstetricia');
    expect(t).toContain('Pago enviado: Bs 150');
    expect(t.length).toBeLessThan(1024);
  });

  it('nunca da la cita por confirmada: el comprobante cargado no es un pago verificado', () => {
    for (const salida of [textoConstancia(DATOS), svgDeConstancia(DATOS)]) {
      expect(salida).toContain(ESTADO_CONSTANCIA);
      expect(salida).not.toMatch(/cita confirmada|está confirmada|pago confirmado/i);
    }
  });

  it('la imagen lleva lo mismo que el texto, el logo y la dirección de la clínica', () => {
    const svg = svgDeConstancia(DATOS);
    for (const esperado of ['Su reserva está registrada', '>OCT<', '>15<', '09:30', 'María Fernanda López Quispe', 'Dra. Claudia Azogue', 'Bs 150', 'Clínica Montalvo', 'Universo 641']) {
      expect(svg).toContain(esperado);
    }
  });

  /* El código de ScriptCase no es el de FileMaker ni le sirve a la paciente: confundía (16/10/2026). */
  it('ni el texto ni la imagen muestran el número de reserva', () => {
    for (const salida of [textoConstancia(DATOS), svgDeConstancia(DATOS)]) {
      expect(salida).not.toContain('48213');
      expect(salida).not.toMatch(/N\.º/);
    }
  });

  it('sin monto no inventa uno', () => {
    expect(textoConstancia({ ...DATOS, montoBs: null })).not.toContain('Pago enviado');
    expect(svgDeConstancia({ ...DATOS, montoBs: null })).not.toContain('Bs ');
  });

  it('lo que no se sabe no deja una fila vacía, y la imagen se acorta', () => {
    const completa = svgDeConstancia(DATOS);
    const sinDatos = svgDeConstancia({ ...DATOS, especialidad: null, montoBs: null });
    expect(sinDatos).not.toMatch(/Especialidad|Pago enviado|—/);
    const alto = (svg: string) => Number(/height="(\d+)"/.exec(svg)?.[1]);
    expect(alto(sinDatos)).toBe(alto(completa) - 2 * 84);
  });

  it('un nombre muy largo se achica o se corta: no pisa la etiqueta de su fila', () => {
    const svg = svgDeConstancia({ ...DATOS, paciente: 'María Fernanda de los Ángeles López Quispe de Gutiérrez Mamani' });
    const tamano = Number(/font-size="(\d+)" fill="#1F2937" text-anchor="end">María/.exec(svg)?.[1]);
    const texto = /text-anchor="end">(María[^<]*)</.exec(svg)?.[1] ?? '';
    expect(texto.length * tamano * 0.6).toBeLessThanOrEqual(640);
  });

  it('un nombre con caracteres de XML no rompe ni inyecta nada en la imagen', () => {
    const svg = svgDeConstancia({ ...DATOS, paciente: '<script>x</script> & "Hijos"', medico: 'Dr. <b>X</b>' });
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('<b>');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('de la fila de la agenda toma solo lo de la cita: ni carnet ni teléfono', () => {
    const fila: FilaReservaAgenda = {
      id: 48213, fecha: '2026-10-15', hora: '09:30:00', medicoId: 7, medico: 'Dra. Claudia Azogue', especialidad: null,
      paciente: '  ', telefono: '70012345', ci: '1234567', observaciones: null, estado: 'PAGADO', precio: '150.00',
      nit: null, razonSocial: null, tieneComprobante: true, registradaEl: null, registradaA: null,
    };
    const d = datosDeConstancia(fila, new Prisma.Decimal('150.00'));
    expect(d).toEqual({ reserva: 48213, fecha: '2026-10-15', hora: '09:30', paciente: 'Sin nombre registrado', medico: 'Dra. Claudia Azogue', especialidad: null, montoBs: 150 });
    expect(JSON.stringify(svgDeConstancia(d))).not.toMatch(/70012345|1234567/);
    expect(datosDeConstancia(fila, null).montoBs).toBeNull();
  });

  it('el motor la dibuja como PNG de 1080 de ancho', async () => {
    const motor = new ImagenHorarioService({} as AgendaMedicosCrmService, {} as R2Service);
    const png = await motor.dibujar(svgDeConstancia(DATOS));
    expect(Buffer.from(png.subarray(0, 8)).toString('hex')).toBe('89504e470d0a1a0a');
    expect(Buffer.from(png.subarray(16, 20)).readUInt32BE(0)).toBe(1080);
    if (process.env['GUARDAR_PNG_CONSTANCIA']) writeFileSync(process.env['GUARDAR_PNG_CONSTANCIA'], png);
  });
});
