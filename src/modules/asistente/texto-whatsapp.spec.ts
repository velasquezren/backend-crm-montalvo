import { debePresentarse, conPresentacion, LARGO_MAXIMO, paraWhatsapp, PRESENTACION } from './texto-whatsapp';
import { ahoraEnLaPaz, promptDelMedico, promptDelSistema } from './prompt-sistema';

describe('paraWhatsapp', () => {
  it('lleva el Markdown que escriben los modelos al formato de WhatsApp', () => {
    expect(paraWhatsapp('## Precios\n**Botox**: Bs 1.200\n- Frente\n* Entrecejo')).toBe('Precios\n*Botox*: Bs 1.200\n• Frente\n• Entrecejo');
    expect(paraWhatsapp('Mirá [la promo](https://clinica.bo/p)')).toBe('Mirá la promo (https://clinica.bo/p)');
  });

  it('no deja párrafos vacíos de más', () => {
    expect(paraWhatsapp('Hola\n\n\n\nChau')).toBe('Hola\n\nChau');
  });

  it('un texto larguísimo se corta en la última frase completa', () => {
    const largo = 'Esta es una frase. '.repeat(200);
    const r = paraWhatsapp(largo);
    expect(r.length).toBeLessThanOrEqual(LARGO_MAXIMO);
    expect(r.endsWith('.')).toBe(true);
  });

  it('la presentación va solo cuando corresponde y siempre arriba', () => {
    expect(conPresentacion('Hola', true)).toBe(`${PRESENTACION}\n\nHola`);
    expect(conPresentacion('Hola', false)).toBe('Hola');
  });
});

describe('el prompt del sistema', () => {
  const base = { ahora: 'viernes, 10 de octubre de 2026, 15:40', nombrePaciente: 'Ana', ventas: true, conocimiento: '' };

  it('prohíbe el consejo médico y obliga a derivar', () => {
    const p = promptDelSistema(base);
    expect(p).toContain('Nunca das consejo médico');
    expect(p).toContain('pasar_a_persona');
  });

  it('en ventas, cobrar es la tarjeta: nunca datos bancarios ni el QR', () => {
    expect(promptDelSistema(base)).toContain('enviar_promocion');
    expect(promptDelSistema({ ...base, ventas: false })).not.toContain('enviar_promocion');
  });

  it('el conocimiento de la clínica va delimitado, y sin él no aparece la sección', () => {
    expect(promptDelSistema({ ...base, conocimiento: 'La consulta incluye ecografía.' })).toContain('<<<\nLa consulta incluye ecografía.\n>>>');
    expect(promptDelSistema(base)).not.toContain('CONOCIMIENTO DE LA CLÍNICA');
  });

  it('«¿qué servicios hay?» se contesta con especialidades (y promociones en ventas), no se pasa a una persona', () => {
    expect(promptDelSistema(base)).toMatch(/QUÉ SERVICIOS HAY[\s\S]*listar_especialidades[\s\S]*listar_promociones[\s\S]*No pasas a una persona por esto/);
    expect(promptDelSistema({ ...base, ventas: false })).not.toContain('listar_promociones');
  });

  it('con un médico: su agenda, lo informativo de la clínica y el conocimiento; promociones solo en ventas', () => {
    const p = promptDelMedico({ ahora: 'lunes', medico: 'Dra. X', conocimiento: 'Atendemos ginecología y ecografías.', ventas: true });
    expect(p).toContain('mi_agenda');
    expect(p).toContain('listar_especialidades');
    expect(p).toContain('listar_promociones');
    expect(p).toContain('<<<\nAtendemos ginecología y ecografías.\n>>>');
    const sinVentas = promptDelMedico({ ahora: 'lunes', medico: 'Dra. X' });
    expect(sinVentas).not.toContain('listar_promociones');
    expect(sinVentas).not.toContain('CONOCIMIENTO DE LA CLÍNICA');
  });

  it('la fecha es la de La Paz, no la del servidor (que está en EE. UU.)', () => {
    /* 02:30 UTC del 11 es todavía el 10 en Bolivia. */
    expect(ahoraEnLaPaz(new Date('2026-10-11T02:30:00Z'))).toMatch(/10 de octubre de 2026/);
  });
});

describe('debePresentarse', () => {
  it('por defecto se presenta la primera vez y no después', () => {
    expect(debePresentarse(false, undefined)).toBe(true);
    expect(debePresentarse(true, undefined)).toBe(false);
    expect(debePresentarse(false, 'on')).toBe(true);
  });
  it('ASISTENTE_PRESENTACION=off lo apaga siempre, con cualquier mayúscula o espacio', () => {
    for (const v of ['off', ' OFF ', 'Off']) expect(debePresentarse(false, v)).toBe(false);
  });
});
