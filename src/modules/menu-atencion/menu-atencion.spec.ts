import { validarMensaje } from '../../common/whatsapp/interacciones/mensaje-interactivo';
import {
  accionDeSeleccion,
  erroresDelMenu,
  idDeOpcion,
  leerMenu,
  MenuAtencion,
  mensajeDelMenu,
  mensajeDePromociones,
  orientacionDeEmergencia,
  PromocionDeMenu,
  seResuelveSola,
} from './menu-atencion';

const ORIENTACION = 'Si corre peligro tu vida, acude a la emergencia más cercana. Recepción te escribirá enseguida.';

function recepcion(): MenuAtencion {
  return {
    activo: true,
    saludo: 'Hola, gracias por escribir a la Clínica. ¿En qué te ayudamos?',
    opciones: [
      { tipo: 'PERSONA', titulo: 'Hablar con una persona', respuesta: 'Listo. Una persona del equipo te responderá por aquí.' },
      { tipo: 'EMERGENCIA', titulo: 'Es una emergencia', respuesta: ORIENTACION },
      { tipo: 'CITA', titulo: 'Solicitar una cita' },
      { tipo: 'RESPUESTA', titulo: 'Horarios', clave: 'hora1234', respuesta: 'Atendemos de lunes a sábado.' },
      { tipo: 'UBICACION', titulo: 'Cómo llegar' },
    ],
  };
}
function ventas(): MenuAtencion {
  return {
    activo: true,
    saludo: 'Hola, ¿qué te interesa?',
    opciones: [
      { tipo: 'PROMOCIONES', titulo: 'Ver promociones', respuesta: 'Estas son las promociones vigentes:' },
      { tipo: 'PERSONA', titulo: 'Hablar con asesora' },
    ],
  };
}
/** Las publicadas para WhatsApp en el CRM (módulo Promociones). */
const PUBLICADAS: PromocionDeMenu[] = [
  { id: '11111111-1111-4111-8111-111111111111', titulo: 'Control prenatal completo con ecografía 4D', resumen: 'Consulta, ecografía y análisis en un solo paquete para tu tranquilidad y la de tu bebé.' },
  { id: '22222222-2222-4222-8222-222222222222', titulo: 'Vacuna antiinfluenza', resumen: 'Aplicación en el día.' },
];

describe('validación del menú', () => {
  it('un menú completo es válido', () => {
    expect(erroresDelMenu(recepcion())).toEqual([]);
    expect(erroresDelMenu(ventas())).toEqual([]);
  });

  it('siempre ofrece hablar con una persona', () => {
    const m = recepcion();
    m.opciones = m.opciones.filter(o => o.tipo !== 'PERSONA');
    expect(erroresDelMenu(m)).toContain('El menú siempre ofrece hablar con una persona.');
  });

  it('la emergencia no se ofrece sin la orientación que aprobó la clínica', () => {
    const m = recepcion();
    delete m.opciones[1].respuesta;
    expect(erroresDelMenu(m).join()).toMatch(/Opción 2: falta el texto/);
  });

  it('la opción de promociones no lleva una lista propia: solo el texto que acompaña a las del CRM', () => {
    const m = ventas();
    delete m.opciones[0].respuesta;
    expect(erroresDelMenu(m).join()).toMatch(/Opción 1: falta el texto/);
  });

  it.each([
    ['dos opciones de persona', (m: MenuAtencion) => m.opciones.push({ tipo: 'PERSONA', titulo: 'Otra persona' }), /Solo puede haber una opción de tipo PERSONA/],
    ['títulos repetidos', (m: MenuAtencion) => (m.opciones[2].titulo = 'horarios'), /título «Horarios»/],
    ['título largo', (m: MenuAtencion) => (m.opciones[0].titulo = 'Quiero hablar con alguien ya'), /hasta 24/],
    ['respuesta sin clave', (m: MenuAtencion) => delete m.opciones[3].clave, /identificador interno/],
    ['once opciones', (m: MenuAtencion) => { for (let i = 0; i < 6; i++) m.opciones.push({ tipo: 'RESPUESTA', titulo: `Info ${i}`, clave: `info000${i}`, respuesta: 'x' }); }, /entre 1 y 10/],
    ['saludo vacío', (m: MenuAtencion) => (m.saludo = ''), /saludo es obligatorio/],
  ])('rechaza %s', (_n, romper, error) => {
    const m = recepcion();
    romper(m);
    expect(erroresDelMenu(m).join(' ')).toMatch(error);
  });

  it('al leer, un menú guardado que ya no valida no se envía', () => {
    const m = recepcion();
    expect(leerMenu(m)).toEqual(m);
    expect(leerMenu({ ...m, opciones: m.opciones.filter(o => o.tipo !== 'PERSONA') })).toBeNull();
    expect(leerMenu({ ...m, opciones: 'no es una lista' })).toBeNull();
    /* Claves de más en la base (como la lista de promociones de antes) no viajan a ningún sitio. */
    const conExtra = leerMenu({ ...m, opciones: m.opciones.map(o => ({ ...o, extra: 'x' })) });
    expect(conExtra?.opciones[0]).not.toHaveProperty('extra');
  });
});

describe('el mensaje que recibe la paciente', () => {
  it('hasta tres opciones cortas salen como botones; Meta acepta el mensaje', () => {
    const mensaje = mensajeDelMenu(ventas(), { hayPromociones: true });
    expect(mensaje.tipo).toBe('botones');
    expect(() => validarMensaje(mensaje)).not.toThrow();
  });

  it('con más opciones sale como lista; Meta acepta el mensaje', () => {
    const mensaje = mensajeDelMenu(recepcion(), { hayPromociones: false });
    expect(mensaje.tipo).toBe('lista');
    expect(() => validarMensaje(mensaje)).not.toThrow();
    if (mensaje.tipo !== 'lista') throw new Error('lista');
    expect(mensaje.secciones[0].opciones.map(o => o.id)).toEqual(['TALK_TO_HUMAN', 'EMERGENCY', 'BOOK_APPOINTMENT', 'INFO_hora1234', 'VIEW_LOCATION']);
  });

  it('sin promociones publicadas para WhatsApp, la opción no aparece', () => {
    const sin = mensajeDelMenu(ventas(), { hayPromociones: false });
    if (sin.tipo !== 'botones') throw new Error('botones');
    expect(sin.opciones.map(o => o.id)).toEqual(['TALK_TO_HUMAN']);
  });

  it('un título que no cabe en un botón (más de 20 o con emoji) pasa a lista', () => {
    const m = ventas();
    m.opciones[1].titulo = 'Hablar con una asesora';
    expect(mensajeDelMenu(m, { hayPromociones: true }).tipo).toBe('lista');
    m.opciones[1].titulo = 'Asesora 🙂';
    expect(mensajeDelMenu(m, { hayPromociones: true }).tipo).toBe('lista');
  });

  it('la lista de promociones son las del CRM, acortadas a lo que admite Meta', () => {
    const lista = mensajeDePromociones(ventas(), PUBLICADAS);
    expect(lista).not.toBeNull();
    expect(() => validarMensaje(lista!)).not.toThrow();
    if (lista?.tipo !== 'lista') throw new Error('lista');
    const [primera] = lista.secciones[0].opciones;
    expect(primera.id).toBe(`PROMO_${PUBLICADAS[0].id}`);
    expect(primera.titulo.length).toBeLessThanOrEqual(24);
    expect(primera.titulo.endsWith('…')).toBe(true);
    expect(mensajeDePromociones(ventas(), [])).toBeNull();
    expect(mensajeDePromociones(recepcion(), PUBLICADAS)).toBeNull();
  });
});

describe('qué hace cada opción', () => {
  it('persona y cita piden una persona; su confirmación es opcional', () => {
    expect(accionDeSeleccion(recepcion(), 'TALK_TO_HUMAN')).toEqual({ tipo: 'PERSONA', confirmacion: 'Listo. Una persona del equipo te responderá por aquí.' });
    expect(accionDeSeleccion(recepcion(), 'BOOK_APPOINTMENT')).toEqual({ tipo: 'CITA', confirmacion: null });
  });

  it('emergencia trae la orientación aprobada; también para quien la escribe', () => {
    expect(accionDeSeleccion(recepcion(), 'EMERGENCY')).toEqual({ tipo: 'EMERGENCIA', orientacion: ORIENTACION });
    expect(orientacionDeEmergencia(recepcion())).toBe(ORIENTACION);
    expect(orientacionDeEmergencia(ventas())).toBeNull();
    expect(orientacionDeEmergencia(null)).toBeNull();
  });

  it('información, ubicación, la lista de promociones y una promoción elegida se resuelven solas', () => {
    const info = accionDeSeleccion(recepcion(), 'INFO_hora1234');
    expect(info).toEqual({ tipo: 'RESPUESTA', texto: 'Atendemos de lunes a sábado.' });
    expect(seResuelveSola(info)).toBe(true);
    expect(seResuelveSola(accionDeSeleccion(recepcion(), 'VIEW_LOCATION'))).toBe(true);
    expect(seResuelveSola(accionDeSeleccion(ventas(), 'VIEW_PROMOTIONS'))).toBe(true);
    expect(seResuelveSola(accionDeSeleccion(recepcion(), 'TALK_TO_HUMAN'))).toBe(false);
  });

  it('elegir una promoción de la lista pide su tarjeta', () => {
    const accion = accionDeSeleccion(ventas(), `PROMO_${PUBLICADAS[1].id}`);
    expect(accion).toEqual({ tipo: 'PROMOCION', promocionId: PUBLICADAS[1].id });
    expect(seResuelveSola(accion)).toBe(true);
  });

  it('una opción que la clínica retiró después de enviar el menú no contesta nada', () => {
    const m = recepcion();
    const id = idDeOpcion(m.opciones[3]);
    m.opciones.splice(3, 1);
    expect(accionDeSeleccion(m, id)).toBeNull();
    /* Un menú sin la opción de promociones no responde a un toque de promoción. */
    expect(accionDeSeleccion(m, `PROMO_${PUBLICADAS[0].id}`)).toBeNull();
    expect(accionDeSeleccion(null, 'TALK_TO_HUMAN')).toBeNull();
  });
});
