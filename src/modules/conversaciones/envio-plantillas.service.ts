import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

import { CacheMemoria } from '../../common/cache/cache-memoria';
import { enSegundoPlano } from '../../common/fiabilidad/en-segundo-plano';
import { normalizarTelefono } from '../../common/telefono/telefono';
import { WhatsappCloudService } from '../../common/whatsapp/whatsapp-cloud.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService, nombreProvisional } from '../clientes/clientes.service';
import { LineasWhatsappService } from '../lineas-whatsapp/lineas-whatsapp.service';
import { obtenerOCrearConversacion, SELECT_LINEA, whereAccesoConversacion as whereVisibilidad } from './acceso-conversacion';
import { ConversacionesGateway } from './conversaciones.gateway';
import { DespachadorSalienteService, PlantillaADespachar } from './despachador-saliente.service';
import { EnviarPlantillaDto } from './dto/enviar-plantilla.dto';
import { IniciarConversacionDto } from './dto/iniciar-conversacion.dto';
import { obtenerConversacionPropia, recuperarEnvioDuplicado } from './envio-comun';
import { PlantillaMeta, PlantillaResumen, renderizarPlantilla, resumirPlantilla, validarParametros } from './plantillas-whatsapp';

/**
 * Plantillas de WhatsApp: listarlas, mandarlas desde un chat, mandar las que
 * arma otro módulo (el aviso de resultados) y escribirle primero a alguien
 * («Nuevo chat»), que siempre empieza con una.
 *
 * Vivía dentro de `ConversacionesService`, mezclado con el inbox y el envío de
 * texto. Es su propio servicio porque tiene su propia caché, su propia
 * frontera con Meta (la lista de plantillas aprobadas por línea) y su propio
 * consumidor externo (`ResultadosService`). Lo que comparte con el envío de
 * texto —el chequeo de propiedad y la recuperación del doble clic— está en
 * `envio-comun.ts`.
 */
@Injectable()
export class EnvioPlantillasService {
  private readonly logger = new Logger(EnvioPlantillasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clientesService: ClientesService,
    private readonly gateway: ConversacionesGateway,
    private readonly whatsapp: WhatsappCloudService,
    private readonly despachador: DespachadorSalienteService,
    private readonly lineas: LineasWhatsappService,
  ) {}

  /**
   * Plantillas aprobadas de la WABA. 1 hora porque el dato vive en Meta —
   * aprobar una plantilla es un trámite de horas, no de segundos— y cada
   * consulta es un round-trip real contra su API.
   *
   * Antes eran 10 min. Medido en producción el 2026-08-22: con esa ventana,
   * esta consulta salía en vivo ~6 veces por hora y tardaba 400-1123 ms cada
   * vez; al caer en la misma ráfaga de peticiones con la que un agente abre
   * el inbox (junto a /conversaciones, /kpis/resumen, etc.), esas ventanas
   * mostraban además latencia elevada en endpoints que en aislamiento son
   * rápidos (GET /conversaciones: 4.5 ms de servidor por EXPLAIN ANALYZE,
   * pero 200-460 ms de punta a punta en esos momentos) — compatible con
   * contención en la única CPU del servidor durante esa ráfaga. Subir a 1h
   * corta la frecuencia de ese round-trip a una sexta parte sin arriesgar
   * nada: `GET /conversaciones/meta/plantillas?refresh=true` sigue
   * disponible para quien necesite la lista al segundo.
   */
  private readonly cachePlantillas = new CacheMemoria<PlantillaResumen[]>({
    ttlMs: 3_600_000,
    maxEntradas: 100,
  });

  /**
   * Lista las plantillas APROBADAS de la WABA — para el selector del inbox.
   * Solo las aprobadas se pueden enviar (Meta rechaza el resto). Se piden los
   * campos mínimos que la UI necesita para previsualizar y contar variables.
   */
  async listarPlantillas(forceRefresh = false, lineaId?: string, soloAgenteId?: string): Promise<PlantillaResumen[]> {
    if (!lineaId) return [];
    const linea = await this.lineas.porId(lineaId, soloAgenteId);
    const cuenta = this.lineas.credenciales(linea);
    const clave = `${linea.id}:${cuenta?.wabaId ?? ''}`;
    if (!forceRefresh) {
      const cacheado = this.cachePlantillas.obtener(clave);
      if (cacheado) return cacheado;
    }

    try {
      const crudas = await this.whatsapp.listarPlantillas(cuenta);
      /* null = no se pudieron pedir. Se devuelve lo último bueno que hubiera en
         caché antes que una lista vacía: un selector vacío parece "no tienes
         plantillas", que es otra cosa. Por eso se pide "aunque haya vencido":
         justo cuando Meta no responde es cuando la entrada suele estar caducada. */
      if (!crudas) throw new ServiceUnavailableException('No se pudieron consultar las plantillas de WhatsApp.');

      const resultado = (crudas as PlantillaMeta[])
        .filter(p => p.status === 'APPROVED')
        .map(resumirPlantilla);

      this.cachePlantillas.guardar(clave, resultado);
      return resultado;
    } catch (error) {
      this.logger.error('Excepción al listar plantillas de Meta', error);
      const respaldo = this.cachePlantillas.obtenerAunqueVencido(clave);
      if (respaldo && !forceRefresh) return respaldo;
      throw new ServiceUnavailableException('No se pudieron consultar las plantillas de WhatsApp. Vuelve a intentarlo.');
    }
  }

  /**
   * Envía una plantilla aprobada a un paciente — único modo permitido fuera de
   * la ventana de 24h. Mismo patrón que `enviarMensaje`: persiste, avisa por
   * WebSocket, y dispara la llamada a Meta SIN await (el agente no espera el
   * round-trip).
   */
  async enviarPlantilla(
    conversacionId: string,
    dto: EnviarPlantillaDto,
    agenteId: string,
    soloAgenteId?: string,
  ) {
    const conversacion = await obtenerConversacionPropia(this.prisma, conversacionId, soloAgenteId);
    const envio = await this.prepararPlantilla(conversacion.linea.id, dto);
    return this.registrarPlantilla(conversacion, envio, dto.clientMessageId, agenteId);
  }

  /**
   * Una plantilla que arma OTRO módulo del CRM, no una persona: hoy, el aviso
   * de resultados, con su botón de enlace variable y su propio texto para el
   * historial. Por eso no pasa por `prepararPlantilla` —esa plantilla no es
   * `enviable` desde el chat— y confía en quien llama, que ya decidió el
   * permiso por su cuenta.
   */
  async enviarPlantillaDelSistema(
    conversacionId: string,
    envio: { plantilla: string; idioma: string; boton?: string; imagenCabecera?: string; contenido: string },
    agenteId: string,
  ) {
    const conversacion = await obtenerConversacionPropia(this.prisma, conversacionId);
    const { contenido, ...despacho } = envio;
    return this.registrarPlantilla(conversacion, { despacho, contenido }, undefined, agenteId);
  }

  /**
   * Escribirle primero a alguien, desde la línea que se elija: una paciente de
   * la base o un número nuevo. Siempre con plantilla (ver `IniciarConversacionDto`).
   *
   * El orden importa. Todo lo que puede rechazarse —la línea, la plantilla, sus
   * variables, el teléfono, el permiso— se comprueba ANTES de dar de alta nada:
   * una ficha o un chat vacío creados por un intento fallido quedarían en la
   * bandeja como si alguien hubiera escrito.
   *
   * Si la paciente ya tiene chat en esa línea se usa ese —una conversación por
   * paciente y línea—, y la plantilla entra en su historial.
   */
  async iniciarConversacion(dto: IniciarConversacionDto, agenteId: string, soloAgenteId?: string) {
    const linea = await this.lineas.porId(dto.lineaId, soloAgenteId);
    if (!this.lineas.credenciales(linea)) {
      throw new BadRequestException(`La línea «${linea.nombre}» no está conectada a WhatsApp: desde ella no se puede escribir.`);
    }
    const envio = await this.prepararPlantilla(linea.id, dto);

    const cliente = dto.clienteId
      ? await this.clientesService.findOne(dto.clienteId, soloAgenteId)
      : await this.pacientePorTelefono(dto.telefono ?? '', dto.nombre);

    /* En una línea comercial la paciente tiene dueña: escribirle a la de otra
       agente es quitársela. Mismo criterio que la ficha (`findOne`). */
    if (linea.comercial && soloAgenteId && cliente.agenteId && cliente.agenteId !== soloAgenteId) {
      throw new ForbiddenException('Esta paciente la atiende otra agente. Pide a administración que te la asigne.');
    }

    const { id } = await obtenerOCrearConversacion(this.prisma, cliente.id, linea.id, false);
    const conversacion = await this.prisma.conversacion.findFirst({
      where: { id, ...whereVisibilidad(soloAgenteId) },
      select: { id: true, clienteId: true, linea: { select: SELECT_LINEA }, cliente: { select: { telefono: true } } },
    });
    if (!conversacion) {
      throw new ForbiddenException('Ese chat ya lo atiende otra persona de la línea.');
    }

    const mensaje = await this.registrarPlantilla(conversacion, envio, dto.clientMessageId, agenteId);
    return { conversacionId: conversacion.id, mensaje };
  }

  /** Normaliza el teléfono antes de buscar: es la clave que usará el webhook cuando contesten. */
  private async pacientePorTelefono(telefono: string, nombre?: string) {
    const canonico = normalizarTelefono(telefono);
    if (!canonico) throw new BadRequestException(`«${telefono}» no es un número de teléfono válido.`);
    return this.clientesService.obtenerOCrearPorTelefono(nombre?.trim() || nombreProvisional(canonico), canonico);
  }

  /**
   * La plantilla APROBADA de esa línea, sus variables validadas y el texto que
   * recibirá el paciente. Se lee de la misma caché que llena el selector, así
   * que no cuesta un viaje a Meta por envío.
   */
  private async prepararPlantilla(lineaId: string, dto: EnviarPlantillaDto) {
    const plantilla = (await this.listarPlantillas(false, lineaId)).find(
      p => p.nombre === dto.plantilla && p.idioma === dto.idioma,
    );
    if (!plantilla) {
      throw new BadRequestException(
        'Esa plantilla no está aprobada en esta línea. Pulsa «Actualizar desde Meta» y elige otra.',
      );
    }
    const parametros = validarParametros(plantilla, dto.parametros ?? []);
    const despacho: PlantillaADespachar = {
      plantilla: plantilla.nombre,
      idioma: plantilla.idioma,
      parametros,
      ...(plantilla.formato === 'NAMED' ? { nombresParametros: plantilla.nombresVariables } : {}),
    };
    return { despacho, contenido: renderizarPlantilla(plantilla, parametros) };
  }

  private async registrarPlantilla(
    conversacion: { id: string; clienteId: string; linea: { comercial: boolean }; cliente: { telefono: string } },
    { despacho, contenido }: { despacho: PlantillaADespachar; contenido: string },
    clientMessageId: string | undefined,
    agenteId: string,
  ) {
    const conversacionId = conversacion.id;
    let mensaje;
    try {
      [mensaje] = await this.prisma.$transaction([
        this.prisma.mensaje.create({
          data: {
            conversacionId,
            direccion: 'SALIENTE',
            contenido,
            estadoEnvio: 'ENVIADO',
            permiteReintento: false,
            clientMessageId: clientMessageId ?? null,
          },
        }),
        /* Mismo criterio que `enviarMensaje`: reclamar solo si está en el pool
           de una línea comercial. */
        this.prisma.conversacion.updateMany({
          where: { id: conversacionId, agenteId: null, linea: { comercial: true } },
          data: { agenteId },
        }),
        this.prisma.conversacion.update({
          where: { id: conversacionId },
          data: { updatedAt: new Date(), esperandoRespuesta: false },
        }),
      ]);
    } catch (error) {
      /* Doble clic o respuesta perdida: la misma fila, sin segundo envío a Meta
         —que además se cobra—. Ver `enviarMensaje`. */
      const yaCreado = await recuperarEnvioDuplicado(this.prisma, this.logger, error, conversacionId, clientMessageId);
      if (!yaCreado) throw error;
      return { ...yaCreado, clienteTelefono: conversacion.cliente.telefono };
    }

    /* Igual que un texto: quien le escribe a una paciente sin dueña en la línea
       comercial se la queda. Faltaba aquí, así que la plantilla —justo el
       primer contacto— era el único envío que no la reclamaba. */
    if (conversacion.linea.comercial) await this.clientesService
      .reclamarSiNoTieneDuena(conversacion.clienteId, agenteId, agenteId)
      .catch(error =>
        this.logger.error(`No se pudo reclamar la paciente ${conversacion.clienteId} para ${agenteId}`, error),
      );

    this.gateway.emitirActividad(conversacionId);

    void enSegundoPlano(`envío de la plantilla ${despacho.plantilla} a Meta`, this.logger, () =>
      this.despachador.plantilla({ mensajeId: mensaje.id, conversacionId, telefono: conversacion.cliente.telefono }, despacho),
    );

    return { ...mensaje, clienteTelefono: conversacion.cliente.telefono };
  }
}
