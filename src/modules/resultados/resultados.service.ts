import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { alcanceAgente, puedeEntregarResultados } from '../../common/auth/roles';
import { calcularPaginacion, paginar, RespuestaPaginada } from '../../common/dto/pagination.dto';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { ClientesService } from '../clientes/clientes.service';
import { obtenerOCrearConversacion } from '../conversaciones/acceso-conversacion';
import { ConversacionesService } from '../conversaciones/conversaciones.service';
import { LineasWhatsappService } from '../lineas-whatsapp/lineas-whatsapp.service';
import { InformePublicado, PortalResultadosClient } from './portal-resultados.client';
import { QueryResultadosDto } from './dto/query-resultados.dto';

/** Una fila de la cola tal y como la ve el asistente. */
export interface FilaEntrega {
  informeId: string;
  estudio: string;
  fechaEstudio: string;
  publicadoEn: string | null;
  accesoVigente: boolean;
  /** La ficha del CRM a la que se enviaría. `null` = no se reconoció. */
  paciente: { id: string; nombre: string; telefono: string } | null;
  /** Por qué clave se reconoció: con CI la asistente compara el nombre. */
  vinculo: 'PAC' | 'CI' | null;
  /** Por qué NO se reconoció, dicho para poder arreglarlo. */
  sinFicha: 'SIN_COINCIDENCIA' | 'CI_REPETIDO' | null;
  /** Cómo figura el paciente en el portal de resultados. */
  pacientePortal: { nombre: string; pac: string | null; ci: string | null };
  /** Ya avisado: cuándo y en qué estado quedó el mensaje. */
  aviso: { enviadoEn: Date; estadoMensaje: string | null } | null;
  /** Primera vez que el paciente abrió su informe. Es lo que importa: entregado no es visto. */
  abiertoEn: string | null;
}

@Injectable()
export class ResultadosService {
  private readonly logger = new Logger(ResultadosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly portal: PortalResultadosClient,
    private readonly clientes: ClientesService,
    private readonly conversaciones: ConversacionesService,
    private readonly lineas: LineasWhatsappService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Cola de entrega: lo que el portal publicó, cruzado con a quién ya se avisó.
   *
   * Los ya avisados NO se ocultan; se marcan. Esconderlos rompería la
   * paginación —el total lo da el portal, que no sabe lo que el CRM envió— y
   * además el asistente necesita ver qué ya salió.
   */
  async pendientes(query: QueryResultadosDto, usuario: UsuarioJwt): Promise<RespuestaPaginada<FilaEntrega>> {
    await this.permitirLinea(usuario);
    const { take } = calcularPaginacion(query);
    const cola = await this.portal.informes({ pagina: query.pagina ?? 1, limite: take });
    if (!cola.datos.length) return paginar([], cola.total, query);

    /* Consultas en lote, no por fila. */
    const [reconocidos, avisos] = await Promise.all([
      this.clientes.reconocerPacientes(cola.datos.map(informe => informe.paciente)),
      this.prisma.avisoResultado.findMany({
        where: { informeId: { in: cola.datos.map(informe => informe.informeId) } },
        select: { informeId: true, enviadoEn: true, mensaje: { select: { estadoEnvio: true } } },
      }),
    ]);
    const porInforme = new Map(avisos.map(aviso => [aviso.informeId, aviso]));

    const filas = cola.datos.map((informe, i): FilaEntrega => {
      const { cliente, via, motivo } = reconocidos[i];
      const aviso = porInforme.get(informe.informeId);
      return {
        informeId: informe.informeId,
        estudio: informe.estudio,
        fechaEstudio: informe.fechaEstudio,
        publicadoEn: informe.publicadoEn,
        accesoVigente: informe.accesoVigente,
        paciente: cliente,
        vinculo: via,
        sinFicha: motivo,
        pacientePortal: informe.paciente,
        aviso: aviso ? { enviadoEn: aviso.enviadoEn, estadoMensaje: aviso.mensaje?.estadoEnvio ?? null } : null,
        abiertoEn: informe.abiertoEn,
      };
    });
    return paginar(filas, cola.total, query);
  }

  /**
   * Manda al paciente el enlace de su informe por WhatsApp.
   *
   * Orden deliberado: se RESERVA el informe en `AvisoResultado` antes de
   * enviar. El índice único es lo que impide el doble envío bajo doble clic;
   * una comprobación previa la gana una carrera y el paciente recibe dos
   * WhatsApp de pago. Si algo falla después, la reserva se borra y el informe
   * vuelve a la cola.
   */
  async enviar(informeId: string, usuario: UsuarioJwt): Promise<{ enviado: true; mensajeId: string }> {
    /* Autorizar ANTES de consultar nada: si no, quien no tiene permiso puede
       sondear qué informes existen y qué PAC está en el CRM por el código de
       error que recibe. */
    const linea = await this.permitirLinea(usuario);
    return this.entregar(await this.revalidar(informeId), linea, usuario);
  }

  /**
   * Para cuando el enlace venció: lo extiende 30 días en el portal y vuelve a
   * avisar al paciente. El enlace es el mismo, así que el mensaje anterior
   * también vuelve a funcionar.
   *
   * La reserva del aviso anterior se libera **solo si es anterior al
   * vencimiento**. Con dos clics simultáneos, el segundo ya ve el enlace
   * vigente y recibe 409; y si los dos llegan antes de renovar, ninguno borra
   * la reserva nueva del otro —es posterior al vencimiento—, así que el índice
   * único sigue dejando pasar un solo WhatsApp.
   */
  async renovarYEnviar(informeId: string, usuario: UsuarioJwt): Promise<{ enviado: true; mensajeId: string }> {
    const linea = await this.permitirLinea(usuario);
    const [previo] = (await this.portal.informes({ informeId, limite: 1 })).datos;
    if (!previo) throw new NotFoundException('Ese informe ya no está publicado en el portal.');
    if (previo.accesoVigente) {
      throw new ConflictException('El enlace de este informe sigue activo: no hace falta renovarlo.');
    }
    await this.portal.renovarAcceso(informeId);
    await this.prisma.avisoResultado.deleteMany({ where: { informeId, enviadoEn: { lt: new Date(previo.accesoExpiraEn) } } });
    return this.entregar(await this.revalidar(informeId), linea, usuario);
  }

  private async entregar(informe: InformePublicado, linea: string, usuario: UsuarioJwt): Promise<{ enviado: true; mensajeId: string }> {
    const informeId = informe.informeId;
    /* Se reconoce de nuevo aquí, no se confía en la fila que vio la
       asistente: entre la cola y el clic alguien pudo corregir un CI. */
    const [{ cliente, motivo }] = await this.clientes.reconocerPacientes([informe.paciente]);
    if (!cliente) {
      throw new NotFoundException(
        motivo === 'CI_REPETIDO'
          ? 'El CI de este paciente está en más de una ficha del CRM. Corrige las fichas antes de avisarle.'
          : 'El paciente del informe no tiene ficha en el CRM con ese PAC o CI. Revísalo antes de avisarle.',
      );
    }

    const reserva = await this.reservar(informeId, cliente.id, usuario.sub);
    try {
      /* Resultados no es tráfico comercial: la conversación no reserva lead. */
      const conversacion = await obtenerOCrearConversacion(this.prisma, cliente.id, linea, false);
      const mensaje = await this.conversaciones.enviarPlantillaDelSistema(
        conversacion.id,
        {
          plantilla: this.variable('RESULTADOS_PLANTILLA'),
          idioma: process.env.RESULTADOS_PLANTILLA_IDIOMA ?? 'es',
          /* La variable del botón URL: identifica el acceso, no lo autoriza. */
          boton: informe.accesoId,
          contenido: this.textoParaHistorial(informe),
        },
        usuario.sub,
      );
      await this.prisma.avisoResultado.update({ where: { id: reserva.id }, data: { mensajeId: mensaje.id } });
      await this.audit.registrar('AvisoResultado', reserva.id, 'RESULTADO_ENVIADO', usuario.sub, {
        informeId,
        clienteId: cliente.id,
        estudio: informe.estudio,
      });
      return { enviado: true, mensajeId: mensaje.id };
    } catch (error) {
      /* La reserva sin mensaje sería un informe que nadie puede volver a
         enviar. Se libera para que reaparezca en la cola. */
      await this.prisma.avisoResultado
        .delete({ where: { id: reserva.id } })
        .catch(() => this.logger.error(`Reserva ${reserva.id} huérfana: el informe ${informeId} no podrá reenviarse hasta borrarla.`));
      throw error;
    }
  }

  /** Revalida contra el portal: la pantalla del asistente puede estar vieja. */
  private async revalidar(informeId: string): Promise<InformePublicado> {
    const cola = await this.portal.informes({ informeId, limite: 1 });
    const informe = cola.datos[0];
    if (!informe) {
      throw new NotFoundException('Ese informe ya no está publicado en el portal.');
    }
    if (!informe.accesoVigente) {
      throw new ConflictException('El enlace del paciente venció. Usa «Renovar y enviar».');
    }
    return informe;
  }

  private async reservar(informeId: string, clienteId: string, enviadoPorId: string) {
    /* El `catch` de `enviar` solo ve los fallos síncronos: `enviarPlantilla`
       despacha a Meta en segundo plano, así que un rechazo real —plantilla sin
       aprobar, número sin WhatsApp— llega DESPUÉS y deja el mensaje en FALLIDO
       con la reserva puesta. Sin esto el informe quedaría "avisado" para
       siempre sin que el paciente recibiera nada. FALLIDO es definitivo en una
       plantilla (`permiteReintento: false`): consta que no salió, se libera.
       INCIERTO no: pudo llegar, y reenviar sería el doble WhatsApp que la
       reserva existe para impedir. Bajo doble clic, el índice sigue decidiendo. */
    await this.prisma.avisoResultado.deleteMany({ where: { informeId, mensaje: { estadoEnvio: 'FALLIDO' } } });
    try {
      return await this.prisma.avisoResultado.create({ data: { informeId, clienteId, enviadoPorId } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Este informe ya se le envió al paciente.');
      }
      throw error;
    }
  }

  /**
   * Dos condiciones, y las dos hacen falta:
   *
   * 1. **El rol entrega resultados** (`puedeEntregarResultados`: asistente o
   *    administración). El rango no sirve —`ASISTENTE` está por debajo de un
   *    agente—, así que no lo puede decir `@Roles`.
   * 2. **Acceso a la línea de resultados**, que es por donde sale el mensaje.
   *
   * Solo con la segunda, cualquiera que atienda la línea de Recepción entregaba
   * informes médicos: en producción, un agente de ventas y la recepcionista.
   * Quien no pase recibe el mismo 404 que sin la línea, que no confirma nada.
   *
   * `alcanceAgente` devuelve `undefined` de ADMIN para arriba: alcance global.
   */
  private async permitirLinea(usuario: UsuarioJwt): Promise<string> {
    const linea = this.variable('RESULTADOS_LINEA_ID');
    if (!puedeEntregarResultados(usuario.rol)) throw new NotFoundException('Línea no encontrada');
    await this.lineas.porId(linea, alcanceAgente(usuario));
    return linea;
  }

  private variable(nombre: string): string {
    const valor = process.env[nombre];
    if (!valor) {
      throw new ServiceUnavailableException(
        `La entrega de resultados no está configurada en el servidor: falta ${nombre}.`,
      );
    }
    return valor;
  }

  /**
   * Lo que verá el equipo en el historial del chat. No es lo que recibe el
   * paciente —eso lo fija la plantilla aprobada en Meta— sino el registro de
   * qué se envió y a qué informe apunta.
   */
  private textoParaHistorial(informe: InformePublicado): string {
    const base = (process.env.PORTAL_RESULTADOS_PUBLICO ?? '').replace(/\/$/, '');
    const enlace = base ? `${base}/${informe.accesoId}` : `acceso ${informe.accesoId}`;
    return `Aviso de resultado disponible — ${informe.estudio}. Enlace enviado: ${enlace}`;
  }
}
