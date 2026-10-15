import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ClasificadorMensajes, DatosComprobante, LectorComprobantes, ModeloConversacional, RespuestaModelo, TranscriptorAudio } from './modelo.port';
import { explicarErrorIA, probarProveedor, ProveedorAProbar, RUTA_AUDIO_DE_PRUEBA } from './prueba-conexion';

const USO = { tokensEntrada: 1, tokensSalida: 1 };
const LISTO = { encendido: true, proyecto: true, claveApi: false, credenciales: 'ARCHIVO' as const, ubicacion: 'global', modelo: 'gemini-3.5-flash', modeloClasificador: 'gemini-3.5-flash-lite', modeloRespaldo: 'gemini-3.7-flash', modeloTranscripcion: 'gemini-3.5-flash', listo: true };
const COMPROBANTE: DatosComprobante = { esComprobante: true, monto: 280.5, moneda: 'Bs', fechaHora: '2026-10-10T14:32', referencia: '7788990', banco: 'Banco de Prueba', destinatario: 'CLINICA DE PRUEBA SRL', ordenante: 'ANA PRUEBA' };

function proveedor(guion: (RespuestaModelo | Error)[], p: Partial<ProveedorAProbar> = {}): ProveedorAProbar & { vistas: unknown[] } {
  const vistas: unknown[] = [];
  const modelo = { nombre: 'gemini-3.5-flash', responder: jest.fn(async (e: unknown) => { vistas.push(structuredClone(e)); const r = guion.shift()!; if (r instanceof Error) throw r; return r; }) } as unknown as ModeloConversacional;
  return {
    estado: LISTO,
    modelo,
    clasificador: { nombre: 'lite', clasificar: jest.fn(async () => ({ categoria: 'VENTAS', confianza: 'ALTA', uso: USO })) } as unknown as ClasificadorMensajes,
    lector: { nombre: 'gemini-3.5-flash', leer: jest.fn(async () => ({ datos: COMPROBANTE, uso: USO })) } as unknown as LectorComprobantes,
    dibujar: async () => new Uint8Array([1]),
    transcriptor: { nombre: 'gemini-3.5-flash', transcribir: jest.fn(async () => ({ texto: 'Hola, buenas tardes. Quería saber cuánto cuesta el Control Prenatal.', uso: USO })) } as unknown as TranscriptorAudio,
    audioDePrueba: async () => new Uint8Array([0x4f, 0x67, 0x67, 0x53]),
    vistas,
    ...p,
  };
}
const pideHora: RespuestaModelo = { tipo: 'herramientas', llamadas: [{ id: 'c1', nombre: 'hora_de_la_clinica', argumentos: {} }], crudo: { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'hora_de_la_clinica', args: {} }, thoughtSignature: 'FIRMA' }] }, uso: USO };

describe('probar la conexión con Google', () => {
  it('sin configuración no llama a nada y dice qué falta', async () => {
    const p = proveedor([], { estado: { ...LISTO, encendido: false, listo: false } });
    const r = await probarProveedor(p);
    expect(r).toMatchObject({ ok: false, pasos: [{ paso: 'CONFIGURACION', ok: false, detalle: expect.stringContaining('ASISTENTE_IA') }] });
    expect(p.modelo.responder).not.toHaveBeenCalled();
  });

  it('pasa los cinco pasos, y la segunda vuelta lleva la firma del razonamiento intacta', async () => {
    const p = proveedor([pideHora, { tipo: 'texto', texto: 'Son las 15:40.', uso: USO }]);
    const r = await probarProveedor(p);
    expect(r.ok).toBe(true);
    expect(r.pasos.map(x => x.paso)).toEqual(['CONFIGURACION', 'FILTRO', 'CONVERSACION', 'COMPROBANTE', 'AUDIO']);
    expect(p.transcriptor.transcribir).toHaveBeenCalledWith({ bytes: new Uint8Array([0x4f, 0x67, 0x67, 0x53]), mime: 'audio/ogg; codecs=opus' });
    expect(JSON.stringify(p.vistas[1])).toContain('FIRMA');
  });

  it('si el modelo no usa la herramienta, falla en CONVERSACION y no sigue', async () => {
    const p = proveedor([{ tipo: 'texto', texto: 'No sé.', uso: USO }]);
    const r = await probarProveedor(p);
    expect(r.ok).toBe(false);
    expect(r.pasos.at(-1)).toMatchObject({ paso: 'CONVERSACION', ok: false });
    expect(p.lector.leer).not.toHaveBeenCalled();
  });

  it('un comprobante mal leído es un fallo, no un acierto', async () => {
    const p = proveedor([pideHora, { tipo: 'texto', texto: 'ok', uso: USO }], {
      lector: { nombre: 'x', leer: jest.fn(async () => ({ datos: { ...COMPROBANTE, monto: 28.05 }, uso: USO })) } as unknown as LectorComprobantes,
    });
    expect((await probarProveedor(p)).pasos.at(-1)).toMatchObject({ paso: 'COMPROBANTE', ok: false });
  });

  it('una nota de voz que no se entiende, o se entiende otra cosa, es un fallo', async () => {
    for (const texto of [null, 'Hola, quería una cita']) {
      const p = proveedor([pideHora, { tipo: 'texto', texto: 'ok', uso: USO }], {
        transcriptor: { nombre: 'x', transcribir: jest.fn(async () => ({ texto, uso: USO })) } as unknown as TranscriptorAudio,
      });
      const r = await probarProveedor(p);
      expect(r.ok).toBe(false);
      expect(r.pasos.at(-1)).toMatchObject({ paso: 'AUDIO', ok: false });
    }
  });

  it('la nota de voz de prueba existe y es un OGG (la lee el servidor desde assets/)', async () => {
    const bytes = await readFile(join(process.cwd(), ...RUTA_AUDIO_DE_PRUEBA));
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('OggS');
    expect(bytes.byteLength).toBeLessThan(100_000);
  });
});

describe('explicarErrorIA', () => {
  const error = (message: string, status?: number) => Object.assign(new Error(message), status ? { status } : {});
  it.each([
    [error('Could not load the default credentials.'), 'credenciales'],
    [error('Vertex AI API has not been used in project 123 before or it is disabled', 403), 'no está activada'],
    [error('{"error":{"status":"PERMISSION_DENIED"}}', 403), 'Vertex AI User'],
    [error('Publisher Model was not found', 404), 'GOOGLE_CLOUD_LOCATION=global'],
    [error('RESOURCE_EXHAUSTED', 429), 'cuota'],
    [error('This API method requires billing to be enabled', 403), 'facturación'],
    [error('The operation was aborted due to timeout'), 'a tiempo'],
  ])('%s → dice qué hacer', (e, esperado) => {
    expect(explicarErrorIA(e, 'gemini-3.5-flash')).toContain(esperado);
  });
});
