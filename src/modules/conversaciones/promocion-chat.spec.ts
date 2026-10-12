import { validarMensaje } from '../../common/whatsapp/interacciones/mensaje-interactivo';
import type { PromocionChat } from '../promociones/promociones.service';
import {
  codigoEnTexto, conceptoDeServicio, ELEGIR_SERVICIO, listaDeServicios, opcionPagarServicio, PAGAR_PROMOCION, servicioDeOpcion,
  tarjetaDePromocion, tarjetaDeServicio, textoOtroComprobante, textoPagoConfirmado,
} from './promocion-chat';

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
  servicios: [],
};

/** Como el banner real de «Octubre Rosa»: cinco servicios, cada uno con su precio. */
const ROSA: PromocionChat = {
  ...PROMO,
  id: 'p2', codigo: 'PRM-TWEBY', titulo: 'Octubre Rosa', resumen: 'Cinco servicios de ginecología con precio especial.',
  etiquetaOferta: null, precioRegular: null, precioPromocional: null, precio: null,
  condiciones: 'Precios de promoción válidos hasta el 31 de octubre de 2026. Cada servicio se paga y se agenda por separado. Sujeto a disponibilidad de horarios.',
  servicios: [
    { id: '11111111-1111-4111-8111-111111111111', nombre: 'Ecografía Mamaria', precioRegular: 446, precioPromocional: 268 },
    { id: '22222222-2222-4222-8222-222222222222', nombre: 'Consulta Ginecológica', precioRegular: 250, precioPromocional: 175 },
    { id: '33333333-3333-4333-8333-333333333333', nombre: 'Ecografía Transvaginal', precioRegular: 298, precioPromocional: 209 },
    { id: '44444444-4444-4444-8444-444444444444', nombre: 'Papanicolaou + Colposcopia', precioRegular: 213, precioPromocional: 150 },
    { id: '55555555-5555-4555-8555-555555555555', nombre: 'Cultivo Vaginal', precioRegular: 170, precioPromocional: 120 },
  ],
};

describe('una promoción con varios servicios (Octubre Rosa)', () => {
  it('la tarjeta lista cada servicio con su precio y el anterior tachado; «Pagar ahora» lleva a elegir; Meta la acepta', () => {
    const t = tarjetaDePromocion(ROSA, { puedePagar: true });
    expect(() => validarMensaje(t)).not.toThrow();
    if (t.tipo !== 'botones') throw new Error('tipo');
    expect(t.cuerpo).toContain('• Ecografía Mamaria: *Bs 268* ~Bs 446~');
    expect(t.cuerpo).toContain('• Cultivo Vaginal: *Bs 120* ~Bs 170~');
    expect(t.cuerpo).toContain('Condiciones: Precios de promoción');
    expect(t.opciones.map(o => o.id)).toEqual([ELEGIR_SERVICIO, 'TALK_TO_HUMAN']);
    /* Sin QR en la línea, no se ofrece pagar. */
    if (tarjetaDePromocion(ROSA, { puedePagar: false }).tipo === 'botones') {
      expect((tarjetaDePromocion(ROSA, { puedePagar: false }) as { opciones: { id: string }[] }).opciones.map(o => o.id)).toEqual(['TALK_TO_HUMAN']);
    }
  });

  it('la lista para elegir: una fila por servicio, el título cabe en 24 y el nombre completo y el precio van en la descripción', () => {
    const l = listaDeServicios(ROSA);
    expect(() => validarMensaje(l)).not.toThrow();
    if (l.tipo !== 'lista') throw new Error('tipo');
    const filas = l.secciones[0].opciones;
    expect(filas).toHaveLength(5);
    expect(filas[3].titulo.length).toBeLessThanOrEqual(24);
    expect(filas[3].descripcion).toBe('Bs 150 (antes Bs 213) · Papanicolaou + Colposcopia');
    expect(filas.map(f => servicioDeOpcion(f.id))).toEqual(ROSA.servicios.map(s => s.id));
  });

  it('la tarjeta de UN servicio cobra ese, sin pasar por la lista', () => {
    const t = tarjetaDeServicio(ROSA, ROSA.servicios[0], { puedePagar: true });
    expect(() => validarMensaje(t)).not.toThrow();
    if (t.tipo !== 'botones') throw new Error('tipo');
    expect(t.cuerpo.startsWith('*Ecografía Mamaria*\nOctubre Rosa')).toBe(true);
    expect(t.cuerpo).toContain('💰 *Bs 268* ~Bs 446~');
    expect(t.opciones[0].id).toBe(opcionPagarServicio(ROSA.servicios[0].id));
  });

  it('la opción de pagar un servicio se reconoce solo con su prefijo, y el concepto dice promoción y servicio', () => {
    expect(servicioDeOpcion(opcionPagarServicio('abc'))).toBe('abc');
    expect(servicioDeOpcion('PAGAR_SERVICIO:')).toBeNull();
    expect(servicioDeOpcion(PAGAR_PROMOCION)).toBeNull();
    expect(servicioDeOpcion(undefined)).toBeNull();
    expect(conceptoDeServicio('Octubre Rosa', 'Ecografía Mamaria')).toBe('Octubre Rosa · Ecografía Mamaria');
  });
});

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
    expect(t.cuerpo).toContain('💰 *Bs 280* ~Bs 350~');
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
