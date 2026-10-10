import { ConversacionAsistente, TOPE_DE_ACCIONES, TOPE_DE_VUELTAS } from './conversacion-asistente';
import { ContextoAsistente, HerramientasAsistenteService, PuertoVentas } from './herramientas';
import { DeclaracionHerramienta, ModeloConversacional, RespuestaModelo, TurnoModelo } from './modelo.port';

/*
 * El bucle con un modelo FALSO: sin credenciales, sin red, sin Vertex.
 *
 * Es la mitad del valor de tener un puerto. Lo que se fija aquí son las reglas
 * que impiden que un modelo que se porta mal haga daño: el tope de vueltas, que
 * no se le declare lo que no puede usar, que un error de herramienta vuelva al
 * modelo, que su contenido vuelva intacto (la firma de Gemini 3), que un turno
 * vacío no se publique y que un fallo —suyo o de una herramienta— no rompa nada.
 */
const USO = { tokensEntrada: 10, tokensSalida: 5 };

class ModeloGuionado extends ModeloConversacional {
  readonly nombre = 'guionado';
  readonly entradas: { herramientas: readonly DeclaracionHerramienta[]; historial: readonly TurnoModelo[] }[] = [];
  constructor(private readonly guion: (RespuestaModelo | Error)[]) { super(); }
  responder(e: { sistema: string; historial: readonly TurnoModelo[]; herramientas: readonly DeclaracionHerramienta[] }): Promise<RespuestaModelo> {
    this.entradas.push({ herramientas: e.herramientas, historial: [...e.historial] });
    const paso = this.guion[this.entradas.length - 1] ?? { tipo: 'texto', texto: 'fin del guion', uso: USO };
    return paso instanceof Error ? Promise.reject(paso) : Promise.resolve(paso);
  }
}

const pide = (...llamadas: { nombre: string; argumentos?: Record<string, unknown> }[]): RespuestaModelo => ({
  tipo: 'herramientas',
  llamadas: llamadas.map(l => ({ nombre: l.nombre, argumentos: l.argumentos ?? {} })),
  crudo: { role: 'model', parts: llamadas.map(l => ({ functionCall: { name: l.nombre }, thoughtSignature: 'firma' })) },
  uso: USO,
});
const dice = (texto: string): RespuestaModelo => ({ tipo: 'texto', texto, uso: USO });

const VENTAS = {} as PuertoVentas;
const CONTEXTO: ContextoAsistente = { telefono: '+59170012345', ventas: VENTAS };
const PETICION = { sistema: 'eres el asistente', contexto: CONTEXTO, historial: [{ rol: 'paciente' as const, texto: 'hola' }], permitirEscritura: false };

function montar(guion: (RespuestaModelo | Error)[], ejecutar = jest.fn().mockResolvedValue({ ok: true, datos: [] })) {
  const modelo = new ModeloGuionado(guion);
  const herramientas = { ejecutar } as unknown as HerramientasAsistenteService;
  const bucle = new ConversacionAsistente(modelo, herramientas);
  jest.spyOn(bucle['logger'], 'warn').mockImplementation(() => undefined);
  return { bucle, modelo, ejecutar };
}

const nombres = (h: readonly DeclaracionHerramienta[]) => h.map(d => d.name);

describe('el bucle del asistente', () => {
  it('un texto en la primera vuelta se devuelve recortado, con su consumo', async () => {
    const { bucle } = montar([dice('  Atiende martes y jueves.  ')]);
    const r = await bucle.responder(PETICION);
    expect(r).toMatchObject({ tipo: 'terminado', texto: 'Atiende martes y jueves.', acciones: [], traza: { vueltas: 1, tokensEntrada: 10, tokensSalida: 5 } });
  });

  it('pide una herramienta, recibe el resultado y después contesta; la traza la registra', async () => {
    const { bucle, ejecutar } = montar([pide({ nombre: 'listar_especialidades' }), dice('Tenemos ginecología.')]);
    const r = await bucle.responder(PETICION);
    expect(r.tipo).toBe('terminado');
    expect(r.traza).toMatchObject({ vueltas: 2, herramientas: [{ nombre: 'listar_especialidades', ok: true }], tokensEntrada: 20 });
    expect(ejecutar).toHaveBeenCalledTimes(1);
  });

  /* Gemini 3 devuelve 400 si la firma de su razonamiento no vuelve en la misma parte. */
  it('lo que pidió el modelo vuelve INTACTO en la vuelta siguiente, con su firma', async () => {
    const pedido = pide({ nombre: 'listar_especialidades' });
    const { bucle, modelo } = montar([pedido, dice('listo')]);
    await bucle.responder(PETICION);
    const vuelta = modelo.entradas[1].historial.find(t => t.rol === 'modelo-pide');
    expect(vuelta).toMatchObject({ rol: 'modelo-pide', crudo: pedido.tipo === 'herramientas' ? pedido.crudo : null });
  });

  it('sin permiso, `reservar` NO se le declara; las de ventas, sí en una línea comercial', async () => {
    const { bucle, modelo } = montar([dice('listo')]);
    await bucle.responder(PETICION);
    expect(nombres(modelo.entradas[0].herramientas)).not.toContain('reservar');
    expect(nombres(modelo.entradas[0].herramientas)).toEqual(expect.arrayContaining(['horas_libres', 'enviar_promocion', 'estado_de_pago', 'pasar_a_persona']));
  });

  it('en una línea que no vende, las de ventas no se le declaran', async () => {
    const { bucle, modelo } = montar([dice('listo')]);
    await bucle.responder({ ...PETICION, contexto: { ...CONTEXTO, ventas: null } });
    const declaradas = nombres(modelo.entradas[0].herramientas);
    expect(declaradas).not.toContain('enviar_promocion');
    expect(declaradas).not.toContain('estado_de_pago');
    expect(declaradas).toContain('pasar_a_persona');
  });

  it('con permiso, `reservar` sí se declara y la escritura llega habilitada', async () => {
    const { bucle, modelo, ejecutar } = montar([pide({ nombre: 'reservar', argumentos: { medicoId: '1' } }), dice('Queda pendiente de pago.')]);
    await bucle.responder({ ...PETICION, permitirEscritura: true });
    expect(nombres(modelo.entradas[0].herramientas)).toContain('reservar');
    expect(ejecutar.mock.calls[0][3]).toEqual({ permitirEscritura: true });
  });

  it('un resultado con `ok: false` vuelve al modelo tal cual, y el turno sigue', async () => {
    const ejecutar = jest.fn().mockResolvedValue({ ok: false, motivo: 'Esa promoción ya no está vigente.' });
    const { bucle, modelo } = montar([pide({ nombre: 'enviar_promocion', argumentos: { promocionId: 'x' } }), dice('Esa ya terminó; te cuento otra.')], ejecutar);
    const r = await bucle.responder(PETICION);
    expect(r.tipo).toBe('terminado');
    expect(modelo.entradas[1].historial.at(-1)).toMatchObject({ rol: 'resultados', resultados: [{ nombre: 'enviar_promocion', resultado: { ok: false } }] });
    expect(r.acciones).toEqual([]);
  });

  it('las acciones de las herramientas se juntan, sin repetirse, y no viajan al modelo', async () => {
    const accion = { tipo: 'PROMOCION', promocionId: 'p1', titulo: 'Botox' };
    const ejecutar = jest.fn().mockResolvedValue({ ok: true, datos: 'Se enviará la tarjeta.', accion });
    const { bucle, modelo } = montar([
      pide({ nombre: 'enviar_promocion', argumentos: { promocionId: 'p1' } }, { nombre: 'enviar_promocion', argumentos: { promocionId: 'p1' } }),
      dice('Te la envío 👇'),
    ], ejecutar);
    const r = await bucle.responder(PETICION);
    expect(r.acciones).toEqual([accion]);
    expect(JSON.stringify(modelo.entradas[1].historial)).not.toContain('"accion"');
  });

  it('pasado el tope de acciones, otra más se rechaza y se le pide texto', async () => {
    let n = 0;
    const ejecutar = jest.fn().mockImplementation(() => Promise.resolve({ ok: true, datos: '', accion: { tipo: 'PROMOCION', promocionId: `p${++n}`, titulo: 'x' } }));
    const llamadas = Array.from({ length: TOPE_DE_ACCIONES + 2 }, (_, i) => ({ nombre: 'enviar_promocion', argumentos: { promocionId: `p${i}` } }));
    const { bucle } = montar([pide(...llamadas), dice('listo')], ejecutar);
    const r = await bucle.responder(PETICION);
    expect(r.acciones).toHaveLength(TOPE_DE_ACCIONES);
    expect(ejecutar).toHaveBeenCalledTimes(TOPE_DE_ACCIONES);
  });

  it('si solo derivó, terminar sin texto vale: no hay nada más que decir', async () => {
    const ejecutar = jest.fn().mockResolvedValue({ ok: true, datos: '', accion: { tipo: 'DERIVAR', motivo: 'MEDICO', resumen: 'Pregunta por una dosis.' } });
    const { bucle } = montar([pide({ nombre: 'pasar_a_persona', argumentos: { motivo: 'MEDICO', resumen: 'x' } }), dice('')], ejecutar);
    const r = await bucle.responder(PETICION);
    expect(r).toMatchObject({ tipo: 'terminado', texto: null, acciones: [{ tipo: 'DERIVAR', motivo: 'MEDICO' }] });
  });

  it('si la herramienta revienta, se le cuenta al modelo sin el detalle técnico y el turno no se rompe', async () => {
    const ejecutar = jest.fn().mockRejectedValue(new Error('MySQL no responde'));
    const { bucle, modelo } = montar([pide({ nombre: 'horas_libres' }), dice('No puedo ver los cupos ahora; te paso con alguien.')], ejecutar);
    const r = await bucle.responder(PETICION);
    expect(r.tipo).toBe('terminado');
    expect(r.traza.herramientas).toEqual([{ nombre: 'horas_libres', ok: false }]);
    expect(JSON.stringify(modelo.entradas[1].historial.at(-1))).not.toContain('MySQL');
  });

  it('si el MODELO falla (red, cuota, credenciales), el turno termina sin respuesta y no lanza', async () => {
    const { bucle } = montar([new Error('429 RESOURCE_EXHAUSTED')]);
    const r = await bucle.responder(PETICION);
    expect(r).toMatchObject({ tipo: 'sin-respuesta' });
    if (r.tipo === 'sin-respuesta') expect(r.motivo).toContain('429');
  });

  it('una respuesta bloqueada por el proveedor no se publica', async () => {
    const { bucle } = montar([{ tipo: 'bloqueada', motivo: 'SAFETY', uso: USO }]);
    const r = await bucle.responder(PETICION);
    expect(r.tipo).toBe('sin-respuesta');
  });

  it('un modelo que solo pide herramientas se corta en el tope', async () => {
    const guion = Array.from({ length: TOPE_DE_VUELTAS + 3 }, () => pide({ nombre: 'listar_especialidades' }));
    const { bucle, modelo } = montar(guion);
    const r = await bucle.responder(PETICION);
    expect(r).toMatchObject({ tipo: 'sin-respuesta', motivo: `No cerró en ${TOPE_DE_VUELTAS} vueltas.` });
    expect(modelo.entradas).toHaveLength(TOPE_DE_VUELTAS);
  });

  it('un texto vacío sin derivar no se publica', async () => {
    const { bucle } = montar([dice('   ')]);
    const r = await bucle.responder(PETICION);
    expect(r.tipo).toBe('sin-respuesta');
  });

  it('pedir herramientas y no pedir ninguna tampoco es una respuesta', async () => {
    const { bucle } = montar([{ tipo: 'herramientas', llamadas: [], crudo: {}, uso: USO }]);
    expect((await bucle.responder(PETICION)).tipo).toBe('sin-respuesta');
  });

  it('varias llamadas en un turno se ejecutan todas, en orden, y vuelven en un solo turno de resultados', async () => {
    const { bucle, modelo, ejecutar } = montar([pide({ nombre: 'listar_especialidades' }, { nombre: 'listar_medicos', argumentos: { especialidadId: 'x' } }), dice('listo')]);
    await bucle.responder(PETICION);
    expect(ejecutar.mock.calls.map(c => c[0])).toEqual(['listar_especialidades', 'listar_medicos']);
    const resultados = modelo.entradas[1].historial.filter(t => t.rol === 'resultados');
    expect(resultados).toHaveLength(1);
  });
});
