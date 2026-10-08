import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { sellarTokenFlow } from '../../common/whatsapp/flows/token-flow';
import { MensajePreparado, contenidoMeta, validarMensaje } from '../../common/whatsapp/interacciones/mensaje-interactivo';
import { objeto, parsearRespuesta } from '../../common/whatsapp/interacciones/respuesta-interactiva';
import { ResultadoRespuesta } from './atencion-humana';
import { FLOWS_PUBLICADOS } from './flows-publicados';

/**
 * Opt-in de despliegue: la CAPACIDAD del servidor (clave, correlación, despacho,
 * retención). No se habilita por instalar la migración. Lo que ve la paciente
 * lo decide `interaccionesEnLinea`.
 */
export function interaccionesHabilitadas(): boolean {
  return process.env['WHATSAPP_INTERACCIONES'] === 'on';
}

/**
 * ¿Esta línea se comporta con interacciones (menú, tarjetas, botones, «Atención»)?
 * Solo las de `WHATSAPP_INTERACCIONES_LINEAS` (ids separados por coma); las demás
 * siguen exactamente como con la bandera apagada. Así se enciende de a una línea
 * real sin cambiar nada a las pacientes de las otras.
 *
 * Falla CERRADO: vacía o ausente no enciende ninguna. Encenderlas todas se escribe
 * a propósito (`todas`). Antes «vacía = todas»: con Flows ya publicados en las WABAs
 * reales de Ventas y Recepción, borrar la variable por error habría encendido las
 * dos para todas sus pacientes.
 */
export function interaccionesEnLinea(lineaId: string | null | undefined): boolean {
  if (!interaccionesHabilitadas()) return false;
  const valor = (process.env['WHATSAPP_INTERACCIONES_LINEAS'] ?? '').trim();
  if (valor === 'todas') return true;
  const piloto = valor.split(',').map(s => s.trim()).filter(Boolean);
  return !!lineaId && piloto.includes(lineaId);
}
const DIA = 86_400_000;
function clave(): Buffer {
  const key = Buffer.from(process.env['WHATSAPP_INTERACCIONES_KEY'] ?? '', 'base64');
  if (key.length !== 32) throw new ServiceUnavailableException('Falta configurar la protección de interacciones');
  return key;
}
/** AAD impide intercambiar snapshots entre mensajes. Nunca devolver este sobre al cliente. */
export function cifrarInteraccion(valor: unknown, identidad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', clave(), iv);
  cipher.setAAD(Buffer.from(identidad));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(valor), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), bytes.toString('base64')].join('.');
}
export function descifrarInteraccion(valor: string, identidad: string): unknown {
  const [version, iv, tag, body] = valor.split('.');
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('Sobre de interacción inválido');
  const cipher = createDecipheriv('aes-256-gcm', clave(), Buffer.from(iv, 'base64'));
  cipher.setAAD(Buffer.from(identidad));
  cipher.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(body, 'base64')), cipher.final()]).toString('utf8')) as unknown;
}

export interface FlowAutorizado {
  id: string;
  version: string;
  pantalla: string;
  /** Valores cerrados del borrador aprobado, nunca datos personales libres. */
  respuestas: Record<string, readonly string[]>;
  campos?: Record<string, { tipo: 'texto' | 'fecha' | 'booleano'; max?: number }>;
  /**
   * Para qué sirve este Flow. `SOLICITUD_CITA` lo convierte en una solicitud de
   * cita (no en una cita). `RESERVA_CITA` reserva DE VERDAD en la agenda, por su
   * endpoint (`agenda-flow.service.ts`); recepción la confirma en FileMaker.
   */
  proposito?: 'SOLICITUD_CITA' | 'RESERVA_CITA';
  /**
   * Con endpoint (data_api 3.0): abre pidiendo su primera pantalla al CRM
   * (`data_exchange`) y su `flow_token` es el token SELLADO con el teléfono del
   * chat, porque el endpoint no recibe otra cosa para saber quién es.
   */
  endpoint?: true;
  /** Cómo se llama cada campo en pantalla («Especialidad»). Sin etiqueta, el campo no se muestra. */
  etiquetas?: Record<string, string>;
  /** El texto de cada valor cerrado (`GINECOLOGIA` → «Ginecología»). */
  titulos?: Record<string, Record<string, string>>;
}

/**
 * Lo que el personal puede leer de un Flow validado: solo campos con etiqueta,
 * de valores cerrados o fechas. Un campo de texto libre nunca se proyecta: su
 * contenido queda cifrado en el original.
 */
function datosVisiblesDeFlow(flow: FlowAutorizado, datos: Record<string, unknown>): { etiqueta: string; valor: string }[] {
  const visibles: { etiqueta: string; valor: string }[] = [];
  for (const [clave, etiqueta] of Object.entries(flow.etiquetas ?? {})) {
    const valor = datos[clave];
    if (typeof valor !== 'string') continue;
    if (Object.hasOwn(flow.respuestas, clave)) visibles.push({ etiqueta, valor: flow.titulos?.[clave]?.[valor] ?? valor });
    else if (flow.campos?.[clave]?.tipo === 'fecha') visibles.push({ etiqueta, valor });
  }
  return visibles;
}
/** Un Flow publicado en Meta y la WABA donde vive (solo se envía por las líneas de esa WABA). */
export interface FlowPublicado extends FlowAutorizado {
  wabaId: string;
}

/**
 * Lo que el CRM puede enviar: los Flows publicados de los ambientes encendidos del
 * manifest (docs/whatsapp-interacciones/flows), generados a `flows-publicados.ts`.
 * Cada ambiente encendido es una WABA con publicación autorizada (prueba, Ventas,
 * Recepción). Que la paciente lo vea depende además de `interaccionesEnLinea`.
 */
export function catalogoFlows(): readonly FlowPublicado[] { return FLOWS_PUBLICADOS; }

/**
 * El Flow de cita publicado en la WABA de esta línea, si hay: el que RESERVA
 * en la agenda antes que el que solo pide una cita.
 */
export function flowDeCita(wabaId: string | null | undefined): FlowPublicado | null {
  if (!wabaId) return null;
  const deLaWaba = catalogoFlows().filter(f => f.wabaId === wabaId);
  return deLaWaba.find(f => f.proposito === 'RESERVA_CITA') ?? deLaWaba.find(f => f.proposito === 'SOLICITUD_CITA') ?? null;
}

export interface OfertaInteraccion {
  mensaje: MensajePreparado;
  telefono: string;
  flow?: FlowAutorizado;
  respuestasPlantilla?: { id: string; titulo: string }[];
  /**
   * La mandó el CRM solo: el menú de atención (o su lista de promociones) o la
   * tarjeta de una promoción. Dos efectos:
   * - cada opción se puede elegir, y más de una vez. Sin esto la oferta se consume
   *   con el primer toque y el segundo es `DUPLICADA` —lo correcto para lo que manda
   *   una agente—; en un menú, «Horarios» y después «Hablar con una persona» son dos
   *   pedidos. Un webhook repetido sigue sin duplicar nada (índice único del wamid);
   * - solo un toque en una oferta así dispara sus respuestas: el mismo
   *   `TALK_TO_HUMAN` en una plantilla de campaña pide una persona, pero no recibe la
   *   confirmación del menú.
   */
  origen?: 'MENU_ATENCION' | 'PROMOCION';
  /** Con `origen: 'PROMOCION'`: de qué promoción es la tarjeta. */
  promocionId?: string;
  /** Metadatos de transporte; no forman parte de la intención ni llegan a UI. */
  metaIdsAnteriores?: string[];
}
export function prepararOferta(entrada: unknown, telefono: string): OfertaInteraccion {
  if (!interaccionesHabilitadas()) throw new BadRequestException('Interacciones desactivadas');
  try {
    // El validador comprueba cada campo usado por el constructor, sin ejecutar datos del cliente.
    const candidato = objeto(entrada);
    /* La correlación la pone SIEMPRE el servidor: aleatoria, o el token sellado si
       el Flow tiene endpoint. Nunca la que venga en la petición. */
    const flowPedido = candidato?.['tipo'] === 'flow' ? catalogoFlows().find(f => f.id === candidato['flowId']) : undefined;
    const correlacion = flowPedido?.endpoint ? sellarTokenFlow(telefono.replace(/^\+/, '')) : randomBytes(32).toString('hex');
    const m = (candidato?.['tipo'] === 'flow' ? { ...candidato, correlacion } : entrada) as MensajePreparado;
    validarMensaje(m);
    if (m.tipo === 'texto') throw new Error('Usar el envío de texto existente');
    let flow: FlowAutorizado | undefined;
    if (m.tipo === 'flow') {
      flow = flowPedido;
      const inicioValido = flow?.endpoint
        ? m.inicio.accion === 'data_exchange'
        : m.inicio.accion === 'navigate' && m.inicio.pantalla === flow?.pantalla;
      if (!flow || m.modo !== 'published' || !inicioValido) throw new Error('Flow no autorizado en el catálogo local');
    }
    // Reconstrucción explícita: no conservar claves arbitrarias de la petición.
    const base = { cuerpo: m.cuerpo, ...(m.cabecera ? { cabecera: m.cabecera } : {}), ...(m.pie ? { pie: m.pie } : {}) };
    const opcion = (o: { id: string; titulo: string; descripcion?: string }) => ({ id: o.id, titulo: o.titulo, ...(o.descripcion ? { descripcion: o.descripcion } : {}) });
    const mensaje: MensajePreparado = m.tipo === 'botones' ? { ...base, tipo: 'botones', opciones: m.opciones.map(opcion), ...(m.imagenCabecera ? { imagenCabecera: m.imagenCabecera } : {}) }
      : m.tipo === 'lista' ? { ...base, tipo: 'lista', boton: m.boton, secciones: m.secciones.map(s => ({ titulo: s.titulo, opciones: s.opciones.map(opcion) })) }
      : { ...base, tipo: 'flow', flowId: m.flowId, correlacion: m.correlacion, cta: m.cta, modo: 'published', inicio: flow!.endpoint ? { accion: 'data_exchange' } : { accion: 'navigate', pantalla: flow!.pantalla } };
    return { mensaje, telefono, ...(flow ? { flow } : {}) };
  } catch {
    throw new BadRequestException('Interacción inválida o Flow no autorizado');
  }
}
export function datosOferta(oferta: OfertaInteraccion, identidad: string) {
  const m = oferta.mensaje;
  const opciones = oferta.respuestasPlantilla ?? (m.tipo === 'botones' ? m.opciones : m.tipo === 'lista' ? m.secciones.flatMap(s => s.opciones) : []);
  return {
    privado: cifrarInteraccion(oferta, identidad),
    vista: { tipo: oferta.respuestasPlantilla ? 'botones' : m.tipo, cuerpo: m.cuerpo, opciones: opciones.map(o => ({ ...o })) } satisfies Prisma.InputJsonValue,
    estado: 'OFRECIDA', venceEn: new Date(Date.now() + DIA), purgarEn: new Date(Date.now() + 7 * DIA),
  };
}

export async function verificarIntencion(prisma: PrismaService, mensajeId: string, identidad: string, oferta: OfertaInteraccion): Promise<void> {
  const fila = await prisma.interaccionMensaje.findUnique({ where: { mensajeId } });
  if (!fila?.privado) throw new ConflictException('La clave corresponde a otra intención o su detalle ha caducado');
  const previa = descifrarInteraccion(fila.privado, identidad) as OfertaInteraccion;
  const sinToken = (o: OfertaInteraccion) => JSON.stringify({ telefono: o.telefono, flow: o.flow, respuestasPlantilla: o.respuestasPlantilla, mensaje: o.mensaje.tipo === 'flow' ? { ...o.mensaje, correlacion: '' } : o.mensaje });
  if (sinToken(previa) !== sinToken(oferta)) throw new ConflictException('No se puede cambiar la intención de un envío existente');
}

/** Los statuses de un intento rechazado no resuelven la incertidumbre del siguiente. */
export async function estadoDeIntentoAnterior(prisma: PrismaService, referencia: string | undefined, metaId: string): Promise<boolean> {
  if (!interaccionesHabilitadas() || !referencia) return false;
  const mensaje = await prisma.mensaje.findUnique({ where: { id: referencia }, include: { interaccion: true } });
  if (!mensaje?.interaccion || !mensaje.clientMessageId) return false;
  if (!mensaje.interaccion.privado) return mensaje.whatsappMsgId !== metaId;
  const oferta = descifrarInteraccion(mensaje.interaccion.privado, mensaje.clientMessageId) as OfertaInteraccion;
  return oferta.metaIdsAnteriores?.includes(metaId) ?? false;
}

/** Dentro de la MISMA transacción de la ingesta. CAS serializa selecciones simultáneas. */
export async function guardarRespuesta(
  tx: Prisma.TransactionClient, mensajeId: string, conversacionId: string, telefono: string, raw: unknown,
): Promise<ResultadoRespuesta> {
  const r = parsearRespuesta(raw);
  const original = JSON.stringify(raw);
  // El límite global HTTP acota el mensaje. Se conserva incluso si el parser no lo entiende.
  if (original.length > 1_048_576) throw new BadRequestException('Mensaje excede el límite de conservación');
  let estado = r.estado === 'invalida' ? 'INVALIDA' : r.estado === 'desconocida' ? 'DESCONOCIDA' : 'NO_CORRELACIONADA';
  let contextoId: string | undefined;
  let seleccionId: string | undefined;
  let versionFlow: string | undefined;
  let propositoFlow: string | undefined;
  let datosFlow: { etiqueta: string; valor: string }[] | undefined;
  let origenOferta: OfertaInteraccion['origen'];
  let promocionOferta: string | undefined;
  let cuerpo = r.seleccion?.tipo === 'nfm_reply' ? 'Formulario recibido; requiere revisión humana. No confirma una cita.' : 'Respuesta interactiva recibida; requiere revisión humana.';
  if (r.estado === 'valida' && r.contextoId && r.seleccion) {
    const fuente = await tx.mensaje.findFirst({
      where: { whatsappMsgId: r.contextoId, conversacionId, direccion: 'SALIENTE' },
      include: { interaccion: true },
    });
    const oferta = fuente?.interaccion;
    if (fuente && oferta?.privado && fuente.clientMessageId) {
      const guardada = descifrarInteraccion(oferta.privado, fuente.clientMessageId) as OfertaInteraccion;
      const m = guardada.mensaje;
      const timestamp = Number(r.timestamp) * 1000;
      const vigente = oferta.venceEn.getTime() >= Date.now() && Number.isFinite(timestamp) && timestamp >= fuente.createdAt.getTime() - 1000 && timestamp <= Date.now() + 60_000;
      const seleccion = r.seleccion;
      const opciones = guardada.respuestasPlantilla ?? (m.tipo === 'botones' ? m.opciones : m.tipo === 'lista' ? m.secciones.flatMap(s => s.opciones) : []);
      const opcion = seleccion.tipo !== 'nfm_reply' ? opciones.find(o => o.id === seleccion.id) : undefined;
      const tipoCorrecto = (guardada.respuestasPlantilla && seleccion.tipo === 'template_reply') || (m.tipo === 'botones' && seleccion.tipo === 'button_reply') || (m.tipo === 'lista' && seleccion.tipo === 'list_reply');
      const flowValido = seleccion.tipo === 'nfm_reply' && m.tipo === 'flow' && guardada.flow?.id === m.flowId &&
        guardada.flow.version.length > 0 && seleccion.datos['flow_version'] === guardada.flow.version && seleccion.correlacion === m.correlacion &&
        Object.entries(guardada.flow.respuestas).every(([k, valores]) => typeof seleccion.datos[k] === 'string' && valores.includes(seleccion.datos[k] as string)) &&
        Object.entries(guardada.flow.campos ?? {}).every(([k, campo]) => validarCampoFlow(seleccion.datos[k], campo)) &&
        Object.keys(seleccion.datos).every(k => k === 'flow_token' || k === 'flow_version' || Object.hasOwn(guardada.flow!.respuestas, k) || Object.hasOwn(guardada.flow!.campos ?? {}, k));
      if (guardada.telefono === telefono && ((tipoCorrecto && opcion) || flowValido)) {
        contextoId = fuente.id; // ID interno autorizado, nunca identificador de otro chat.
        if (opcion) {
          seleccionId = opcion.id;
          cuerpo = opcion.titulo;
          origenOferta = guardada.origen;
          promocionOferta = guardada.promocionId;
        }
        if (flowValido && seleccion.tipo === 'nfm_reply') {
          versionFlow = guardada.flow!.version;
          propositoFlow = guardada.flow!.proposito;
          datosFlow = datosVisiblesDeFlow(guardada.flow!, seleccion.datos);
          if (propositoFlow === 'SOLICITUD_CITA') cuerpo = 'Solicitud de cita recibida. Pendiente: no hay ninguna cita reservada.';
          /* La reserva la hizo NUESTRO endpoint y estos datos los devolvió él al cerrar el
             Flow (`extension_message_response`): la paciente no los escribe. */
          if (propositoFlow === 'RESERVA_CITA') {
            cuerpo = `Reservó por el chat: N.º ${String(seleccion.datos['reserva'])} · ${String(seleccion.datos['resumen'])}. Pendiente de confirmar en FileMaker.`;
          }
        }
        if (!vigente) estado = 'CADUCADA';
        else if (guardada.origen) estado = 'CORRELACIONADA';
        else {
          const reclamo = await tx.interaccionMensaje.updateMany({ where: { mensajeId: fuente.id, consumidaPor: null }, data: { consumidaPor: mensajeId } });
          estado = reclamo.count ? 'CORRELACIONADA' : 'DUPLICADA';
        }
      }
    }
  }
  await tx.interaccionMensaje.create({ data: {
    mensajeId, estado, privado: cifrarInteraccion(raw, mensajeId),
    vista: { tipo: r.seleccion?.tipo === 'nfm_reply' ? 'respuesta_flow' : r.seleccion ? 'seleccion' : 'error', cuerpo, estado, ...(contextoId ? { contextoId } : {}), ...(seleccionId ? { seleccionId } : {}), ...(versionFlow ? { versionFlow } : {}), ...(propositoFlow ? { proposito: propositoFlow } : {}), ...(datosFlow?.length ? { datos: datosFlow } : {}) },
    venceEn: new Date(), purgarEn: new Date(Date.now() + 7 * DIA),
  } });
  await tx.mensaje.update({ where: { id: mensajeId }, data: { contenido: cuerpo } });
  return {
    estado,
    ...(seleccionId ? { seleccionId } : {}),
    ...(propositoFlow ? { propositoFlow } : {}),
    ...(origenOferta === 'MENU_ATENCION' ? { deMenu: true } : {}),
    ...(origenOferta === 'PROMOCION' && promocionOferta ? { promocionId: promocionOferta } : {}),
  };
}

function validarCampoFlow(valor: unknown, campo: { tipo: 'texto' | 'fecha' | 'booleano'; max?: number }): boolean {
  if (campo.tipo === 'booleano') return typeof valor === 'boolean';
  if (typeof valor !== 'string' || !valor.trim() || valor.length > (campo.max ?? 80)) return false;
  if (campo.tipo === 'texto') return true; // Solo campos explícitamente aprobados; nunca se proyectan.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const fecha = new Date(valor);
  return Number.isFinite(fecha.getTime()) && fecha.toISOString().startsWith(valor);
}

/** Solo tras verificar acceso al chat. No incluir relación privada en consultas generales. */
export async function proyectarInteracciones<T extends { id: string }>(prisma: PrismaService, mensajes: T[]) {
  if (!interaccionesHabilitadas() || mensajes.length === 0) return mensajes;
  const filas = await prisma.interaccionMensaje.findMany({ where: { mensajeId: { in: mensajes.map(m => m.id) } }, select: { mensajeId: true, vista: true } });
  const porId = new Map(filas.map(f => [f.mensajeId, f.vista]));
  return mensajes.map(m => ({ ...m, ...(porId.has(m.id) ? { interaccion: porId.get(m.id) } : {}) }));
}
export async function purgarInteracciones(prisma: PrismaService): Promise<void> {
  // Privado se borra a los 7 días; metadatos/proyección a los 30. Mensaje sigue el historial existente.
  await prisma.interaccionMensaje.updateMany({ where: { purgarEn: { lte: new Date() }, privado: { not: null } }, data: { privado: null } });
  await prisma.interaccionMensaje.deleteMany({ where: { purgarEn: { lte: new Date(Date.now() - 23 * DIA) }, mensaje: { direccion: 'ENTRANTE' } } });
  // Ofertas conservan una lápida para impedir que un reintento se degrade a texto.
  await prisma.interaccionMensaje.updateMany({ where: { purgarEn: { lte: new Date(Date.now() - 23 * DIA) }, estado: { not: 'RETENIDA' }, mensaje: { direccion: 'SALIENTE' } }, data: { estado: 'RETENIDA', consumidaPor: null, vista: { tipo: 'error', cuerpo: 'Detalle de interacción caducado.' } } });
}

export function contenidoOferta(oferta: OfertaInteraccion) {
  const contenido = contenidoMeta(oferta.mensaje);
  const interactive = objeto(contenido['interactive']);
  if (!interactive) throw new Error('Oferta sin contenido interactivo');
  return { type: 'interactive' as const, interactive };
}
