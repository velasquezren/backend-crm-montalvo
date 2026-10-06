import { interaccionesEnLinea } from './interacciones-integracion';

describe('interacciones por línea', () => {
  const original = { flag: process.env['WHATSAPP_INTERACCIONES'], lineas: process.env['WHATSAPP_INTERACCIONES_LINEAS'] };
  afterEach(() => {
    for (const [nombre, valor] of [['WHATSAPP_INTERACCIONES', original.flag], ['WHATSAPP_INTERACCIONES_LINEAS', original.lineas]] as const) {
      if (valor === undefined) delete process.env[nombre]; else process.env[nombre] = valor;
    }
  });

  it('con la bandera apagada, ninguna línea; el piloto no la enciende', () => {
    delete process.env['WHATSAPP_INTERACCIONES'];
    process.env['WHATSAPP_INTERACCIONES_LINEAS'] = 'linea-prueba';
    expect(interaccionesEnLinea('linea-prueba')).toBe(false);
  });

  it('encendida y sin piloto, todas las líneas', () => {
    process.env['WHATSAPP_INTERACCIONES'] = 'on';
    delete process.env['WHATSAPP_INTERACCIONES_LINEAS'];
    expect(interaccionesEnLinea('cualquiera')).toBe(true);
    process.env['WHATSAPP_INTERACCIONES_LINEAS'] = ' , ';
    expect(interaccionesEnLinea('cualquiera')).toBe(true);
  });

  it('encendida con piloto, solo las de la lista (con espacios tolerados); sin línea, ninguna', () => {
    process.env['WHATSAPP_INTERACCIONES'] = 'on';
    process.env['WHATSAPP_INTERACCIONES_LINEAS'] = ' linea-prueba , otra ';
    expect(interaccionesEnLinea('linea-prueba')).toBe(true);
    expect(interaccionesEnLinea('otra')).toBe(true);
    expect(interaccionesEnLinea('ventas')).toBe(false);
    expect(interaccionesEnLinea(null)).toBe(false);
  });
});
