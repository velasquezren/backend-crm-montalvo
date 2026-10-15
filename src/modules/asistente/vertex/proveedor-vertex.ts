/**
 * El adaptador de Gemini en Vertex (Google Cloud): lo ÚNICO que necesita
 * credenciales. Todo lo demás del asistente se prueba sin él.
 *
 * Configuración (docs/asistente-ia.md tiene el paso a paso de Google Cloud):
 *
 *   ASISTENTE_IA=on                         interruptor general; apagado no llama a nada
 *   GOOGLE_CLOUD_PROJECT=<proyecto>
 *   GOOGLE_CLOUD_LOCATION=global            los Gemini 3 están en el extremo global
 *   GOOGLE_APPLICATION_CREDENTIALS=<ruta>   la llave JSON de la cuenta de servicio
 *   GEMINI_API_KEY=<clave>                  ALTERNATIVA para probar: la API de Gemini con clave (Google AI
 *                                           Studio), sin proyecto ni cuenta de servicio. Si está, manda sobre
 *                                           Vertex. La capa gratuita puede usar lo que se envía para mejorar
 *                                           los productos de Google: NO con pacientes reales.
 *   ASISTENTE_MODELO=gemini-3.5-flash       estable, sin retiro antes de mayo de 2027
 *   ASISTENTE_MODELO_CLASIFICADOR=gemini-3.5-flash-lite
 *   ASISTENTE_MODELO_RESPALDO=gemini-3.7-flash     si el principal tarda, la copia de la PRIMERA vuelta
 *                                           va a este otro modelo (`off` = copia al mismo). Ver `RESPALDO_*`.
 *   ASISTENTE_MODELO_TRANSCRIPCION=gemini-3.5-flash   las notas de voz; su copia va al clasificador
 *
 * El modelo va por variable y con nombre EXACTO: los alias `-latest` cambian de
 * modelo sin avisar, y Google retira versiones (los 2.5 dejan Vertex el
 * 20/10/2026). Cambiar de modelo es cambiar una variable y reiniciar.
 */
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  FunctionCallingConfigMode, GenerateContentParameters, GenerateContentResponse, GoogleGenAI, ThinkingLevel,
} from '@google/genai';
import { existsSync } from 'node:fs';
import { conRespaldo } from './con-respaldo';

import { datosComprobanteDe, ESQUEMA_COMPROBANTE, INSTRUCCION_COMPROBANTE } from '../comprobante';
import { INSTRUCCION_TRANSCRIPCION, limpiarTranscripcion, mimeDeAudio } from '../transcripcion';
import {
  CATEGORIAS, Clasificacion, ClasificadorMensajes, CONFIANZAS, SOLICITUDES, DatosComprobante, DeclaracionHerramienta, LectorComprobantes,
  ModeloConversacional, RespuestaModelo, TranscriptorAudio, TurnoModelo, UsoModelo,
} from '../modelo.port';
import { contextoParaClasificar, instruccionClasificador } from '../triaje';
import { aContenidos, deRespuesta, jsonDe, textoDe, usoDe } from './traduccion';

export const MODELO_POR_DEFECTO = 'gemini-3.5-flash';
export const CLASIFICADOR_POR_DEFECTO = 'gemini-3.5-flash-lite';
/*
 * Elegidos con datos del 14/10/2026 (recorrido `asistente:caminos` en el servidor y
 * 16 notas de voz sintéticas). Conversar: 3.7 Flash pasó los mismos caminos que
 * 3.8 Flash (26/27, la otra era un falso positivo de la prueba); 3.5 Flash dio un
 * precio equivocado y no pidió aclaración, así que no sirve de respaldo. Notas de
 * voz: 3.5 Flash p50 2,9 s y sin errores de nombres; 3.8 Flash tuvo 429 y 32 s de p90.
 */
export const RESPALDO_POR_DEFECTO = 'gemini-3.7-flash';
export const TRANSCRIPCION_POR_DEFECTO = 'gemini-3.5-flash';

export interface EstadoProveedorIA {
  readonly encendido: boolean;
  readonly proyecto: boolean;
  /** Hay `GEMINI_API_KEY`: se llama a la API de Gemini con clave, no a Vertex. */
  readonly claveApi: boolean;
  readonly credenciales: 'ARCHIVO' | 'ARCHIVO_INEXISTENTE' | 'AMBIENTE';
  readonly ubicacion: string;
  readonly modelo: string;
  readonly modeloClasificador: string;
  /** Adónde va la copia de la primera vuelta si el principal tarda; `null` = al mismo modelo. */
  readonly modeloRespaldo: string | null;
  readonly modeloTranscripcion: string;
  /** Todo lo necesario para llamar está puesto. No prueba que Google acepte las credenciales. */
  readonly listo: boolean;
}

@Injectable()
export class ConfiguracionIA {
  constructor(private readonly config: ConfigService) {}

  private valor(clave: string): string {
    return (this.config.get<string>(clave) ?? '').trim();
  }

  get encendida(): boolean { return this.valor('ASISTENTE_IA') === 'on'; }
  get proyecto(): string { return this.valor('GOOGLE_CLOUD_PROJECT'); }
  get claveApi(): string { return this.valor('GEMINI_API_KEY'); }
  get ubicacion(): string { return this.valor('GOOGLE_CLOUD_LOCATION') || 'global'; }
  get modelo(): string { return this.valor('ASISTENTE_MODELO') || MODELO_POR_DEFECTO; }
  get modeloClasificador(): string { return this.valor('ASISTENTE_MODELO_CLASIFICADOR') || CLASIFICADOR_POR_DEFECTO; }
  get modeloRespaldo(): string | null {
    const v = this.valor('ASISTENTE_MODELO_RESPALDO') || RESPALDO_POR_DEFECTO;
    return v === 'off' || v === this.modelo ? null : v;
  }
  get modeloTranscripcion(): string { return this.valor('ASISTENTE_MODELO_TRANSCRIPCION') || TRANSCRIPCION_POR_DEFECTO; }

  estado(): EstadoProveedorIA {
    const archivo = this.valor('GOOGLE_APPLICATION_CREDENTIALS');
    /* Sin la variable, la librería busca las credenciales del entorno (una VM de
       Google, `gcloud auth application-default`): puede funcionar, no se sabe hasta llamar. */
    const credenciales = !archivo ? 'AMBIENTE' : existsSync(archivo) ? 'ARCHIVO' : 'ARCHIVO_INEXISTENTE';
    return {
      encendido: this.encendida,
      proyecto: !!this.proyecto,
      claveApi: !!this.claveApi,
      credenciales,
      ubicacion: this.ubicacion,
      modelo: this.modelo,
      modeloClasificador: this.modeloClasificador,
      modeloRespaldo: this.modeloRespaldo,
      modeloTranscripcion: this.modeloTranscripcion,
      listo: this.encendida && (!!this.claveApi || (!!this.proyecto && credenciales !== 'ARCHIVO_INEXISTENTE')),
    };
  }
}

/** Cuánto se espera a Gemini. Una paciente no espera un minuto: mejor que conteste una persona. */
const ESPERA_CONVERSAR_MS = 30_000;
const ESPERA_CLASIFICAR_MS = 10_000;
const ESPERA_LEER_MS = 45_000;
/** Una nota de voz de WhatsApp dura segundos: si no se transcribe en esto, se le pide que lo escriba. */
const ESPERA_TRANSCRIBIR_MS = 20_000;

/*
 * Cuándo se lanza la copia de una llamada lenta (`conRespaldo`), medido en Cloud
 * Monitoring del proyecto (14/10/2026). 3.8 Flash: p50 1,8 s y p99 67 s en 7 días;
 * en una noche mala, p50 7,6 s y p90 39 s. Cuando un modelo entero se pone lento,
 * su copia también tarda: por eso la primera vuelta copia a OTRO modelo
 * (`modeloRespaldo`), pronto. Desde la segunda vuelta el turno sigue con el modelo
 * que ganó (la firma de su razonamiento solo vale para él) y la copia es a ese mismo.
 * Clasificar (3.5 Flash-Lite): p50 0,9 s, p90 1,5 s. Notas de voz: p90 4,2 s con
 * 3.5 Flash; la copia va al clasificador, 1,7 s.
 */
const RESPALDO_PRIMERA_VUELTA_MS = 2_500;
const RESPALDO_MISMO_MODELO_MS = 4_000;
const RESPALDO_CLASIFICAR_MS = 2_500;
const RESPALDO_TRANSCRIBIR_MS = 3_000;
const RESPALDO_LEER_MS = 8_000;

/** Lo que devolvió Gemini y QUÉ modelo lo hizo (el principal o el de la copia). */
export interface Generada {
  readonly respuesta: GenerateContentResponse;
  readonly modelo: string;
}

/** La copia de una llamada lenta: cuándo sale y, si se quiere, a qué otro modelo. */
export interface Respaldo {
  readonly trasMs: number;
  readonly modelo?: string | null;
}

@Injectable()
export class ClienteVertex {
  private readonly logger = new Logger(ClienteVertex.name);
  private cliente: GoogleGenAI | null = null;

  constructor(private readonly cfg: ConfiguracionIA) {}

  /**
   * Una llamada, con su tiempo máximo y sus etiquetas de facturación. Con
   * `respaldo`, si tarda más que `trasMs` se lanza una copia —al mismo modelo o a
   * `respaldo.modelo`— y gana la primera (ver `conRespaldo`).
   */
  async generar(params: GenerateContentParameters, esperaMs: number, respaldo?: Respaldo): Promise<Generada> {
    if (!this.cfg.estado().listo) throw new ServiceUnavailableException('El asistente de IA no está configurado en el servidor.');
    if (!this.cliente) {
      this.cliente = this.cfg.claveApi
        ? new GoogleGenAI({ apiKey: this.cfg.claveApi })
        : new GoogleGenAI({ enterprise: true, project: this.cfg.proyecto, location: this.cfg.ubicacion });
      this.logger.log(this.cfg.claveApi ? `API de Gemini (clave) lista: ${this.cfg.modelo}` : `Vertex listo: ${this.cfg.proyecto} · ${this.cfg.ubicacion} · ${this.cfg.modelo}`);
    }
    /* Las etiquetas de facturación son de Vertex: la API con clave las rechaza (400), así que ni las de quien llama. */
    const { labels, ...config } = params.config ?? {};
    const uso = labels?.['uso'] ?? 'asistente';
    const cliente = this.cliente;
    const modeloDe = (intento: number) => (intento > 0 && respaldo?.modelo) || params.model;
    return conRespaldo(async (abortSignal, espera, intento) => {
      const modelo = modeloDe(intento);
      const respuesta = await cliente.models.generateContent({
        ...params,
        model: modelo,
        config: {
          ...config,
          abortSignal,
          httpOptions: { timeout: espera },
          /* Aparecen en la factura de Google Cloud: cuánto cuesta cada uso. */
          ...(this.cfg.claveApi ? {} : { labels: { aplicacion: 'crm-montalvo', uso } }),
        },
      });
      return { respuesta, modelo };
    }, {
      esperaMs,
      respaldoTrasMs: respaldo?.trasMs,
      alLanzarRespaldo: () => this.logger.log(`${params.model} tarda más de ${respaldo?.trasMs} ms (${uso}): se lanza una copia a ${modeloDe(1)} y se usa la primera que llegue.`),
    });
  }
}

@Injectable()
export class ModeloVertex extends ModeloConversacional {
  constructor(private readonly cliente: ClienteVertex, private readonly cfg: ConfiguracionIA) { super(); }

  get nombre(): string { return this.cfg.modelo; }

  /**
   * Sin `modelo` es la primera vuelta del turno: el principal, y si tarda, una copia
   * al de respaldo. Con `modelo`, el turno sigue con el que contestó la primera.
   */
  async responder(entrada: { sistema: string; historial: readonly TurnoModelo[]; herramientas: readonly DeclaracionHerramienta[]; modelo?: string }): Promise<RespuestaModelo> {
    const { respuesta, modelo } = await this.cliente.generar({
      model: entrada.modelo ?? this.cfg.modelo,
      contents: aContenidos(entrada.historial),
      config: {
        systemInstruction: entrada.sistema,
        ...(entrada.herramientas.length
          ? {
              tools: [{ functionDeclarations: entrada.herramientas.map(h => ({ ...h })) }],
              toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
            }
          : {}),
        /* NO es opcional. Con el automático, el SDK ejecutaría lo que el modelo
           pide sin pasar por el despachador, y la regla «el modelo nunca decide
           una escritura» dejaría de existir. */
        automaticFunctionCalling: { disable: true },
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        maxOutputTokens: 2048,
        labels: { uso: 'conversar' },
      },
    }, ESPERA_CONVERSAR_MS, entrada.modelo
      ? { trasMs: RESPALDO_MISMO_MODELO_MS }
      : { trasMs: RESPALDO_PRIMERA_VUELTA_MS, modelo: this.cfg.modeloRespaldo });
    return { ...deRespuesta(respuesta), modelo };
  }
}

@Injectable()
export class ClasificadorVertex extends ClasificadorMensajes {
  constructor(private readonly cliente: ClienteVertex, private readonly cfg: ConfiguracionIA) { super(); }

  get nombre(): string { return this.cfg.modeloClasificador; }

  async clasificar(entrada: { mensaje: string; contexto: readonly TurnoModelo[]; criterio: string }): Promise<Clasificacion> {
    const contexto = contextoParaClasificar(entrada.contexto);
    const { respuesta: r } = await this.cliente.generar({
      model: this.cfg.modeloClasificador,
      contents: [{ role: 'user', parts: [{ text: `${contexto ? `Mensajes anteriores:\n${contexto}\n\n` : ''}Mensaje a clasificar:\n${entrada.mensaje.slice(0, 2000)}` }] }],
      config: {
        systemInstruction: instruccionClasificador(entrada.criterio),
        responseMimeType: 'application/json',
        responseJsonSchema: {
          type: 'object',
          properties: { categoria: { type: 'string', enum: [...CATEGORIAS] }, confianza: { type: 'string', enum: [...CONFIANZAS] }, solicitud: { type: 'string', enum: [...SOLICITUDES] } },
          required: ['categoria', 'confianza', 'solicitud'],
        },
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        maxOutputTokens: 256,
        labels: { uso: 'clasificar' },
      },
    }, ESPERA_CLASIFICAR_MS, { trasMs: RESPALDO_CLASIFICAR_MS });
    return { ...clasificacionDe(jsonDe(r)), uso: usoDe(r) };
  }
}

/** Valida la clasificación; lanza si no tiene la forma pedida (y entonces se trata como «no sé»). */
export function clasificacionDe(valor: unknown): Pick<Clasificacion, 'categoria' | 'confianza' | 'solicitud'> {
  const o = (valor ?? {}) as Record<string, unknown>;
  const categoria = CATEGORIAS.find(c => c === o['categoria']);
  const confianza = CONFIANZAS.find(c => c === o['confianza']);
  if (!categoria || !confianza) throw new Error('La clasificación no tiene la forma pedida.');
  const solicitud = SOLICITUDES.find(s => s === o['solicitud']) ?? 'CONSULTAR';
  return { categoria, confianza, solicitud };
}

@Injectable()
export class LectorVertex extends LectorComprobantes {
  constructor(private readonly cliente: ClienteVertex, private readonly cfg: ConfiguracionIA) { super(); }

  get nombre(): string { return this.cfg.modelo; }

  async leer(archivo: { bytes: Uint8Array; mime: string }): Promise<{ datos: DatosComprobante; uso: UsoModelo }> {
    const { respuesta: r } = await this.cliente.generar({
      model: this.cfg.modelo,
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: archivo.mime, data: Buffer.from(archivo.bytes).toString('base64') } },
          { text: INSTRUCCION_COMPROBANTE },
        ],
      }],
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: ESQUEMA_COMPROBANTE,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        maxOutputTokens: 1024,
        labels: { uso: 'leer-comprobante' },
      },
    }, ESPERA_LEER_MS, { trasMs: RESPALDO_LEER_MS, modelo: this.cfg.modeloRespaldo });
    return { datos: datosComprobanteDe(jsonDe(r)), uso: usoDe(r) };
  }
}

/**
 * Las notas de voz a texto, con su propio modelo (`modeloTranscripcion`): oír mal a
 * la paciente cuesta más que medio segundo, así que se eligió por precisión con
 * nombres de médicos y, entre los precisos, el estable. Si tarda, la copia va al
 * clasificador, que transcribe casi igual y en 1,7 s.
 */
@Injectable()
export class TranscriptorVertex extends TranscriptorAudio {
  constructor(private readonly cliente: ClienteVertex, private readonly cfg: ConfiguracionIA) { super(); }

  get nombre(): string { return this.cfg.modeloTranscripcion; }

  async transcribir(audio: { bytes: Uint8Array; mime: string }): Promise<{ texto: string | null; uso: UsoModelo }> {
    const { respuesta: r } = await this.cliente.generar({
      model: this.cfg.modeloTranscripcion,
      contents: [{
        role: 'user',
        parts: [
          { text: INSTRUCCION_TRANSCRIPCION },
          { inlineData: { mimeType: mimeDeAudio(audio.mime), data: Buffer.from(audio.bytes).toString('base64') } },
        ],
      }],
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        maxOutputTokens: 1024,
        labels: { uso: 'transcribir-audio' },
      },
    }, ESPERA_TRANSCRIBIR_MS, { trasMs: RESPALDO_TRANSCRIBIR_MS, modelo: this.cfg.modeloClasificador });
    return { texto: limpiarTranscripcion(textoDe(r)), uso: usoDe(r) };
  }
}
