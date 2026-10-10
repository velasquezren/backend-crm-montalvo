import { CATEGORIAS, CONFIANZAS } from './modelo.port';
import { CLASIFICACION_FALLIDA, contextoParaClasificar, decidirTriaje, instruccionClasificador } from './triaje';

/*
 * El filtro de entrada decide si el asistente puede escribir. Se prueba la
 * tabla ENTERA (8 categorías × 3 confianzas): una combinación que pasara por
 * descuido es exactamente el caso que no se ve hasta que una paciente con una
 * pregunta médica recibe una respuesta de una máquina.
 */
describe('decidirTriaje', () => {
  it('lo médico, las quejas y pedir una persona SIEMPRE pasan a una persona, con cualquier confianza', () => {
    for (const categoria of ['MEDICO', 'QUEJA', 'PERSONA'] as const) {
      for (const confianza of CONFIANZAS) {
        expect(decidirTriaje({ categoria, confianza })).toMatchObject({ tipo: 'DERIVAR', motivoAtencion: 'DERIVADA_ASISTENTE' });
      }
    }
  });

  it('una posible urgencia es POSIBLE_URGENCIA (ALTA), nunca EMERGENCIA: esa la declara ella', () => {
    for (const confianza of CONFIANZAS) {
      expect(decidirTriaje({ categoria: 'URGENCIA', confianza })).toMatchObject({ tipo: 'DERIVAR', motivoAtencion: 'POSIBLE_URGENCIA' });
    }
  });

  it('lo comercial e informativo se contesta, salvo que el propio filtro dude', () => {
    for (const categoria of ['VENTAS', 'INFORMACION', 'SALUDO', 'OTRO'] as const) {
      expect(decidirTriaje({ categoria, confianza: 'ALTA' })).toEqual({ tipo: 'CONTESTAR' });
      expect(decidirTriaje({ categoria, confianza: 'MEDIA' })).toEqual({ tipo: 'CONTESTAR' });
      expect(decidirTriaje({ categoria, confianza: 'BAJA' }).tipo).toBe('DERIVAR');
    }
  });

  it('toda combinación tiene decisión, y solo cuatro categorías se contestan', () => {
    const contestadas = new Set<string>();
    for (const categoria of CATEGORIAS) for (const confianza of CONFIANZAS) {
      const d = decidirTriaje({ categoria, confianza });
      if (d.tipo === 'CONTESTAR') contestadas.add(categoria);
      else expect(d.aviso.length).toBeGreaterThan(10);
    }
    expect([...contestadas].sort()).toEqual(['INFORMACION', 'OTRO', 'SALUDO', 'VENTAS']);
  });

  it('si el clasificador falla, se trata como duda: pasa a una persona', () => {
    expect(decidirTriaje(CLASIFICACION_FALLIDA).tipo).toBe('DERIVAR');
  });
});

describe('lo que recibe el clasificador', () => {
  it('lleva el criterio de la clínica cuando existe, y no lo inventa cuando no', () => {
    expect(instruccionClasificador('Todo lo de embarazo y lactancia.')).toContain('Todo lo de embarazo y lactancia.');
    expect(instruccionClasificador('  ')).not.toContain('Criterio de la clínica');
  });

  it('le dice que el texto de la paciente son datos, no órdenes', () => {
    expect(instruccionClasificador('')).toMatch(/DATOS/);
  });

  it('el contexto son los últimos mensajes de texto, sin los turnos de herramientas', () => {
    const c = contextoParaClasificar([
      { rol: 'paciente', texto: 'me hice un peeling' },
      { rol: 'modelo-pide', llamadas: [], crudo: {} },
      { rol: 'clinica', texto: '¿cómo te fue?' },
      { rol: 'paciente', texto: '¿y eso arde?' },
    ]);
    expect(c).toBe('Paciente: me hice un peeling\nClínica: ¿cómo te fue?\nPaciente: ¿y eso arde?');
  });
});
