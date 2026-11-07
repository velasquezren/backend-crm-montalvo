import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { acortar } from '../../common/texto/acortar';
import { descifrarInteraccion, interaccionesEnLinea, OfertaInteraccion, prepararOferta } from '../conversaciones/interacciones-integracion';
import { RESPUESTA_PDF_AVISO } from './aviso-informe-pdf';
import { IdentidadInformeChat, InformeParaChat, PortalResultadosClient } from './portal-resultados.client';

export const PREFIJO_INFORME_CHAT = 'informe-chat/';
/** Un paciente con más informes vigentes que esto lo atiende una persona. */
const PAGINAS_MAXIMAS_AVISO = 10;
/** Falta vincular la ficha. Un CI escrito ayuda a recepción, nunca autoriza un PDF. */
export class IdentificacionInformePendiente extends NotFoundException {
  constructor() { super('Recepción debe verificar la identidad para consultar informes.'); }
}
export const PEDIR_CARNET_INFORME = 'Para que recepción pueda verificar su solicitud, escriba el número de carnet del paciente, solo el número; no envíe una foto del documento. Recepción revisará la identidad y el teléfono antes de entregar el informe.';
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

  /**
   * `aunqueAtiendan`: solo el «Recibir PDF» del aviso. Lo pide el paciente sobre
   * el aviso que la clínica le mandó de ESE informe, así que una persona en el
   * chat o la automatización pausada no lo frenan; todo lo demás sí.
   */
  private async ficha(conversacionId: string, telefono: string, { aunqueAtiendan = false } = {}) {
    const chat = await this.chat(conversacionId, telefono, { aunqueAtiendan });
    if (!chat.identidad) throw new IdentificacionInformePendiente();
    return { ...chat, identidad: chat.identidad };
  }

  /** El chat validado; `identidad` nula si su ficha no tiene PAC. */
  private async chat(conversacionId: string, telefono: string, { aunqueAtiendan = false } = {}) {
    const c = await this.prisma.conversacion.findUnique({ where: { id: conversacionId }, select: {
      clienteId: true, lineaId: true, cerradaEn: true, automatizacionPausadaEn: true, atencionTomadaEn: true,
      cliente: { select: { telefono: true, pac: true, ci: true } }, linea: { select: { activa: true } },
    } });
    const ultimo = await this.prisma.mensaje.findFirst({ where: { conversacionId, direccion: 'ENTRANTE' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    if (!c || !c.linea.activa || !informesEnLinea(c.lineaId) || c.cerradaEn || (!aunqueAtiendan && (c.automatizacionPausadaEn || c.atencionTomadaEn))
      || c.cliente.telefono !== telefono || !ultimo || Date.now() - ultimo.createdAt.getTime() >= 86_400_000)
      throw new NotFoundException('Recepción debe verificar la solicitud de informes.');
    // Solo tras validar el chat: nunca pedir identificación para un teléfono ajeno
    // o una sesión cerrada, pausada o fuera de la ventana de atención.
    const identidad: IdentidadInformeChat | null = c.cliente.pac ? { pac: c.cliente.pac, ...(c.cliente.ci ? { ci: c.cliente.ci } : {}) } : null;
    return { clienteId: c.clienteId, identidad, lineaId: c.lineaId };
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
    return { ...prepararOferta({ tipo: 'lista', cuerpo: 'Estos son sus informes disponibles. Elija uno para recibir su PDF por este WhatsApp. El archivo quedará en el chat. Si el teléfono es compartido, pida ayuda a recepción.', boton: 'Ver mis informes', secciones: [{ titulo: 'Informes disponibles', opciones }] }, telefono, ficha.lineaId),
      origen: 'INFORMES', informes: { clienteId: ficha.clienteId, lineaId: ficha.lineaId, identidad: ficha.identidad, informes: datos.datos, pagina } };
  }

  async seleccion(conversacionId: string, telefono: string, respuestaId: string, comprobarPublicado = false) {
    const respuesta = await this.prisma.interaccionMensaje.findFirst({ where: { mensajeId: respuestaId, estado: 'CORRELACIONADA', mensaje: { conversacionId, direccion: 'ENTRANTE' } } });
    const vista = respuesta?.vista as { contextoId?: string; seleccionId?: string } | undefined;
    if (!vista?.contextoId || !vista.seleccionId) throw new NotFoundException('Selección no autorizada.');
    if (vista.seleccionId === RESPUESTA_PDF_AVISO) return this.informeDelAviso(conversacionId, telefono, vista.contextoId);
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

  /**
   * El informe del aviso al que respondió «Recibir PDF». El aviso tiene que ser
   * de este chat y de esta ficha, y el informe tiene que seguir en la lista que
   * Resultados le da a su PAC: publicado, con acceso vigente y no revocado.
   * Vencido el enlace, ya no está ahí y lo resuelve una persona.
   *
   * El aviso que FileMaker mandó a propósito al WhatsApp de un familiar
   * (`DestinoAvisoResultado` de ESTA ficha, 06/11/2026) se busca con el PAC del
   * paciente del informe: ese chat no tiene por qué tener PAC ni ser suyo. Sin
   * esa elección expresa, solo vale el PAC de la ficha del chat: si cambió
   * desde el aviso, el PDF no sale.
   */
  private async informeDelAviso(conversacionId: string, telefono: string, avisoMensajeId: string) {
    const aviso = await this.prisma.avisoResultado.findFirst({
      where: { mensajeId: avisoMensajeId, mensaje: { conversacionId, direccion: 'SALIENTE' } },
      select: { informeId: true, clienteId: true },
    });
    if (!aviso) throw new NotFoundException('Aviso no encontrado.');
    const chat = await this.chat(conversacionId, telefono, { aunqueAtiendan: true });
    if (chat.clienteId !== aviso.clienteId) throw new NotFoundException('La ficha cambió desde el aviso.');
    // La elección expresa del destinatario determina qué identidad consultar.
    // El PAC propio de un familiar puede no existir en Resultados: consultar
    // primero ese PAC produciría un 404 antes de validar el paciente autorizado.
    const aOtraFicha = await this.prisma.destinoAvisoResultado.count({ where: { informeId: aviso.informeId, clienteId: aviso.clienteId } });
    const paciente = aOtraFicha ? (await this.portal.informes({ informeId: aviso.informeId, limite: 1 })).datos[0]?.paciente : undefined;
    if (paciente?.pac && paciente.pac !== chat.identidad?.pac) {
      const identidad: IdentidadInformeChat = { pac: paciente.pac, ...(paciente.ci ? { ci: paciente.ci } : {}) };
      const informe = await this.buscarInforme(identidad, aviso.informeId);
      if (informe) return { informe, pagina: null, identidad };
    } else if (chat.identidad) {
      // Si es el mismo PAC se conserva también el CI del chat: un conflicto de
      // identidad no se resuelve sustituyéndolo por el CI que dice el portal.
      const informe = await this.buscarInforme(chat.identidad, aviso.informeId);
      if (informe) return { informe, pagina: null, identidad: chat.identidad };
    }
    throw new NotFoundException('El informe del aviso ya no está disponible.');
  }

  /** El informe entre los vigentes de esa identidad, o `null`. */
  private async buscarInforme(identidad: IdentidadInformeChat, informeId: string): Promise<InformeParaChat | null> {
    for (let pagina = 1; pagina <= PAGINAS_MAXIMAS_AVISO; pagina++) {
      const datos = await this.portal.informesDelPaciente(identidad, pagina);
      const informe = datos.datos.find(i => i.id === informeId);
      if (informe) return informe;
      if (pagina * datos.limite >= datos.total) break;
    }
    return null;
  }

  async pdf(conversacionId: string, telefono: string, key: string): Promise<Buffer> {
    if (!key.startsWith(PREFIJO_INFORME_CHAT)) throw new NotFoundException();
    const seleccion = await this.seleccion(conversacionId, telefono, key.slice(PREFIJO_INFORME_CHAT.length));
    if (!seleccion.informe) throw new NotFoundException('No seleccionó un informe.');
    return this.portal.pdfDelPaciente(seleccion.identidad, seleccion.informe);
  }
}
