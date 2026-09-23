import { contenidoAdjunto } from './contenido-adjunto';

const URL = 'https://r2.example/firmada';

describe('contenidoAdjunto', () => {
  it('la foto lleva el texto de la agente como descripción', () => {
    expect(contenidoAdjunto(URL, { key: 'wa/c/m.jpg', mime: 'image/jpeg' }, ' Así queda tu cita ')).toEqual({
      type: 'image', image: { link: URL, caption: 'Así queda tu cita' },
    });
  });

  it('sin texto, sin descripción', () => {
    expect(contenidoAdjunto(URL, { key: 'wa/c/m.png', mime: 'image/png' }, '')).toEqual({ type: 'image', image: { link: URL } });
  });

  it('el tipo sale del MIME, no de la extensión: un .docx es documento', () => {
    expect(contenidoAdjunto(URL, { key: 'memoria/u/x.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', nombre: 'Indicaciones.docx' }, '')).toEqual({
      type: 'document', document: { link: URL, filename: 'Indicaciones.docx' },
    });
  });

  it('el documento se llama como el archivo y el texto va de descripción', () => {
    expect(contenidoAdjunto(URL, { key: 'wa/c/m.pdf', mime: 'application/pdf', nombre: 'receta.pdf' }, 'Aquí su receta')).toEqual({
      type: 'document', document: { link: URL, filename: 'receta.pdf', caption: 'Aquí su receta' },
    });
  });

  it('una imagen que WhatsApp no acepta como imagen (WebP) sale como documento', () => {
    expect(contenidoAdjunto(URL, { key: 'wa/c/m.webp', mime: 'image/webp', nombre: 'foto.webp' }, '').type).toBe('document');
  });

  it('mensajes viejos sin MIME: se deduce de la extensión', () => {
    expect(contenidoAdjunto(URL, { key: 'wa/c/m.pdf' }, '').type).toBe('document');
    expect(contenidoAdjunto(URL, { key: 'wa/c/m.jpg' }, '').type).toBe('image');
    expect(contenidoAdjunto(URL, { key: 'wa/c/m.pdf' }, '')).toMatchObject({ document: { filename: 'Documento.pdf' } });
  });

  it('la descripción respeta el tope de Meta', () => {
    const r = contenidoAdjunto(URL, { key: 'a.jpg', mime: 'image/jpeg' }, 'x'.repeat(2000));
    expect(r.type === 'image' && r.image.caption?.length).toBe(1024);
  });
});
