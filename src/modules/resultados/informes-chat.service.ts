import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { acortar } from '../../common/texto/acortar';
import { descifrarInteraccion, interaccionesEnLinea, OfertaInteraccion, prepararOferta } from '../conversaciones/interacciones-integracion';
import { IdentidadInformeChat, InformeParaChat, PortalResultadosClient } from './portal-resultados.client';

export const PREFIJO_INFORME_CHAT = 'informe-chat/';
/** Falta vincular la ficha. Un CI escrito ayuda a recepción, nunca autoriza un PDF. */
export class IdentificacionInformePendiente extends NotFoundException {
  constructor() { super('Recepción debe verificar la identidad para consultar informes.'); }
}
export const PEDIR_CARNET_INFORME = 'Para que recepción pueda verificar tu solicitud, escribe el número de carnet del paciente, solo el número; no envíes una foto del documento. Recepción revisará la identidad y el teléfono antes de entregar el informe.';
export interface ContextoInformes {
  clienteId: string; lineaId: string; identidad: IdentidadInformeChat;
  informes: InformeParaChat[]; pagina: number;
}
export function informesEnLinea(lineaId: string | null | undefined): boolean {
  const permitidas = (process.env.RESULTADOS_AUTOSERVICIO_LINEAS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return !!lineaId && interaccionesEnLinea(lineaId) && permitidas.includes(lineaId);
}
/** Frases completas; no intercepta síntomas ni interpretación de resultados. */
export function pideSusInformes(texto: string): boolean {
  const t = texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[¿?¡!.,]/g, '').trim();
  return /^(?:(?:hola |por favor )?(?:quiero|quisiera|necesito|ver|consultar|enviame|mandame|puedes enviarme) )?(?:mis|mi) (?:informes?|resultados?)(?: por favor)?$/.test(t);
}

/** Autorización determinista: identidad del chat, nunca argumentos del modelo. */
@Injectable()
export class InformesChatService {
  constructor(private readonly prisma: PrismaService, private readonly portal: PortalResultadosClient) {}

  private async ficha(conversacionId: string, telefono: string) {
    const c = await this.prisma.conversacion.findUnique({ where: { id: conversacionId }, select: {
      clienteId: true, lineaId: true, cerradaEn: true, automatizacionPausadaEn: true, atencionTomadaEn: true,
      cliente: { select: { telefono: true, pac: true, ci: true } }, linea: { select: { activa: true } },
    } });
    const ultimo = await this.prisma.mensaje.findFirst({ where: { conversacionId, direccion: 'ENTRANTE' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    if (!c || !c.linea.activa || !informesEnLinea(c.lineaId) || c.cerradaEn || c.automatizacionPausadaEn || c.atencionTomadaEn
      || c.cliente.telefono !== telefono || !ultimo || Date.now() - ultimo.createdAt.getTime() >= 86_400_000)
      throw new NotFoundException('Recepción debe verificar la solicitud de informes.');
    // Solo tras validar el chat: nunca pedir identificación para un teléfono ajeno
    // o una sesión cerrada, pausada o fuera de la ventana de atención.
    if (!c.cliente.pac) throw new IdentificacionInformePendiente();
    return { clienteId: c.clienteId, identidad: { pac: c.cliente.pac, ...(c.cliente.ci ? { ci: c.cliente.ci } : {}) }, lineaId: c.lineaId };
  }

  async validarOferta(conversacionId: string, telefono: string, oferta: OfertaInteraccion): Promise<void> {
    const actual = await this.ficha(conversacionId, telefono);
    const previo = oferta.informes;
    if (!previo || oferta.origen !== 'INFORMES' || oferta.telefono !== telefono || actual.clienteId !== previo.clienteId || actual.lineaId !== previo.lineaId
      || actual.identidad.pac !== previo.identidad.pac || actual.identidad.ci !== previo.identidad.ci)
      throw new NotFoundException('La ficha cambió: vuelve a consultar tus informes.');
  }

  async oferta(conversacionId: string, telefono: string, pagina = 1): Promise<OfertaInteraccion | null> {
    const ficha = await this.ficha(conversacionId, telefono);
    const datos = await this.portal.informesDelPaciente(ficha.identidad, pagina);
    if (!datos.datos.length) return null;
    const opciones = datos.datos.map(i => ({ id: `INFORME_${i.id}`, titulo: acortar(i.estudio, 24), descripcion: `Estudio del ${i.fechaEstudio.slice(0, 10)} · Recibir PDF` }));
    if (pagina > 1) opciones.push({ id: `INFORMES_PAGINA_${pagina - 1}`, titulo: 'Anteriores', descripcion: 'Volver a la página anterior' });
    if (pagina * datos.limite < datos.total) opciones.push({ id: `INFORMES_PAGINA_${pagina + 1}`, titulo: 'Más informes', descripcion: 'Ver la siguiente página' });
    opciones.push({ id: 'TALK_TO_HUMAN', titulo: 'Hablar con recepción', descripcion: 'Necesito ayuda con mis informes' });
    return { ...prepararOferta({ tipo: 'lista', cuerpo: 'Estos son tus informes disponibles. Elige uno para recibir su PDF por este WhatsApp. El archivo quedará en el chat. Si el teléfono es compartido, pide ayuda a recepción.', boton: 'Ver mis informes', secciones: [{ titulo: 'Informes disponibles', opciones }] }, telefono, ficha.lineaId),
      origen: 'INFORMES', informes: { clienteId: ficha.clienteId, lineaId: ficha.lineaId, identidad: ficha.identidad, informes: datos.datos, pagina } };
  }

  async seleccion(conversacionId: string, telefono: string, respuestaId: string, comprobarPublicado = false) {
    const respuesta = await this.prisma.interaccionMensaje.findFirst({ where: { mensajeId: respuestaId, estado: 'CORRELACIONADA', mensaje: { conversacionId, direccion: 'ENTRANTE' } } });
    const vista = respuesta?.vista as { contextoId?: string; seleccionId?: string } | undefined;
    if (!vista?.contextoId || !vista.seleccionId) throw new NotFoundException('Selección no autorizada.');
    const fuente = await this.prisma.mensaje.findFirst({ where: { id: vista.contextoId, conversacionId, direccion: 'SALIENTE' }, include: { interaccion: true } });
    if (!fuente?.clientMessageId || !fuente.interaccion?.privado || fuente.interaccion.venceEn.getTime() <= Date.now()) throw new NotFoundException('Selección vencida.');
    const oferta = descifrarInteraccion(fuente.interaccion.privado, fuente.clientMessageId) as OfertaInteraccion;
    await this.validarOferta(conversacionId, telefono, oferta);
    const id = vista.seleccionId;
    const opciones = oferta.mensaje.tipo === 'lista' ? oferta.mensaje.secciones.flatMap(s => s.opciones) : [];
    if (!opciones.some(o => o.id === id)) throw new NotFoundException('Opción no ofrecida.');
    const informe = oferta.informes!.informes.find(i => `INFORME_${i.id}` === id);
    if (comprobarPublicado && informe) {
      const actuales = await this.portal.informesDelPaciente(oferta.informes!.identidad, oferta.informes!.pagina);
      if (!actuales.datos.some(i => i.id === informe.id && i.archivoId === informe.archivoId))
        throw new NotFoundException('El informe cambió o dejó de estar disponible.');
      await this.validarOferta(conversacionId, telefono, oferta);
    }
    const pagina = /^INFORMES_PAGINA_(\d+)$/.exec(id);
    return { informe, pagina: pagina ? Number(pagina[1]) : null, identidad: oferta.informes!.identidad };
  }

  async pdf(conversacionId: string, telefono: string, key: string): Promise<Buffer> {
    if (!key.startsWith(PREFIJO_INFORME_CHAT)) throw new NotFoundException();
    const seleccion = await this.seleccion(conversacionId, telefono, key.slice(PREFIJO_INFORME_CHAT.length));
    if (!seleccion.informe) throw new NotFoundException('No seleccionó un informe.');
    return this.portal.pdfDelPaciente(seleccion.identidad, seleccion.informe);
  }
}
