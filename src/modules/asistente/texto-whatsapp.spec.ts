import { conPresentacion, LARGO_MAXIMO, paraWhatsapp, PRESENTACION } from './texto-whatsapp';
import { ahoraEnLaPaz, promptDelSistema } from './prompt-sistema';

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

  it('la fecha es la de La Paz, no la del servidor (que está en EE. UU.)', () => {
    /* 02:30 UTC del 11 es todavía el 10 en Bolivia. */
    expect(ahoraEnLaPaz(new Date('2026-10-11T02:30:00Z'))).toMatch(/10 de octubre de 2026/);
  });
});
