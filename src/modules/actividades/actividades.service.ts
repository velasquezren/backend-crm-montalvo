import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../../prisma/prisma-client';

import { alcanceAgente, cubreRol } from '../../common/auth/roles';
import { conHoraClinica, inicioDelDiaClinica, sumarDiasClinica } from '../../common/fechas/zona-clinica';
import { UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { terminoBusqueda } from '../../common/dto/busqueda';
import { enSegundoPlano } from '../../common/fiabilidad/en-segundo-plano';
import { calcularPaginacion, paginar } from '../../common/dto/pagination.dto';
import { PushService } from '../../common/push/push.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { ConversacionesGateway } from '../conversaciones/conversaciones.gateway';
import { CreateActividadDto, RepetirActividadDto } from './dto/create-actividad.dto';
import { QueryActividadDto } from './dto/query-actividad.dto';
import { UpdateActividadDto } from './dto/update-actividad.dto';
import { UpdateEstadoActividadDto } from './dto/update-estado-actividad.dto';

/** Campos que viajan en listado y ficha — declarados una vez para que no diverjan. */
const INCLUYE_ACTIVIDAD = {
  cliente: { select: { id: true, nombre: true, telefono: true, pac: true } },
  lead: { select: { id: true, estado: true, origen: true } },
  agente: { select: { id: true, nombre: true } },
} satisfies Prisma.ActividadInclude;

const VENTANA_RECORDATORIO_MIN = 15;
const INTERVALO_BARRIDO_MS = 5 * 60 * 1000;

/** Cuántos recordatorios como mucho se despachan en un barrido. */
const TOPE_BARRIDO = 50;

/**
 * Cuántos se despachan a la vez.
 *
 * No es prudencia teórica: el VPS tiene **un núcleo y 1,7 GB**, y el pool de
 * Prisma se dimensiona solo a `núcleos × 2 + 1` — tres conexiones. Soltar los
 * cincuenta de golpe con un `Promise.all` pone hasta cincuenta `update()` a
 * competir por esas tres, con `pool_timeout` de 10 s, **en el mismo pool que
 * atiende a las agentes**: el barrido de un minuto tranquilo se convierte en
 * timeouts en la pantalla de alguien que solo estaba abriendo un chat. Y cada
 * push firma un JWT VAPID (ECDSA), que es CPU en un core que no sobra.
 *
 * De a cinco, el barrido completo son diez tandas de red que igual terminan en
 * un segundo, y ni la base ni el core se enteran.
 */
const CONCURRENCIA_NOTIFICACION = 5;

/**
 * La primera fecha, más `veces - 1` más espaciadas por `frecuencia` — pura,
 * sin tocar la base, para poder probarla sin Postgres. `setMonth`/`setDate`
 * mutan una copia (`new Date(anterior)`) cada vuelta, nunca la fecha
 * original.
 *
 * MENSUAL tiene un borde conocido y aceptado: `setMonth` no es "sumar 30
 * días", es "mismo día del mes siguiente", y en meses cortos JS lo
 * desborda al mes de después (31 de enero → 3 de marzo, no 28/29 de
 * febrero). Es el mismo comportamiento que tiene cualquier calendario que
 * agende "el mismo día cada mes" sin una librería de fechas de por medio;
 * se documenta en vez de arrastrar una dependencia nueva solo para esto.
 */
function fechasDeRepeticion(inicio: Date, repetir?: RepetirActividadDto): Date[] {
  if (!repetir) return [inicio];

  const fechas = [inicio];
  for (let i = 1; i < repetir.veces; i++) {
    const siguiente = new Date(fechas[i - 1]!);
    switch (repetir.frecuencia) {
      case 'SEMANAL':
        siguiente.setDate(siguiente.getDate() + 7);
        break;
      case 'QUINCENAL':
        siguiente.setDate(siguiente.getDate() + 14);
        break;
      case 'MENSUAL':
        siguiente.setMonth(siguiente.getMonth() + 1);
        break;
    }
    fechas.push(siguiente);
  }
  return fechas;
}

/**
 * Seguimiento comercial: recordatorios y tareas que un agente se agenda sobre
 * un Cliente/Lead. NO es la agenda médica (horario clínico de los médicos,
 * app y base independientes) — acá no se reserva ningún recurso físico, así
 * que no hay regla de "no dos citas encimadas".
 *
 * El barrido de recordatorios (`onModuleInit`) sigue el mismo patrón que
 * `TipoCambioService`: un `setInterval` que sobrevive a un `systemctl restart`
 * a cualquier hora, en vez de un cron a hora fija que se puede saltar un
 * reinicio, con `.unref()` para no ser el motivo por el que el proceso sigue
 * vivo.
 */
@Injectable()
export class ActividadesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ActividadesService.name);
  private intervalo?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clientesService: ClientesService,
    private readonly pushService: PushService,
    private readonly realtimeGateway: ConversacionesGateway,
  ) {}

  onModuleInit(): void {
    /* La suite unitaria/integración de este backend instancia los services a
       mano, no el AppModule completo — esto es solo por si algún día alguien
       bootstrapea el módulo entero en una prueba. */
    if (process.env.NODE_ENV === 'test') return;

    this.intervalo = setInterval(
      () =>
        void enSegundoPlano('barrido de recordatorios de actividades', this.logger, () =>
          this.barrerRecordatoriosPendientes(),
        ),
      INTERVALO_BARRIDO_MS,
    );
    this.intervalo.unref();
  }

  onModuleDestroy(): void {
    if (this.intervalo) clearInterval(this.intervalo);
  }

  private construirWhere(query: QueryActividadDto, soloAgenteId?: string): Prisma.ActividadWhereInput {
    const busqueda = terminoBusqueda(query.q);

    return {
      tipo: query.tipo,
      estado: query.estado,
      clienteId: query.clienteId,
      leadId: query.leadId,
      // Un AGENTE siempre queda acotado a lo suyo — no existe un "pool sin
      // asignar" para tareas personales, a diferencia de Leads/Conversaciones.
      agenteId: soloAgenteId ?? query.agenteId,
      fechaProgramada: {
        gte: query.desde,
        lte: query.hasta,
      },
      ...(busqueda
        ? {
            OR: [
              { titulo: { contains: busqueda, mode: 'insensitive' } },
              { notas: { contains: busqueda, mode: 'insensitive' } },
              { cliente: { nombre: { contains: busqueda, mode: 'insensitive' } } },
              { cliente: { telefono: { contains: busqueda, mode: 'insensitive' } } },
              { cliente: { pac: { contains: busqueda, mode: 'insensitive' } } },
              { cliente: { ci: { contains: busqueda, mode: 'insensitive' } } },
            ] satisfies Prisma.ActividadWhereInput[],
          }
        : {}),
    };
  }

  async findAll(query: QueryActividadDto, soloAgenteId?: string) {
    const where = this.construirWhere(query, soloAgenteId);
    const { skip, take } = calcularPaginacion(query);

    const [datos, total] = await this.prisma.$transaction([
      this.prisma.actividad.findMany({
        where,
        orderBy: { fechaProgramada: 'asc' },
        include: INCLUYE_ACTIVIDAD,
        skip,
        take,
      }),
      this.prisma.actividad.count({ where }),
    ]);

    return paginar(datos, total, query);
  }

  /**
   * Conteos para las cabeceras de "Hoy" / "Vencidas" / "Próximos 7 días" / "Completadas" —
   * mismo criterio que `LeadsService.resumenPorEstado`: la UI necesita el
   * total real, no solo cuántas tarjetas cargó.
   */
  async resumen(query: QueryActividadDto, soloAgenteId?: string) {
    const where = this.construirWhere(query, soloAgenteId);
    /* Los tres cortes, en la zona de la clínica y no en la del proceso.
       `new Date(anio, mes, dia)` partía el día donde el VPS creyera que era
       medianoche —está en Estados Unidos—, así que entre las 20:00 y las 24:00
       de La Paz este «hoy» ya era el día siguiente y lo de esa misma tarde se
       contaba como VENCIDA. Y `+24 h` tampoco es «un día»: se suma sobre el
       calendario. Los instantes guardados no cambian; solo dónde se corta. */
    const ahora = new Date();
    const inicioHoy = inicioDelDiaClinica(ahora);
    const finHoy = sumarDiasClinica(inicioHoy, 1);
    const en7Dias = sumarDiasClinica(inicioHoy, 7);
    const pendiente = { ...where, estado: 'PENDIENTE' as const };

    const [vencidas, hoy, proximaSemana, completadas] = await this.prisma.$transaction([
      this.prisma.actividad.count({ where: { ...pendiente, fechaProgramada: { lt: inicioHoy } } }),
      this.prisma.actividad.count({
        where: { ...pendiente, fechaProgramada: { gte: inicioHoy, lt: finHoy } },
      }),
      this.prisma.actividad.count({
        where: { ...pendiente, fechaProgramada: { gte: finHoy, lt: en7Dias } },
      }),
      this.prisma.actividad.count({
        where: { ...where, estado: 'COMPLETADA' as const },
      }),
    ]);

    return { vencidas, hoy, proximaSemana, completadas };
  }

  async findOne(id: string, soloAgenteId?: string) {
    const actividad = await this.prisma.actividad.findUnique({
      where: { id },
      include: INCLUYE_ACTIVIDAD,
    });
    if (!actividad || !this.enAlcance(actividad, soloAgenteId)) {
      throw new NotFoundException(`Actividad ${id} no encontrada`);
    }
    return actividad;
  }

  /**
   * `usuario` completo (no solo el id) porque decide dos cosas: quién queda
   * como dueño (`agenteId`, salvo que un ADMIN+ agende a nombre de otro
   * agente) y el alcance para validar que el cliente/lead citados son
   * visibles para quien crea la actividad.
   */
  async create(dto: CreateActividadDto, usuario: UsuarioJwt) {
    const soloAgenteId = alcanceAgente(usuario);
    // Reusa la validación de existencia + escopado por rol de Clientes: si el
    // cliente no existe o está fuera del alcance de quien la crea, esto ya
    // lanza NotFoundException — no hace falta repetir el chequeo aquí.
    await this.clientesService.findOne(dto.clienteId, soloAgenteId);

    if (dto.leadId) {
      const lead = await this.prisma.lead.findUnique({
        where: { id: dto.leadId },
        select: { id: true, clienteId: true },
      });
      if (!lead || lead.clienteId !== dto.clienteId) {
        throw new NotFoundException(`Lead ${dto.leadId} no encontrado para este cliente`);
      }
    }

    // Solo ADMIN+ puede agendarle una tarea a otra persona; un agente normal
    // siempre queda como dueño de lo que crea, sin importar qué mande el body.
    const agenteId =
      dto.agenteId && cubreRol(usuario.rol, 'ADMIN') ? dto.agenteId : usuario.sub;
    if (agenteId !== usuario.sub) {
      const agente = await this.prisma.usuario.findUnique({ where: { id: agenteId } });
      if (!agente || !agente.activo) {
        throw new NotFoundException(`Agente ${agenteId} no encontrado o inactivo`);
      }
    }

    const datosComunes = {
      tipo: dto.tipo,
      titulo: dto.titulo.trim(),
      notas: dto.notas?.trim(),
      duracionMinutos: dto.duracionMinutos,
      clienteId: dto.clienteId,
      leadId: dto.leadId,
      agenteId,
    };

    const [primeraFecha, ...siguientesFechas] = fechasDeRepeticion(dto.fechaProgramada, dto.repetir);

    /* La identidad de la serie se genera UNA vez y la reciben todas las
       ocurrencias de esta alta. Sin repetición queda `null`: una actividad
       suelta no es una serie de uno, y tratarla como tal haría que «esta y las
       siguientes» apareciera donde no hay nada que propagar. */
    const identidadDeSerie = dto.repetir
      ? { serieId: randomUUID(), frecuenciaSerie: dto.repetir.frecuencia }
      : {};

    // Todo en una sola transacción: o quedan las `veces` filas, o ninguna —
    // nunca una "repetición" a medias por un fallo a mitad de camino.
    return this.prisma.$transaction(async tx => {
      const primera = await tx.actividad.create({
        data: { ...datosComunes, ...identidadDeSerie, fechaProgramada: primeraFecha },
        include: INCLUYE_ACTIVIDAD,
      });

      if (siguientesFechas.length > 0) {
        await tx.actividad.createMany({
          data: siguientesFechas.map(fechaProgramada => ({
            ...datosComunes,
            ...identidadDeSerie,
            fechaProgramada,
          })),
        });
      }

      return primera;
    });
  }

  async update(id: string, dto: UpdateActividadDto, soloAgenteId?: string) {
    const existente = await this.prisma.actividad.findUnique({
      where: { id },
      select: { id: true, agenteId: true, clienteId: true, leadId: true },
    });
    if (!existente || !this.enAlcance(existente, soloAgenteId)) {
      throw new NotFoundException(`Actividad ${id} no encontrada`);
    }

    if (dto.clienteId !== undefined || dto.leadId !== undefined) {
      const clienteId = dto.clienteId ?? existente.clienteId;
      await this.clientesService.findOne(clienteId, soloAgenteId);
      const leadId = dto.leadId === undefined ? existente.leadId : dto.leadId;
      if (leadId) {
        const lead = await this.prisma.lead.findUnique({
          where: { id: leadId },
          select: { id: true, clienteId: true },
        });
        if (!lead || lead.clienteId !== clienteId) {
          throw new NotFoundException(`Lead ${leadId} no encontrado para este cliente`);
        }
      }
    }

    return this.prisma.actividad.update({
      where: { id },
      data: {
        tipo: dto.tipo,
        titulo: dto.titulo?.trim(),
        notas: dto.notas?.trim(),
        fechaProgramada: dto.fechaProgramada,
        duracionMinutos: dto.duracionMinutos,
        clienteId: dto.clienteId,
        leadId: dto.leadId,
        // Reprogramar limpia el aviso ya mandado: si la nueva fecha vuelve a
        // caer dentro de la ventana, el barrido debe poder notificar de nuevo.
        ...(dto.fechaProgramada ? { notificadaEn: null } : {}),
      },
      include: INCLUYE_ACTIVIDAD,
    });
  }

  /**
   * El único cambio de estado. Recibe el DTO entero —no un `EstadoActividad`
   * suelto— porque completar una actividad puede traer notas del desenlace
   * ("no contestó, reintentar el lunes"), y el estado y esa nota se escriben en
   * el mismo `update` o quedan a medias si el segundo falla.
   */
  async actualizarEstado(id: string, dto: UpdateEstadoActividadDto, soloAgenteId?: string) {
    const existente = await this.prisma.actividad.findUnique({
      where: { id },
      select: { id: true, agenteId: true },
    });
    if (!existente || !this.enAlcance(existente, soloAgenteId)) {
      throw new NotFoundException(`Actividad ${id} no encontrada`);
    }

    const { estado, notas } = dto;

    return this.prisma.actividad.update({
      where: { id },
      data: {
        estado,
        completadaEn: estado === 'COMPLETADA' ? new Date() : null,
        /* `undefined` es "no lo mandaron" y deja las notas como estaban; una
           cadena en blanco sí las borra. Sin la distinción, cerrar una tarjeta
           desde la campana de notificaciones —que solo manda el estado— habría
           vaciado la nota que la agente escribió al agendarla. */
        ...(notas !== undefined ? { notas: notas.trim() || null } : {}),
      },
      include: INCLUYE_ACTIVIDAD,
    });
  }

  /* ── «Esta y las siguientes» ──────────────────────────────────────────
   *
   * FUTURAS = misma `serieId`, PENDIENTES, dentro del alcance de quien pide, y
   * con `fechaProgramada >= la de la ocurrencia elegida`.
   *
   * La comparación usa la fecha ACTUAL de cada una, no un orden histórico de la
   * serie — que no existe y no se guarda. Una ocurrencia que alguien movió
   * hacia atrás deja de ser futura respecto a la elegida, y no entra. Es la
   * regla más simple que se puede explicar en una frase, y la única que no
   * obliga a guardar el patrón.
   */

  /**
   * Las candidatas de «esta y las siguientes», ya filtradas por alcance.
   *
   * Devolverlas NO es un permiso: cada escritura vuelve a exigir sus
   * condiciones. Entre esta lectura y el UPDATE, otra agente puede completar
   * una — y entonces debe quedarse como está.
   */
  private async origenDeSerie(id: string, soloAgenteId?: string) {
    const origen = await this.prisma.actividad.findUnique({
      where: { id },
      select: { id: true, agenteId: true, serieId: true, estado: true, fechaProgramada: true },
    });
    if (!origen || !this.enAlcance(origen, soloAgenteId)) {
      throw new NotFoundException(`Actividad ${id} no encontrada`);
    }
    if (!origen.serieId) {
      /* Una actividad suelta no es una serie de una: ofrecer «y las siguientes»
         sobre ella no significaría nada. Para esas están los endpoints de
         siempre. */
      throw new BadRequestException(
        'Esta actividad no pertenece a una repetición; usa la edición individual.',
      );
    }
    if (origen.estado !== 'PENDIENTE') {
      throw new BadRequestException(
        'Solo se puede operar sobre la serie desde una actividad pendiente.',
      );
    }
    return { ...origen, serieId: origen.serieId };
  }

  private dondeFuturas(
    serieId: string,
    desde: Date,
    soloAgenteId?: string,
  ): Prisma.ActividadWhereInput {
    return {
      serieId,
      estado: 'PENDIENTE',
      fechaProgramada: { gte: desde },
      // F04: compartir `serieId` no da permiso sobre lo que es de otra agente.
      ...(soloAgenteId ? { agenteId: soloAgenteId } : {}),
    };
  }

  /**
   * Pone esta ocurrencia y las siguientes a otra hora, cada una en SU día.
   *
   * No es un `updateMany`: cada fila acaba con un instante distinto, porque
   * conserva su propio día de calendario. Son doce como mucho, así que doce
   * escrituras condicionadas son más baratas de leer y de mantener que un SQL
   * que calcule el instante fila a fila.
   */
  async cambiarHoraDeFuturas(
    id: string,
    hhmm: string,
    soloAgenteId?: string,
  ): Promise<{ afectadas: number }> {
    const origen = await this.origenDeSerie(id, soloAgenteId);
    const [hora, minuto] = hhmm.split(':').map(Number) as [number, number];

    return this.prisma.$transaction(async tx => {
      const candidatas = await tx.actividad.findMany({
        where: this.dondeFuturas(origen.serieId, origen.fechaProgramada, soloAgenteId),
        select: { id: true, fechaProgramada: true },
      });

      let afectadas = 0;
      for (const candidata of candidatas) {
        const nueva = conHoraClinica(candidata.fechaProgramada, hora, minuto);
        // Ya estaba a esa hora: no se toca, y sobre todo no se le borra el aviso.
        if (nueva.getTime() === candidata.fechaProgramada.getTime()) continue;

        const { count } = await tx.actividad.updateMany({
          /* `estado` se repite AQUÍ, no solo en la lectura: si alguien la
             completó entre medias, esta escritura no la encuentra y la deja
             como está. Es la garantía, y no se puede dar filtrando antes. */
          where: { id: candidata.id, estado: 'PENDIENTE' },
          // Cambia de hora: tiene que poder volver a avisar en la nueva.
          data: { fechaProgramada: nueva, notificadaEn: null },
        });
        afectadas += count;
      }

      return { afectadas };
    });
  }

  /**
   * Cancela esta ocurrencia y las siguientes.
   *
   * Aquí sí es un `updateMany`: todas acaban igual. Cancelar no toca
   * `notificadaEn` —no hay hora nueva que avisar— ni roza a las COMPLETADAS,
   * que son historial y no se reescriben.
   */
  async cancelarFuturas(id: string, soloAgenteId?: string): Promise<{ afectadas: number }> {
    const origen = await this.origenDeSerie(id, soloAgenteId);

    const { count } = await this.prisma.actividad.updateMany({
      where: this.dondeFuturas(origen.serieId, origen.fechaProgramada, soloAgenteId),
      // Misma semántica que `actualizarEstado`: cancelar limpia `completadaEn`.
      data: { estado: 'CANCELADA', completadaEn: null },
    });

    return { afectadas: count };
  }

  async remove(id: string, soloAgenteId?: string): Promise<{ ok: true }> {
    const existente = await this.prisma.actividad.findUnique({
      where: { id },
      select: { id: true, agenteId: true },
    });
    if (!existente || !this.enAlcance(existente, soloAgenteId)) {
      throw new NotFoundException(`Actividad ${id} no encontrada`);
    }
    await this.prisma.actividad.delete({ where: { id } });
    return { ok: true };
  }

  private enAlcance(actividad: { agenteId: string }, soloAgenteId?: string): boolean {
    return !soloAgenteId || actividad.agenteId === soloAgenteId;
  }

  /**
   * Recordatorios PENDIENTES cuya hora cae dentro de los próximos
   * `VENTANA_RECORDATORIO_MIN` minutos y que todavía no se notificaron.
   * Expuesto (no `private`) para que la prueba pueda esperar su promesa —
   * el `onModuleInit` la dispara con `void`, igual que `TipoCambioService`.
   */
  async barrerRecordatoriosPendientes(): Promise<number> {
    const ahora = new Date();
    const limite = new Date(ahora.getTime() + VENTANA_RECORDATORIO_MIN * 60 * 1000);

    const pendientes = await this.prisma.actividad.findMany({
      where: {
        estado: 'PENDIENTE',
        notificadaEn: null,
        fechaProgramada: { lte: limite },
      },
      select: { id: true, titulo: true, tipo: true, agenteId: true, cliente: { select: { nombre: true } } },
      take: TOPE_BARRIDO,
      orderBy: { fechaProgramada: 'asc' },
    });

    if (pendientes.length === TOPE_BARRIDO) {
      /* El tope existe para que un atasco no dispare mil notificaciones de
         golpe, pero alcanzarlo significa que este barrido dejó recordatorios
         sin avisar. A este volumen no debería pasar nunca; si pasa, se ve en el
         log en vez de descubrirse porque una agente no recibió el suyo. */
      this.logger.warn(
        `El barrido llegó al tope de ${TOPE_BARRIDO} recordatorios: puede haber más esperando.`,
      );
    }

    for (let i = 0; i < pendientes.length; i += CONCURRENCIA_NOTIFICACION) {
      await Promise.all(
        pendientes.slice(i, i + CONCURRENCIA_NOTIFICACION).map(a => this.notificarRecordatorio(a, ahora)),
      );
    }

    return pendientes.length;
  }

  /**
   * Avisa de UNA actividad y la marca como notificada. Nunca lanza.
   *
   * El `try/catch` es por elemento a propósito: una falla notificando una
   * actividad no puede perder el aviso de las demás — mismo criterio que el
   * bucle de `procesarWebhook` (`crm-backend-module`).
   */
  private async notificarRecordatorio(
    actividad: { id: string; titulo: string; agenteId: string; cliente: { nombre: string } },
    ahora: Date,
  ): Promise<void> {
    try {
      // Dos canales independientes, a propósito: el push llega aunque la
      // pestaña esté cerrada; el WebSocket es instantáneo si la agente ya
      // tiene el CRM abierto (no espera al service worker) y dispara el
      // toast en vivo con la acción de completar. Uno no reemplaza al otro.
      await this.pushService.enviarAUsuario(actividad.agenteId, {
        titulo: 'Recordatorio',
        mensaje: `${actividad.titulo} — ${actividad.cliente.nombre}`,
        url: '/actividades',
        tag: `actividad-${actividad.id}`,
      });
      this.realtimeGateway.emitirRecordatorioActividad(actividad.id, actividad.agenteId);
      await this.prisma.actividad.update({
        where: { id: actividad.id },
        data: { notificadaEn: ahora },
      });
    } catch (error: unknown) {
      this.logger.warn(`No se pudo notificar la actividad ${actividad.id}`, error);
    }
  }
}
