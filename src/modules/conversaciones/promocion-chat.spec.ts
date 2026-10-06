import { validarMensaje } from '../../common/whatsapp/interacciones/mensaje-interactivo';
import type { PromocionChat } from '../promociones/promociones.service';
import { codigoEnTexto, PAGAR_PROMOCION, tarjetaDePromocion, textoOtroComprobante, textoPagoConfirmado } from './promocion-chat';

const PROMO: PromocionChat = {
  id: 'p1',
  codigo: 'PRM-7K3QX',
  titulo: 'Control prenatal',
  resumen: 'Consulta y ecografía.',
  condiciones: 'Válido de lunes a viernes. No acumulable.',
  etiquetaOferta: '-20 %',
  precioRegular: 350,
  precioPromocional: 280,
  precio: 280,
  vigenteHasta: '2026-10-31',
  bannerUrl: 'https://crm.ejemplo/publico/promociones/imagenes/abc',
};

describe('el código de una promoción en un mensaje', () => {
  it.each([
    ['Hola, me interesa la promoción «Control prenatal» (PRM-7K3QX).', 'PRM-7K3QX'],
    ['prm-7k3qx', 'PRM-7K3QX'],
    ['vi el código PRM-ABCDE en la web', 'PRM-ABCDE'],
  ])('«%s» → %s', (texto, codigo) => expect(codigoEnTexto(texto)).toBe(codigo));

  it.each(['PRM-7K3Q', 'PRM-7K3QXX', 'PRM-0OIL1', 'hola', 'XPRM-7K3QX'])('«%s» no trae código', texto => {
    expect(codigoEnTexto(texto)).toBeNull();
  });
});

describe('la tarjeta de la promoción', () => {
  it('lleva banner, precio con el anterior, vigencia, condiciones y los dos botones; Meta la acepta', () => {
    const t = tarjetaDePromocion(PROMO, { puedePagar: true });
    expect(() => validarMensaje(t)).not.toThrow();
    if (t.tipo !== 'botones') throw new Error('botones');
    expect(t.imagenCabecera).toBe(PROMO.bannerUrl);
    expect(t.cuerpo).toContain('Bs 280 (antes Bs 350)');
    expect(t.cuerpo).toContain('Válida hasta el 31/10/2026');
    expect(t.cuerpo).toContain('No acumulable');
    expect(t.pie).toBe('Código PRM-7K3QX');
    expect(t.opciones.map(o => o.id)).toEqual([PAGAR_PROMOCION, 'TALK_TO_HUMAN']);
  });

  it('sin QR en la línea, o sin precio, no ofrece pagar', () => {
    const sinQr = tarjetaDePromocion(PROMO, { puedePagar: false });
    const sinPrecio = tarjetaDePromocion({ ...PROMO, precio: null, precioRegular: null, precioPromocional: null }, { puedePagar: true });
    for (const t of [sinQr, sinPrecio]) {
      if (t.tipo !== 'botones') throw new Error('botones');
      expect(t.opciones.map(o => o.id)).toEqual(['TALK_TO_HUMAN']);
    }
    expect(sinPrecio.cuerpo).not.toContain('Precio');
  });

  it('un banner sin URL absoluta https (sin CRM_URL_PUBLICA) no se manda: Meta no podría descargarlo', () => {
    const t = tarjetaDePromocion({ ...PROMO, bannerUrl: '/publico/promociones/imagenes/abc' }, { puedePagar: true });
    expect(t).not.toHaveProperty('imagenCabecera');
  });

  it('condiciones larguísimas se acortan para caber en el límite de Meta', () => {
    const t = tarjetaDePromocion({ ...PROMO, condiciones: 'x'.repeat(2000) }, { puedePagar: true });
    expect(t.cuerpo.length).toBeLessThanOrEqual(1024);
    expect(() => validarMensaje(t)).not.toThrow();
  });

  it('condiciones llenas de emojis (dos unidades UTF-16 cada uno) no la dejan sin salir: va sin condiciones', () => {
    const t = tarjetaDePromocion({ ...PROMO, condiciones: '🌸'.repeat(1000) }, { puedePagar: true });
    expect(t.cuerpo.length).toBeLessThanOrEqual(1024);
    expect(t.cuerpo).not.toContain('Condiciones');
    expect(() => validarMensaje(t)).not.toThrow();
  });
});

describe('textos del pago', () => {
  it('no prometen plazos ni dan por pagado lo que no se verificó', () => {
    expect(textoPagoConfirmado('Control prenatal', 280)).toContain('Confirmamos tu pago de Bs 280');
    expect(textoOtroComprobante('el monto no coincide')).toBe('No pudimos verificar el comprobante: el monto no coincide. Por favor, envíanos otro por aquí.');
  });
});
