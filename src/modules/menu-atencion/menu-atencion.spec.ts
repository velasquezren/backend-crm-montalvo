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
    promociones: [],
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
    promociones: [{ clave: 'prom0001', titulo: 'Promoción de prueba', descripcion: 'Solo para la prueba' }],
  };
}

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

  it('sin promociones cargadas no hay opción de promociones: no se inventa ninguna', () => {
    const m = ventas();
    m.promociones = [];
    expect(erroresDelMenu(m)).toContain('La opción de promociones necesita al menos una promoción cargada.');
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
    /* Claves de más en la base no viajan a ningún sitio. */
    const conExtra = leerMenu({ ...m, opciones: m.opciones.map(o => ({ ...o, extra: 'x' })) });
    expect(conExtra?.opciones[0]).not.toHaveProperty('extra');
  });
});

describe('el mensaje que recibe la paciente', () => {
  it('hasta tres opciones cortas salen como botones; Meta acepta el mensaje', () => {
    const m = ventas();
    const mensaje = mensajeDelMenu(m);
    expect(mensaje.tipo).toBe('botones');
    expect(() => validarMensaje(mensaje)).not.toThrow();
  });

  it('con más opciones sale como lista; Meta acepta el mensaje', () => {
    const mensaje = mensajeDelMenu(recepcion());
    expect(mensaje.tipo).toBe('lista');
    expect(() => validarMensaje(mensaje)).not.toThrow();
    if (mensaje.tipo !== 'lista') throw new Error('lista');
    expect(mensaje.secciones[0].opciones.map(o => o.id)).toEqual(['TALK_TO_HUMAN', 'EMERGENCY', 'BOOK_APPOINTMENT', 'INFO_hora1234', 'VIEW_LOCATION']);
  });

  it('un título que no cabe en un botón (más de 20 o con emoji) pasa a lista', () => {
    const m = ventas();
    m.opciones[1].titulo = 'Hablar con una asesora';
    expect(mensajeDelMenu(m).tipo).toBe('lista');
    m.opciones[1].titulo = 'Asesora 🙂';
    expect(mensajeDelMenu(m).tipo).toBe('lista');
  });

  it('la lista de promociones es la que cargó la clínica', () => {
    const lista = mensajeDePromociones(ventas());
    expect(lista).not.toBeNull();
    expect(() => validarMensaje(lista!)).not.toThrow();
    expect(mensajeDePromociones(recepcion())).toBeNull();
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

  it('información, ubicación y promociones se resuelven solas', () => {
    const info = accionDeSeleccion(recepcion(), 'INFO_hora1234');
    expect(info).toEqual({ tipo: 'RESPUESTA', texto: 'Atendemos de lunes a sábado.' });
    expect(seResuelveSola(info)).toBe(true);
    expect(seResuelveSola(accionDeSeleccion(recepcion(), 'VIEW_LOCATION'))).toBe(true);
    expect(seResuelveSola(accionDeSeleccion(ventas(), 'VIEW_PROMOTIONS'))).toBe(true);
    expect(seResuelveSola(accionDeSeleccion(recepcion(), 'TALK_TO_HUMAN'))).toBe(false);
  });

  it('elegir una promoción queda para la asesora, con su título', () => {
    const accion = accionDeSeleccion(ventas(), 'PROMO_prom0001');
    expect(accion).toEqual({ tipo: 'PROMOCION', titulo: 'Promoción de prueba' });
    expect(seResuelveSola(accion)).toBe(false);
  });

  it('una opción que la clínica retiró después de enviar el menú no contesta nada', () => {
    const m = recepcion();
    const id = idDeOpcion(m.opciones[3]);
    m.opciones.splice(3, 1);
    expect(accionDeSeleccion(m, id)).toBeNull();
    expect(accionDeSeleccion(m, 'PROMO_prom0001')).toBeNull();
    expect(accionDeSeleccion(null, 'TALK_TO_HUMAN')).toBeNull();
  });
});
