import { FinishReason, GenerateContentResponse } from '@google/genai';

import { aContenidos, deRespuesta, jsonDe } from './traduccion';
import { clasificacionDe } from './proveedor-vertex';

/* Respuestas fabricadas con la forma real del SDK: sin red, sin credenciales. */
function respuesta(r: Partial<GenerateContentResponse>): GenerateContentResponse {
  return Object.assign(new GenerateContentResponse(), r);
}
const USO = { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 12 };

describe('del historial a `contents`', () => {
  it('la conversación empieza por ella; si empezó la clínica, se antepone un turno de usuario', () => {
    const c = aContenidos([{ rol: 'clinica', texto: 'Hola, ¿en qué te ayudo?' }, { rol: 'paciente', texto: 'precio botox' }]);
    expect(c.map(x => x.role)).toEqual(['user', 'model', 'user']);
  });

  it('dos mensajes seguidos de ella son UN turno con dos partes', () => {
    const c = aContenidos([{ rol: 'paciente', texto: 'hola' }, { rol: 'paciente', texto: 'una consulta' }]);
    expect(c).toEqual([{ role: 'user', parts: [{ text: 'hola' }, { text: 'una consulta' }] }]);
  });

  it('lo que pidió el modelo vuelve como SU contenido, con la firma en su parte', () => {
    const crudo = { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'estado_de_pago', args: {} }, thoughtSignature: 'FIRMA' }] };
    const c = aContenidos([
      { rol: 'paciente', texto: 'ya pagué' },
      { rol: 'modelo-pide', llamadas: [{ id: 'c1', nombre: 'estado_de_pago', argumentos: {} }], crudo },
      { rol: 'resultados', resultados: [{ id: 'c1', nombre: 'estado_de_pago', argumentos: {}, resultado: { ok: true } }] },
    ]);
    expect(c[1]).toBe(crudo);
    expect(c[2]).toEqual({ role: 'user', parts: [{ functionResponse: { id: 'c1', name: 'estado_de_pago', response: { output: { ok: true } } } }] });
  });

  it('un turno de llamadas no se funde con un texto del mismo rol', () => {
    const crudo = { role: 'model', parts: [{ functionCall: { name: 'x', args: {} } }] };
    const c = aContenidos([{ rol: 'paciente', texto: 'a' }, { rol: 'clinica', texto: 'b' }, { rol: 'modelo-pide', llamadas: [], crudo }]);
    expect(c).toHaveLength(3);
  });
});

describe('de la respuesta de Gemini', () => {
  it('las llamadas a funciones salen con su contenido crudo y el consumo (pensamiento incluido)', () => {
    const contenido = { role: 'model', parts: [{ functionCall: { id: 'a', name: 'listar_promociones', args: {} }, thoughtSignature: 'F' }] };
    const r = deRespuesta(respuesta({ candidates: [{ content: contenido, finishReason: FinishReason.STOP }], usageMetadata: USO }));
    expect(r).toEqual({ tipo: 'herramientas', llamadas: [{ id: 'a', nombre: 'listar_promociones', argumentos: {} }], crudo: contenido, uso: { tokensEntrada: 120, tokensSalida: 42 } });
  });

  it('el texto se arma sin los pensamientos', () => {
    const r = deRespuesta(respuesta({ candidates: [{ content: { role: 'model', parts: [{ text: 'razono…', thought: true }, { text: 'Hola ' }, { text: 'Ana' }] } }] }));
    expect(r).toMatchObject({ tipo: 'texto', texto: 'Hola Ana' });
  });

  it('un corte por seguridad, una entrada bloqueada o un texto truncado no se publican', () => {
    expect(deRespuesta(respuesta({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: FinishReason.SAFETY }] })).tipo).toBe('bloqueada');
    expect(deRespuesta(respuesta({ promptFeedback: { blockReason: 'SAFETY' as never } })).tipo).toBe('bloqueada');
    expect(deRespuesta(respuesta({ candidates: [{ content: { parts: [{ text: 'a medias' }] }, finishReason: FinishReason.MAX_TOKENS }] })).tipo).toBe('bloqueada');
    expect(deRespuesta(respuesta({})).tipo).toBe('bloqueada');
  });

  it('la respuesta estructurada se lee como JSON; vacía, lanza diciendo por qué', () => {
    expect(jsonDe(respuesta({ candidates: [{ content: { parts: [{ text: '{"categoria":"VENTAS","confianza":"ALTA"}' }] } }] }))).toEqual({ categoria: 'VENTAS', confianza: 'ALTA' });
    expect(() => jsonDe(respuesta({ candidates: [{ content: { parts: [] }, finishReason: FinishReason.SAFETY }] }))).toThrow('SAFETY');
  });

  it('una clasificación fuera de la lista se rechaza (y el filtro la trata como duda)', () => {
    expect(clasificacionDe({ categoria: 'VENTAS', confianza: 'ALTA' })).toEqual({ categoria: 'VENTAS', confianza: 'ALTA' });
    expect(() => clasificacionDe({ categoria: 'COMPRAS', confianza: 'ALTA' })).toThrow();
    expect(() => clasificacionDe(null)).toThrow();
  });
});
