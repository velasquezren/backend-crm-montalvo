/**
 * Del idioma del asistente al de Gemini y de vuelta. Puro: se prueba con
 * respuestas fabricadas, sin red. Lo que más cuidado necesita está aquí:
 *
 * - **La firma del razonamiento.** Lo que el modelo pidió vuelve como `crudo`,
 *   su `Content` intacto, con `thoughtSignature` en la parte donde vino.
 *   Gemini 3 rechaza con 400 una vuelta que la pierde.
 * - **Los turnos alternan.** Dos mensajes seguidos de la paciente son un turno
 *   con dos partes, y la conversación empieza por ella.
 */
import { Content, FinishReason, GenerateContentResponse, Part } from '@google/genai';

import { LlamadaHerramienta, RespuestaModelo, TurnoModelo, UsoModelo } from '../modelo.port';

/** Cuándo el proveedor cortó la respuesta y no hay nada que publicar. */
const CORTES: ReadonlySet<string> = new Set([
  FinishReason.SAFETY, FinishReason.BLOCKLIST, FinishReason.PROHIBITED_CONTENT, FinishReason.SPII,
  FinishReason.RECITATION, FinishReason.MALFORMED_FUNCTION_CALL, FinishReason.UNEXPECTED_TOOL_CALL,
  FinishReason.TOO_MANY_TOOL_CALLS, FinishReason.LANGUAGE,
]);

const INICIO_POR_LA_CLINICA = '(La conversación empezó con un mensaje de la clínica.)';

export function aContenidos(historial: readonly TurnoModelo[]): Content[] {
  const contenidos: Content[] = [];
  const agregar = (role: 'user' | 'model', parts: Part[]) => {
    const ultimo = contenidos[contenidos.length - 1];
    /* Solo se funden textos: un turno de llamadas del modelo va intacto. */
    if (ultimo?.role === role && parts.every(p => p.text !== undefined) && ultimo.parts?.every(p => p.text !== undefined)) {
      ultimo.parts = [...(ultimo.parts ?? []), ...parts];
      return;
    }
    contenidos.push({ role, parts });
  };
  for (const t of historial) {
    switch (t.rol) {
      case 'paciente':
        agregar('user', [{ text: t.texto }]);
        break;
      case 'clinica':
        agregar('model', [{ text: t.texto }]);
        break;
      case 'modelo-pide':
        contenidos.push(esContenido(t.crudo) ? t.crudo : { role: 'model', parts: t.llamadas.map(l => ({ functionCall: { id: l.id, name: l.nombre, args: l.argumentos } })) });
        break;
      case 'resultados':
        contenidos.push({
          role: 'user',
          parts: t.resultados.map(r => ({
            functionResponse: { ...(r.id ? { id: r.id } : {}), name: r.nombre, response: { output: r.resultado } },
          })),
        });
        break;
    }
  }
  if (contenidos[0]?.role === 'model') contenidos.unshift({ role: 'user', parts: [{ text: INICIO_POR_LA_CLINICA }] });
  return contenidos;
}

function esContenido(valor: unknown): valor is Content {
  return !!valor && typeof valor === 'object' && Array.isArray((valor as Content).parts);
}

export function usoDe(r: GenerateContentResponse): UsoModelo {
  const m = r.usageMetadata;
  return { tokensEntrada: m?.promptTokenCount ?? 0, tokensSalida: (m?.candidatesTokenCount ?? 0) + (m?.thoughtsTokenCount ?? 0) };
}

export function deRespuesta(r: GenerateContentResponse): RespuestaModelo {
  const uso = usoDe(r);
  if (r.promptFeedback?.blockReason) return { tipo: 'bloqueada', motivo: `entrada: ${r.promptFeedback.blockReason}`, uso };
  const candidato = r.candidates?.[0];
  if (!candidato) return { tipo: 'bloqueada', motivo: 'sin candidatos', uso };
  if (candidato.finishReason && CORTES.has(candidato.finishReason)) return { tipo: 'bloqueada', motivo: candidato.finishReason, uso };
  const partes = candidato.content?.parts ?? [];
  const llamadas: LlamadaHerramienta[] = partes
    .filter(p => p.functionCall?.name)
    .map(p => ({ ...(p.functionCall!.id ? { id: p.functionCall!.id } : {}), nombre: p.functionCall!.name!, argumentos: p.functionCall!.args ?? {} }));
  if (llamadas.length) return { tipo: 'herramientas', llamadas, crudo: candidato.content, uso };
  const texto = partes.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('');
  /* Cortado por largo: lo que hay puede quedar a media frase. */
  if (candidato.finishReason === FinishReason.MAX_TOKENS) return { tipo: 'bloqueada', motivo: 'MAX_TOKENS', uso };
  return { tipo: 'texto', texto, uso };
}

/** El JSON de una respuesta estructurada (`responseJsonSchema`). Lanza si no hay. */
export function jsonDe(r: GenerateContentResponse): unknown {
  const texto = (r.candidates?.[0]?.content?.parts ?? []).filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('').trim();
  if (!texto) throw new Error(`Respuesta vacía (${r.candidates?.[0]?.finishReason ?? r.promptFeedback?.blockReason ?? 'sin motivo'}).`);
  return JSON.parse(texto);
}
