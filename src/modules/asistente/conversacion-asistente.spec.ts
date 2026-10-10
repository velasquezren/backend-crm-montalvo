import { ConversacionAsistente, TOPE_DE_VUELTAS } from './conversacion-asistente';
import { HerramientasAsistenteService } from './herramientas';
import { ModeloConversacional, RespuestaModelo, TurnoModelo } from './modelo.port';

/*
 * El bucle con un modelo FALSO: sin credenciales, sin red, sin Vertex.
 *
 * Es la mitad del valor de tener un puerto. Lo que se fija aquí son las cinco
 * reglas que impiden que un modelo que se porta mal haga daño: el tope de
 * vueltas, que `reservar` no esté en la mesa antes de tiempo, que un error de
 * herramienta vuelva al modelo en vez de cortar el turno, que un turno vacío no
 * se publique, y que un fallo de la herramienta no rompa nada.
 */
class ModeloGuionado implements ModeloConversacional {
  readonly entradas: { herramientasPermitidas: readonly string[]; historial: readonly TurnoModelo[] }[] = [];
  constructor(private readonly guion: RespuestaModelo[]) {}
  responder(e: { sistema: string; historial: readonly TurnoModelo[]; herramientasPermitidas: readonly string[] }): Promise<RespuestaModelo> {
    this.entradas.push({ herramientasPermitidas: e.herramientasPermitidas, historial: [...e.historial] });
    return Promise.resolve(this.guion[this.entradas.length - 1] ?? { tipo: 'texto', texto: 'fin del guion' });
  }
}

const CONTEXTO = { telefono: '+59170012345' };
const PETICION = { sistema: 'eres el asistente', contexto: CONTEXTO, historial: [], permitirReservar: false };

function montar(guion: RespuestaModelo[], ejecutar = jest.fn().mockResolvedValue({ ok: true, datos: [] })) {
  const modelo = new ModeloGuionado(guion);
  const herramientas = { ejecutar } as unknown as HerramientasAsistenteService;
  const bucle = new ConversacionAsistente(modelo, herramientas);
  jest.spyOn(bucle['logger'], 'warn').mockImplementation(() => undefined);
  return { bucle, modelo, ejecutar };
}

describe('el bucle del asistente', () => {
  it('un texto en la primera vuelta se devuelve recortado', async () => {
    const { bucle } = montar([{ tipo: 'texto', texto: '  Atiende martes y jueves.  ' }]);
    const r = await bucle.responder(PETICION);
    expect(r).toEqual({ tipo: 'responder', texto: 'Atiende martes y jueves.', vueltas: 1 });
  });

  it('pide una herramienta, recibe el resultado y después contesta', async () => {
    const { bucle, ejecutar } = montar([
      { tipo: 'herramientas', llamadas: [{ nombre: 'listar_especialidades', argumentos: {} }] },
      { tipo: 'texto', texto: 'Tenemos ginecología y maternidad.' },
    ]);
    const r = await bucle.responder(PETICION);
    expect(r.tipo).toBe('responder');
    if (r.tipo === 'responder') expect(r.vueltas).toBe(2);
    expect(ejecutar).toHaveBeenCalledTimes(1);
  });

  /* La regla 2: no se confía en que no la pida, se le quita de la mesa. */
  it('sin permiso, `reservar` NO se le ofrece al modelo', async () => {
    const { bucle, modelo } = montar([{ tipo: 'texto', texto: 'listo' }]);
    await bucle.responder(PETICION);
    expect(modelo.entradas[0].herramientasPermitidas).not.toContain('reservar');
    expect(modelo.entradas[0].herramientasPermitidas).toContain('horas_libres');
  });

  it('con permiso, sí se le ofrece y la escritura llega habilitada', async () => {
    const { bucle, modelo, ejecutar } = montar([
      { tipo: 'herramientas', llamadas: [{ nombre: 'reservar', argumentos: { medicoId: '1' } }] },
      { tipo: 'texto', texto: 'Queda pendiente de pago.' },
    ]);
    await bucle.responder({ ...PETICION, permitirReservar: true });
    expect(modelo.entradas[0].herramientasPermitidas).toContain('reservar');
    expect(ejecutar.mock.calls[0][3]).toEqual({ permitirEscritura: true });
  });

  /* La regla 3: un «esa hora ya no está» es información, no un fallo. */
  it('un resultado con `ok: false` vuelve al modelo tal cual, y el turno sigue', async () => {
    const ejecutar = jest.fn().mockResolvedValue({ ok: false, motivo: 'HORA_NO_DISPONIBLE' });
    const { bucle, modelo } = montar([
      { tipo: 'herramientas', llamadas: [{ nombre: 'reservar', argumentos: {} }] },
      { tipo: 'texto', texto: 'Esa hora se acaba de tomar; ¿te va 11:00?' },
    ], ejecutar);
    const r = await bucle.responder({ ...PETICION, permitirReservar: true });
    expect(r.tipo).toBe('responder');
    const ultimo = modelo.entradas[1].historial.at(-1);
    expect(ultimo).toMatchObject({ rol: 'herramienta-resultado', resultado: { ok: false, motivo: 'HORA_NO_DISPONIBLE' } });
  });

  /* La regla 5: una excepción no se le escapa al chat. */
  it('si la herramienta revienta, se le cuenta al modelo y el turno no se rompe', async () => {
    const ejecutar = jest.fn().mockRejectedValue(new Error('MySQL no responde'));
    const { bucle, modelo } = montar([
      { tipo: 'herramientas', llamadas: [{ nombre: 'horas_libres', argumentos: {} }] },
      { tipo: 'texto', texto: 'No puedo ver los cupos ahora; te paso con alguien.' },
    ], ejecutar);
    const r = await bucle.responder(PETICION);
    expect(r.tipo).toBe('responder');
    const ultimo = modelo.entradas[1].historial.at(-1) as { resultado: { ok: boolean; motivo: string } };
    expect(ultimo.resultado.ok).toBe(false);
    /* El mensaje técnico NO viaja al modelo: no tiene qué hacer con «MySQL no responde». */
    expect(JSON.stringify(ultimo.resultado)).not.toContain('MySQL');
  });

  /* La regla 1: el tope existe para que un bucle no se coma el presupuesto. */
  it('un modelo que solo pide herramientas se corta en el tope y pasa a una persona', async () => {
    const guion: RespuestaModelo[] = Array.from({ length: TOPE_DE_VUELTAS + 3 }, () => ({
      tipo: 'herramientas' as const, llamadas: [{ nombre: 'listar_especialidades', argumentos: {} }],
    }));
    const { bucle, modelo } = montar(guion);
    const r = await bucle.responder(PETICION);
    expect(r).toEqual({ tipo: 'pasar-a-persona', motivo: `no cerró en ${TOPE_DE_VUELTAS} vueltas`, vueltas: TOPE_DE_VUELTAS });
    expect(modelo.entradas).toHaveLength(TOPE_DE_VUELTAS);
  });

  /* La regla 4: sin cierre no se inventa un cierre. */
  it('un texto vacío no se publica: lo ve una persona', async () => {
    const { bucle } = montar([{ tipo: 'texto', texto: '   ' }]);
    const r = await bucle.responder(PETICION);
    expect(r.tipo).toBe('pasar-a-persona');
    if (r.tipo === 'pasar-a-persona') expect(r.motivo).toContain('vacío');
  });

  it('pedir herramientas y no pedir ninguna tampoco es una respuesta', async () => {
    const { bucle } = montar([{ tipo: 'herramientas', llamadas: [] }]);
    const r = await bucle.responder(PETICION);
    expect(r.tipo).toBe('pasar-a-persona');
  });

  it('varias llamadas en un turno se ejecutan todas, en orden', async () => {
    const ejecutar = jest.fn().mockResolvedValue({ ok: true, datos: [] });
    const { bucle } = montar([
      { tipo: 'herramientas', llamadas: [
        { nombre: 'listar_especialidades', argumentos: {} },
        { nombre: 'listar_medicos', argumentos: { especialidadId: 'x' } },
      ] },
      { tipo: 'texto', texto: 'listo' },
    ], ejecutar);
    await bucle.responder(PETICION);
    expect(ejecutar.mock.calls.map(c => c[0])).toEqual(['listar_especialidades', 'listar_medicos']);
  });
});
