/**
 * Cabeceras mínimas de imágenes reales (PNG, JPEG, WebP) con las medidas
 * pedidas, para pruebas: `image-size` lee las medidas de la cabecera sin
 * decodificar, así que no hace falta un archivo entero. Solo lo usan los specs.
 */
export function imagenSintetica(tipo: 'png' | 'jpg' | 'webp', ancho: number, alto: number): Buffer {
  if (tipo === 'png') {
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write('IHDR', 4, 'ascii');
    ihdr.writeUInt32BE(ancho, 8);
    ihdr.writeUInt32BE(alto, 12);
    ihdr.writeUInt8(8, 16);
    ihdr.writeUInt8(6, 17);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(64)]);
  }
  if (tipo === 'jpg') {
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, alto >> 8, alto & 0xff, ancho >> 8, ancho & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
    /* APP0 (JFIF) antes del SOF0: es como empieza un JPEG real y lo que espera el lector. */
    const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9]), Buffer.alloc(64)]);
  }
  /* WebP con VP8X: medidas en 24 bits, menos uno. */
  const vp8x = Buffer.alloc(18);
  vp8x.write('VP8X', 0, 'ascii');
  vp8x.writeUInt32LE(10, 4);
  vp8x.writeUIntLE(ancho - 1, 12, 3);
  vp8x.writeUIntLE(alto - 1, 15, 3);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + vp8x.length + 64, 4);
  riff.write('WEBP', 8, 'ascii');
  return Buffer.concat([riff, vp8x, Buffer.alloc(64)]);
}
