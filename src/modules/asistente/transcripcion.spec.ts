import { BYTES_MAXIMOS_AUDIO, limpiarTranscripcion, LARGO_MAXIMO_TRANSCRIPCION, mimeDeAudio } from './transcripcion';

describe('mimeDeAudio', () => {
  it('quita los parámetros que manda WhatsApp y respeta otros formatos de audio', () => {
    expect(mimeDeAudio('audio/ogg; codecs=opus')).toBe('audio/ogg');
    expect(mimeDeAudio('AUDIO/MPEG')).toBe('audio/mpeg');
    expect(mimeDeAudio('audio/mp4')).toBe('audio/mp4');
  });
  it('lo que no es un tipo de audio se trata como la nota de voz de WhatsApp', () => {
    for (const raro of [null, undefined, '', 'application/octet-stream', 'video/mp4']) expect(mimeDeAudio(raro)).toBe('audio/ogg');
  });
});

describe('limpiarTranscripcion', () => {
  it('deja el texto, sin comillas ni espacios de más', () => {
    expect(limpiarTranscripcion('  «Hola, quería una cita»  ')).toBe('Hola, quería una cita');
    expect(limpiarTranscripcion('"Hola"')).toBe('Hola');
  });
  it('lo inaudible, lo vacío y lo ausente es null: no se inventa una frase', () => {
    for (const nada of ['[INAUDIBLE]', 'inaudible', ' [ Inaudible ]. ', '', '   ', null, undefined]) expect(limpiarTranscripcion(nada)).toBeNull();
  });
  it('una frase que contiene «inaudible» entre otras palabras sí es texto', () => {
    expect(limpiarTranscripcion('El audio anterior estaba inaudible, perdón')).toBe('El audio anterior estaba inaudible, perdón');
  });
  it('se corta un monólogo larguísimo', () => {
    const t = limpiarTranscripcion('a'.repeat(5000))!;
    expect(t.length).toBe(LARGO_MAXIMO_TRANSCRIPCION + 1);
    expect(t.endsWith('…')).toBe(true);
  });
  it('el tope de bytes es de 10 MB', () => expect(BYTES_MAXIMOS_AUDIO).toBe(10 * 1024 * 1024));
});
