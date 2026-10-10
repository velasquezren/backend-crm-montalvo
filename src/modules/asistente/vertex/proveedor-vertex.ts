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
 *   ASISTENTE_MODELO=gemini-3.5-flash       estable, sin retiro antes de mayo de 2027
 *   ASISTENTE_MODELO_CLASIFICADOR=gemini-3.5-flash-lite
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

import { datosComprobanteDe, ESQUEMA_COMPROBANTE, INSTRUCCION_COMPROBANTE } from '../comprobante';
import {
  CATEGORIAS, Clasificacion, ClasificadorMensajes, CONFIANZAS, DatosComprobante, DeclaracionHerramienta, LectorComprobantes,
  ModeloConversacional, RespuestaModelo, TurnoModelo, UsoModelo,
} from '../modelo.port';
import { contextoParaClasificar, instruccionClasificador } from '../triaje';
import { aContenidos, deRespuesta, jsonDe, usoDe } from './traduccion';

export const MODELO_POR_DEFECTO = 'gemini-3.5-flash';
export const CLASIFICADOR_POR_DEFECTO = 'gemini-3.5-flash-lite';

export interface EstadoProveedorIA {
  readonly encendido: boolean;
  readonly proyecto: boolean;
  readonly credenciales: 'ARCHIVO' | 'ARCHIVO_INEXISTENTE' | 'AMBIENTE';
  readonly ubicacion: string;
  readonly modelo: string;
  readonly modeloClasificador: string;
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
  get ubicacion(): string { return this.valor('GOOGLE_CLOUD_LOCATION') || 'global'; }
  get modelo(): string { return this.valor('ASISTENTE_MODELO') || MODELO_POR_DEFECTO; }
  get modeloClasificador(): string { return this.valor('ASISTENTE_MODELO_CLASIFICADOR') || CLASIFICADOR_POR_DEFECTO; }

  estado(): EstadoProveedorIA {
    const archivo = this.valor('GOOGLE_APPLICATION_CREDENTIALS');
    /* Sin la variable, la librería busca las credenciales del entorno (una VM de
       Google, `gcloud auth application-default`): puede funcionar, no se sabe hasta llamar. */
    const credenciales = !archivo ? 'AMBIENTE' : existsSync(archivo) ? 'ARCHIVO' : 'ARCHIVO_INEXISTENTE';
    return {
      encendido: this.encendida,
      proyecto: !!this.proyecto,
      credenciales,
      ubicacion: this.ubicacion,
      modelo: this.modelo,
      modeloClasificador: this.modeloClasificador,
      listo: this.encendida && !!this.proyecto && credenciales !== 'ARCHIVO_INEXISTENTE',
    };
  }
}

/** Cuánto se espera a Gemini. Una paciente no espera un minuto: mejor que conteste una persona. */
const ESPERA_CONVERSAR_MS = 30_000;
const ESPERA_CLASIFICAR_MS = 10_000;
const ESPERA_LEER_MS = 45_000;

@Injectable()
export class ClienteVertex {
  private readonly logger = new Logger(ClienteVertex.name);
  private cliente: GoogleGenAI | null = null;

  constructor(private readonly cfg: ConfiguracionIA) {}

  /** Una llamada, con su tiempo máximo y sus etiquetas de facturación. */
  async generar(params: GenerateContentParameters, esperaMs: number): Promise<GenerateContentResponse> {
    if (!this.cfg.estado().listo) throw new ServiceUnavailableException('El asistente de IA no está configurado en el servidor.');
    if (!this.cliente) {
      this.cliente = new GoogleGenAI({ enterprise: true, project: this.cfg.proyecto, location: this.cfg.ubicacion });
      this.logger.log(`Vertex listo: ${this.cfg.proyecto} · ${this.cfg.ubicacion} · ${this.cfg.modelo}`);
    }
    return this.cliente.models.generateContent({
      ...params,
      config: {
        ...params.config,
        httpOptions: { timeout: esperaMs },
        /* Aparecen en la factura de Google Cloud: cuánto cuesta cada uso. */
        labels: { aplicacion: 'crm-montalvo', uso: (params.config?.labels?.['uso'] ?? 'asistente') },
      },
    });
  }
}

@Injectable()
export class ModeloVertex extends ModeloConversacional {
  constructor(private readonly cliente: ClienteVertex, private readonly cfg: ConfiguracionIA) { super(); }

  get nombre(): string { return this.cfg.modelo; }

  async responder(entrada: { sistema: string; historial: readonly TurnoModelo[]; herramientas: readonly DeclaracionHerramienta[] }): Promise<RespuestaModelo> {
    const r = await this.cliente.generar({
      model: this.cfg.modelo,
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
    }, ESPERA_CONVERSAR_MS);
    return deRespuesta(r);
  }
}

@Injectable()
export class ClasificadorVertex extends ClasificadorMensajes {
  constructor(private readonly cliente: ClienteVertex, private readonly cfg: ConfiguracionIA) { super(); }

  get nombre(): string { return this.cfg.modeloClasificador; }

  async clasificar(entrada: { mensaje: string; contexto: readonly TurnoModelo[]; criterio: string }): Promise<Clasificacion> {
    const contexto = contextoParaClasificar(entrada.contexto);
    const r = await this.cliente.generar({
      model: this.cfg.modeloClasificador,
      contents: [{ role: 'user', parts: [{ text: `${contexto ? `Mensajes anteriores:\n${contexto}\n\n` : ''}Mensaje a clasificar:\n${entrada.mensaje.slice(0, 2000)}` }] }],
      config: {
        systemInstruction: instruccionClasificador(entrada.criterio),
        responseMimeType: 'application/json',
        responseJsonSchema: {
          type: 'object',
          properties: { categoria: { type: 'string', enum: [...CATEGORIAS] }, confianza: { type: 'string', enum: [...CONFIANZAS] } },
          required: ['categoria', 'confianza'],
        },
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        maxOutputTokens: 256,
        labels: { uso: 'clasificar' },
      },
    }, ESPERA_CLASIFICAR_MS);
    return { ...clasificacionDe(jsonDe(r)), uso: usoDe(r) };
  }
}

/** Valida la clasificación; lanza si no tiene la forma pedida (y entonces se trata como «no sé»). */
export function clasificacionDe(valor: unknown): Pick<Clasificacion, 'categoria' | 'confianza'> {
  const o = (valor ?? {}) as Record<string, unknown>;
  const categoria = CATEGORIAS.find(c => c === o['categoria']);
  const confianza = CONFIANZAS.find(c => c === o['confianza']);
  if (!categoria || !confianza) throw new Error('La clasificación no tiene la forma pedida.');
  return { categoria, confianza };
}

@Injectable()
export class LectorVertex extends LectorComprobantes {
  constructor(private readonly cliente: ClienteVertex, private readonly cfg: ConfiguracionIA) { super(); }

  get nombre(): string { return this.cfg.modelo; }

  async leer(archivo: { bytes: Uint8Array; mime: string }): Promise<{ datos: DatosComprobante; uso: UsoModelo }> {
    const r = await this.cliente.generar({
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
    }, ESPERA_LEER_MS);
    return { datos: datosComprobanteDe(jsonDe(r)), uso: usoDe(r) };
  }
}
