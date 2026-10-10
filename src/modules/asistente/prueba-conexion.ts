/**
 * «Probar conexión»: la prueba de punta a punta del proveedor de IA, con datos
 * SINTÉTICOS (ninguna paciente). La usan el botón del CRM
 * (`POST /asistente/probar`) y el comando del servidor
 * (`npm run asistente:probar`), para que conectar Google sea comprobar, no adivinar.
 *
 * Ejercita las tres cosas que pueden fallar distinto:
 * 1. el filtro (el modelo chico, respuesta estructurada);
 * 2. una vuelta con herramienta y su firma de razonamiento — lo único que una
 *    prueba sin red no puede garantizar es que Google acepte lo que le devolvemos;
 * 3. la lectura de un comprobante dibujado aquí mismo (visión + JSON).
 *
 * Se detiene en el primer paso que falla y lo explica en palabras.
 */
import { evaluarComprobante } from './comprobante';
import { ClasificadorMensajes, LectorComprobantes, ModeloConversacional, TurnoModelo } from './modelo.port';
import { EstadoProveedorIA } from './vertex/proveedor-vertex';

export interface PasoPrueba {
  readonly paso: 'CONFIGURACION' | 'FILTRO' | 'CONVERSACION' | 'COMPROBANTE';
  readonly ok: boolean;
  readonly detalle: string;
  readonly ms: number;
}

export interface ResultadoPrueba {
  readonly ok: boolean;
  readonly pasos: readonly PasoPrueba[];
}

/** Lo que falta en la configuración del servidor, en una frase; `null` si está completa. */
export function faltaEnConfiguracion(e: EstadoProveedorIA): string | null {
  if (!e.encendido) return 'Falta ASISTENTE_IA=on en el servidor.';
  if (!e.proyecto) return 'Falta GOOGLE_CLOUD_PROJECT en el servidor.';
  if (e.credenciales === 'ARCHIVO_INEXISTENTE') return 'La llave de la cuenta de servicio no está donde dice GOOGLE_APPLICATION_CREDENTIALS.';
  return null;
}

/**
 * Un error de Google, dicho para quien tiene que arreglarlo. Los mensajes del
 * SDK vienen en inglés y con JSON adentro; lo que importa es qué hacer.
 */
export function explicarErrorIA(error: unknown, modelo: string): string {
  const mensaje = error instanceof Error ? error.message : String(error);
  const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : null;
  if (/default credentials|could not load|invalid_grant|private key|ENOENT/i.test(mensaje)) {
    return 'No se encontraron credenciales válidas: revisa la llave JSON de la cuenta de servicio (GOOGLE_APPLICATION_CREDENTIALS).';
  }
  if (/billing/i.test(mensaje)) return 'El proyecto de Google Cloud no tiene la facturación activa.';
  if (/SERVICE_DISABLED|has not been used|is disabled/i.test(mensaje)) return 'La API de Vertex AI no está activada en el proyecto (aiplatform.googleapis.com).';
  if (status === 401 || status === 403 || /PERMISSION_DENIED/i.test(mensaje)) {
    return 'Google rechazó el permiso: la cuenta de servicio necesita el rol «Vertex AI User» en ese proyecto.';
  }
  if (status === 404 || /NOT_FOUND/i.test(mensaje)) {
    return `El modelo «${modelo}» no está disponible en esa ubicación, o el proyecto no existe. Prueba GOOGLE_CLOUD_LOCATION=global.`;
  }
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(mensaje)) return 'Google limitó las consultas (cuota). Espera unos minutos o pide más cuota para el proyecto.';
  if (status === 400) return `Google rechazó la consulta (400): ${mensaje.slice(0, 160)}`;
  if (/timeout|timed out|aborted|ETIMEDOUT|ECONNRESET|503|UNAVAILABLE/i.test(mensaje)) return 'Google no respondió a tiempo. Vuelve a probar en un momento.';
  return `Google respondió con un error: ${mensaje.slice(0, 160)}`;
}

/** Un comprobante sintético: el que se le pide leer al modelo. Monto Bs 280,50, operación 7788990. */
export const SVG_COMPROBANTE_DE_PRUEBA = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="900" viewBox="0 0 720 900" font-family="Poppins">',
  '<rect width="100%" height="100%" fill="#FFFFFF"/>',
  '<rect width="100%" height="140" fill="#006156"/>',
  '<text x="40" y="88" font-size="40" font-weight="600" fill="#FFFFFF">Banco de Prueba</text>',
  '<text x="40" y="220" font-size="30" fill="#1F2937">Transferencia exitosa</text>',
  '<text x="40" y="300" font-size="26" fill="#6B7280">Monto</text>',
  '<text x="40" y="350" font-size="44" font-weight="600" fill="#1F2937">Bs 280,50</text>',
  '<text x="40" y="430" font-size="26" fill="#6B7280">Destinatario</text>',
  '<text x="40" y="470" font-size="30" fill="#1F2937">CLINICA DE PRUEBA SRL</text>',
  '<text x="40" y="550" font-size="26" fill="#6B7280">Fecha y hora</text>',
  '<text x="40" y="590" font-size="30" fill="#1F2937">10/10/2026 14:32</text>',
  '<text x="40" y="670" font-size="26" fill="#6B7280">Nro. de operación</text>',
  '<text x="40" y="710" font-size="30" fill="#1F2937">7788990</text>',
  '<text x="40" y="790" font-size="26" fill="#6B7280">Origen</text>',
  '<text x="40" y="830" font-size="30" fill="#1F2937">ANA PRUEBA</text>',
  '</svg>',
].join('');

export interface ProveedorAProbar {
  readonly estado: EstadoProveedorIA;
  readonly modelo: ModeloConversacional;
  readonly clasificador: ClasificadorMensajes;
  readonly lector: LectorComprobantes;
  /** SVG → PNG (el mismo motor de la imagen del horario). */
  readonly dibujar: (svg: string) => Promise<Uint8Array>;
}

const HERRAMIENTA_DE_PRUEBA = {
  name: 'hora_de_la_clinica',
  description: 'Devuelve la hora actual de la clínica. Úsala siempre que pregunten la hora.',
  parametersJsonSchema: { type: 'object', properties: {}, required: [] },
};

export async function probarProveedor(p: ProveedorAProbar): Promise<ResultadoPrueba> {
  const pasos: PasoPrueba[] = [];
  const medir = async (paso: PasoPrueba['paso'], modelo: string, fn: () => Promise<string>): Promise<boolean> => {
    const inicio = Date.now();
    try {
      pasos.push({ paso, ok: true, detalle: await fn(), ms: Date.now() - inicio });
      return true;
    } catch (error: unknown) {
      pasos.push({ paso, ok: false, detalle: explicarErrorIA(error, modelo), ms: Date.now() - inicio });
      return false;
    }
  };

  const falta = faltaEnConfiguracion(p.estado);
  pasos.push({ paso: 'CONFIGURACION', ok: !falta, detalle: falta ?? `Proyecto configurado · ${p.estado.ubicacion} · ${p.estado.modelo}`, ms: 0 });
  if (falta) return { ok: false, pasos };

  const filtro = await medir('FILTRO', p.clasificador.nombre, async () => {
    const c = await p.clasificador.clasificar({ mensaje: '¿Cuánto cuesta la consulta de ginecología?', contexto: [], criterio: '' });
    return `${p.clasificador.nombre}: lo clasificó como ${c.categoria} (${c.confianza.toLowerCase()}).`;
  });
  if (!filtro) return { ok: false, pasos };

  const conversacion = await medir('CONVERSACION', p.modelo.nombre, async () => {
    const historial: TurnoModelo[] = [{ rol: 'paciente', texto: '¿Qué hora es en la clínica?' }];
    const sistema = 'Eres un asistente de prueba. Para saber la hora usa SIEMPRE la herramienta hora_de_la_clinica. Contesta en una frase.';
    const primera = await p.modelo.responder({ sistema, historial, herramientas: [HERRAMIENTA_DE_PRUEBA] });
    if (primera.tipo !== 'herramientas') {
      throw new Error(primera.tipo === 'bloqueada' ? `respuesta bloqueada (${primera.motivo})` : 'el modelo contestó sin usar la herramienta');
    }
    historial.push({ rol: 'modelo-pide', llamadas: primera.llamadas, crudo: primera.crudo });
    historial.push({ rol: 'resultados', resultados: primera.llamadas.map(l => ({ ...l, resultado: { ok: true, datos: '15:40' } })) });
    /* La vuelta que falla con 400 si la firma del razonamiento no volvió intacta. */
    const segunda = await p.modelo.responder({ sistema, historial, herramientas: [HERRAMIENTA_DE_PRUEBA] });
    if (segunda.tipo !== 'texto' || !segunda.texto.trim()) throw new Error('no cerró la respuesta después de la herramienta');
    return `${p.modelo.nombre}: usó la herramienta y contestó «${segunda.texto.trim().slice(0, 80)}».`;
  });
  if (!conversacion) return { ok: false, pasos };

  const comprobante = await medir('COMPROBANTE', p.lector.nombre, async () => {
    const { datos } = await p.lector.leer({ bytes: await p.dibujar(SVG_COMPROBANTE_DE_PRUEBA), mime: 'image/png' });
    const e = evaluarComprobante(datos, {
      monto: 280.5, titular: 'Clínica de Prueba SRL', pedidoEn: new Date('2026-10-10T18:00:00Z'), ahora: new Date('2026-10-10T19:00:00Z'), referenciaRepetida: false,
    });
    const monto = e.verificaciones.find(v => v.campo === 'MONTO');
    if (!datos.esComprobante || monto?.estado !== 'OK') throw new Error(`leyó mal el comprobante de prueba: ${monto?.texto ?? 'no lo reconoció como comprobante'}`);
    return `Leyó Bs ${datos.monto} y la operación ${datos.referencia ?? '—'} del comprobante de prueba.`;
  });
  return { ok: comprobante, pasos };
}
