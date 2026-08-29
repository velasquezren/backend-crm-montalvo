import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CategoriaCliente, EstadoLead, Prisma } from '@prisma/client';

import { AuditService } from '../../common/audit/audit.service';
import { terminoBusqueda } from '../../common/dto/busqueda';
import { calcularPaginacion, construirOrden, paginar } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { ServiciosService } from '../servicios/servicios.service';
import { CreateClienteDto } from './dto/create-cliente.dto';
import { CreateInteresDto } from './dto/create-interes.dto';
import { QueryClienteDto } from './dto/query-cliente.dto';
import { UpdateClienteDto } from './dto/update-cliente.dto';

/**
 * Módulo Clientes — dueño exclusivo de la entidad Cliente/Interes y de la
 * categorización (CRM_MANIFESTO.md §5). Otros módulos (ventas, leads,
 * conversaciones) deben llamar a estos métodos públicos, nunca tocar
 * `prisma.cliente` directamente.
 */

/**
 * Campos que se devuelven de un cliente, en el listado y en la ficha.
 *
 * Se declara una vez y se usa en ambos sitios para que no puedan divergir.
 *
 * `datosExtra` —el volcado de FileMaker— estuvo fuera a propósito, por no
 * arrastrar un JSON opaco en cada fila. Ahora entra, y con motivo: los tags e
 * intereses del paciente viven ahí dentro y el listado los pinta
 * (`clientes.page.ts`, `listaExtra(...'tags','intereses')`). Sin él, la columna
 * salía vacía para los 15.302 pacientes que tienen algo escrito.
 *
 * Medido antes de dejarlo: 412 bytes de media, 712 el mayor, unos 20 KB extra
 * por página de 50. Es asumible para lo que muestra, pero es el campo que hay
 * que mirar primero si el listado se vuelve lento — y la razón por la que no
 * debe crecer con datos nuevos: lo que haga falta de verdad va a su columna.
 */
const CAMPOS_CLIENTE = {
  id: true,
  nombre: true,
  telefono: true,
  email: true,
  categoria: true,
  agenteId: true,
  agente: { select: { id: true, nombre: true } },
  conversaciones: {
    select: { agenteId: true, agente: { select: { id: true, nombre: true } } },
    take: 1,
    orderBy: { updatedAt: 'desc' },
  },
  pac: true,
  fechaNacimiento: true,
  sexo: true,
  ocupacion: true,
  ci: true,
  ciLugar: true,
  estadoCivil: true,
  direccion: true,
  nacionalidad: true,
  telefonoFijo: true,
  nit: true,
  saldoTotal: true,
  empresaTrabajo: true,
  contactoRef: true,
  telefonoRef: true,
  telefonoOficina: true,
  visitasPrevias: true,
  datosExtra: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class ClientesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly serviciosService: ServiciosService,
  ) {}

  async create(dto: CreateClienteDto) {
    const existente = await this.prisma.cliente.findUnique({ where: { telefono: dto.telefono } });
    if (existente) {
      throw new ConflictException(`Ya existe un cliente con el teléfono ${dto.telefono}`);
    }

    // `fechaNacimiento` NO entra en datosExtra: es columna propia. Meterla en
    // el JSON era lo que hacía que editarla no cambiara nada en pantalla.
    const { empresa, fechaNacimiento, lugarNacimiento, datosExtra, ...restoDto } = dto;
    const datosExtraCombinados = {
      ...(datosExtra || {}),
    };

    return this.prisma.cliente.create({
      data: {
        ...restoDto,
        ...(fechaNacimiento !== undefined ? { fechaNacimiento: new Date(fechaNacimiento) } : {}),
        ...(empresa !== undefined ? { empresaTrabajo: empresa || null } : {}),
        ...(lugarNacimiento !== undefined ? { ciLugar: lugarNacimiento || null } : {}),
        datosExtra: Object.keys(datosExtraCombinados).length > 0 ? (datosExtraCombinados as Prisma.InputJsonValue) : undefined,
      },
    });
  }

  /**
   * Visibilidad por rol: un AGENTE ve sus clientes asignados y el pool sin
   * asignar (la asignación es manual en v1); un ADMIN ve todo — se controla
   * pasando (o no) soloAgenteId desde el controller.
   */
  async findAll(query: QueryClienteDto, soloAgenteId?: string) {
    /* Escapado: `%` y `_` son comodines de LIKE y Prisma no los neutraliza.
       Sin esto, buscar "50%" traía a cualquiera con un "50" en el nombre, el
       teléfono o el email, y buscar "%" devolvía los 15.000+ pacientes
       recorriendo entero el índice trigram. */
    const busqueda = terminoBusqueda(query.busqueda);
    const where: Prisma.ClienteWhereInput = {
      categoria: query.categoria,
      ...(soloAgenteId ? { OR: [{ agenteId: soloAgenteId }, { agenteId: null }] } : {}),
      ...(busqueda
        ? {
            AND: {
              OR: [
                { nombre: { contains: busqueda, mode: 'insensitive' } },
                { telefono: { contains: busqueda } },
                { email: { contains: busqueda, mode: 'insensitive' } },
                { ci: { contains: busqueda, mode: 'insensitive' } },
                { pac: { contains: busqueda, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    };

    const { skip, take } = calcularPaginacion(query);

    /* Una sola ida a la base: página + total, en paralelo. */
    const [datos, total] = await this.prisma.$transaction([
      this.prisma.cliente.findMany({
        where,
        /* Por defecto lo recién tocado primero; el usuario puede cambiarlo
           por una de las columnas de ORDEN_CLIENTE. */
        orderBy: construirOrden(query.orden, query.direccion, { updatedAt: 'desc' }),
        // `select` explícito y no `include`: así el listado NUNCA arrastra
        // `datosExtra`, que son 19 claves de FileMaker por fila que nadie lee.
        // La ficha del paciente sí viaja —son escalares cortos— para que el
        // detalle abra sin pedir nada más al servidor.
        select: { ...CAMPOS_CLIENTE, intereses: { orderBy: { createdAt: 'desc' }, take: 5 } },
        skip,
        take,
      }),
      this.prisma.cliente.count({ where }),
    ]);

    const datosMapeados = datos.map(cli => {
      const agenteEfectivo = cli.agente ?? cli.conversaciones?.[0]?.agente ?? null;
      const agenteIdEfectivo = cli.agenteId ?? cli.conversaciones?.[0]?.agenteId ?? null;
      return {
        ...cli,
        agente: agenteEfectivo,
        agenteId: agenteIdEfectivo,
      };
    });

    return paginar(datosMapeados, total, query);
  }

  /**
   * @param soloAgenteId Si viene (usuario AGENTE, no ADMIN), solo puede ver
   *   clientes propios o del pool sin asignar — la misma regla de `findAll`.
   *   Sin esto, cualquier agente autenticado podía leer la ficha de CUALQUIER
   *   cliente por ID sabiendo el UUID, sin importar a quién estaba asignado.
   *   404 en vez de 403 para no confirmar que el registro existe.
   */
  async findOne(id: string, soloAgenteId?: string) {
    const cliente = await this.prisma.cliente.findUnique({
      where: { id },
      select: {
        ...CAMPOS_CLIENTE,
        // Solo la ficha lo recibe: el formulario edita `empresa`, `notas` y
        // `tags`, que viven aquí. Sin esto el formulario abriría vacío y al
        // guardar borraría esos campos. El listado sigue sin él.
        datosExtra: true,
        intereses: { orderBy: { createdAt: 'desc' } },
        leads: { orderBy: { createdAt: 'desc' } },
        ventas: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!cliente) {
      throw new NotFoundException(`Cliente ${id} no encontrado`);
    }

    const agenteEfectivo = cliente.agente ?? cliente.conversaciones?.[0]?.agente ?? null;
    const agenteIdEfectivo = cliente.agenteId ?? cliente.conversaciones?.[0]?.agenteId ?? null;

    if (soloAgenteId && agenteIdEfectivo && agenteIdEfectivo !== soloAgenteId) {
      throw new NotFoundException(`Cliente ${id} no encontrado`);
    }

    return {
      ...cliente,
      agente: agenteEfectivo,
      agenteId: agenteIdEfectivo,
    };
  }

  async findByTelefono(telefono: string) {
    return this.prisma.cliente.findUnique({ where: { telefono } });
  }

  /**
   * Get-or-create por teléfono, a prueba de concurrencia — para el webhook
   * de WhatsApp.
   *
   * A diferencia de `create()` (que lanza 409 si el teléfono ya existe, lo
   * correcto para el alta manual desde el CRM), aquí dos mensajes entrantes
   * simultáneos de un número nuevo NO deben pelearse: sin esto, el segundo
   * `create` reventaba contra el índice único de `telefono` con un 500 y Meta
   * reintentaba el webhook.
   *
   * OJO: `prisma.upsert` NO basta — internamente hace "buscar → insertar", así
   * que bajo carrera real uno de los dos inserts choca igual contra el único
   * (probado). El patrón correcto es intentar crear y, si el índice único
   * rebota (P2002), releer: para entonces la otra petición ya lo creó.
   */
  async obtenerOCrearPorTelefono(nombre: string, telefono: string) {
    const existente = await this.findByTelefono(telefono);
    if (existente) {
      return existente;
    }
    try {
      return await this.prisma.cliente.create({ data: { nombre, telefono } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const yaCreado = await this.findByTelefono(telefono);
        if (yaCreado) {
          return yaCreado; // otra petición concurrente lo creó en el ínterin
        }
      }
      throw error;
    }
  }

  /** `soloAgenteId` — ver la nota de `findOne`: mismo hueco existía en edición. */
  async update(id: string, dto: UpdateClienteDto, usuarioId?: string, soloAgenteId?: string) {
    // Valida el acceso por rol; su resultado ya no trae `datosExtra` en crudo.
    await this.findOne(id, soloAgenteId);

    // La edición fusiona sobre lo que hay, así que el JSON se relee de la base.
    // Es una lectura por clave primaria: más barata que arrastrarlo en cada
    // findOne solo para este caso.
    const guardado = await this.prisma.cliente.findUnique({
      where: { id },
      select: { datosExtra: true },
    });
    const datosExtraExistentes =
      (guardado?.datosExtra as Prisma.JsonObject | null) ?? {};

    const { empresa, fechaNacimiento, lugarNacimiento, datosExtra, ...restoDto } = dto;

    /* `empresa`, `lugarNacimiento` y `fechaNacimiento` tienen columna propia y
       van ahí, no al JSON: escribir en los dos sitios es lo que hacía que la
       ficha (que lee la columna) ignorara lo editado. El JSON queda solo para
       lo que no tiene columna — notas, etiquetas y el residuo de FileMaker. */
    const nuevosDatosExtra = {
      ...datosExtraExistentes,
      ...(datosExtra || {}),
    };

    const [actualizado] = await this.prisma.$transaction([
      this.prisma.cliente.update({
        where: { id },
        data: {
          ...restoDto,
          // A sus columnas, no al JSON: es lo que hace que el cambio se vea.
          ...(fechaNacimiento !== undefined
            ? { fechaNacimiento: fechaNacimiento ? new Date(fechaNacimiento) : null }
            : {}),
          ...(empresa !== undefined ? { empresaTrabajo: empresa || null } : {}),
          ...(lugarNacimiento !== undefined ? { ciLugar: lugarNacimiento || null } : {}),
          datosExtra: nuevosDatosExtra as Prisma.InputJsonValue,
        },
      }),
      ...(dto.agenteId !== undefined
        ? [
            this.prisma.lead.updateMany({
              where: { clienteId: id },
              data: { agenteId: dto.agenteId },
            }),
            this.prisma.conversacion.updateMany({
              where: { clienteId: id },
              data: { agenteId: dto.agenteId },
            }),
          ]
        : []),
    ]);

    await this.audit.registrar('Cliente', id, 'ACTUALIZADO', usuarioId, { ...dto });
    return actualizado;
  }

  /**
   * Reclama al paciente y a sus leads ABIERTOS para un agente, pero **solo si
   * no tienen dueña**.
   *
   * Existe porque contestar un chat del pool y reasignar a mano son dos cosas
   * distintas y no pueden compartir código:
   *
   * - `update({ agenteId })` es una reasignación explícita de un admin y pisa
   *   lo que haya, que es justo lo que se le pide.
   * - Esto lo dispara `enviarMensaje` sola, sin que nadie lo decida. Si pisara
   *   al dueño anterior, que una compañera conteste una vez le quitaría la
   *   paciente a la suya —y con ella el seguimiento y la comisión—. De ahí que
   *   cada `where` lleve `agenteId: null`: reparte lo que no es de nadie y no
   *   toca lo demás.
   *
   * Los leads se filtran por estado a propósito. Sin ese filtro, responderle
   * hoy a una paciente le pondría dueña a un lead que se cerró como PERDIDO
   * hace ocho meses, reescribiendo el histórico por el que se miden las
   * agentes.
   *
   * Devuelve si cambió algo, para no auditar los envíos que no reclaman nada
   * —que son casi todos, porque a la segunda respuesta ya tiene dueña—.
   */
  async reclamarSiNoTieneDuena(
    clienteId: string,
    agenteId: string,
    usuarioId?: string,
  ): Promise<boolean> {
    const [cliente, leads] = await this.prisma.$transaction([
      this.prisma.cliente.updateMany({
        where: { id: clienteId, agenteId: null },
        data: { agenteId },
      }),
      this.prisma.lead.updateMany({
        where: {
          clienteId,
          agenteId: null,
          estado: { in: [EstadoLead.NUEVO, EstadoLead.CONTACTADO] },
        },
        data: { agenteId },
      }),
    ]);

    if (cliente.count === 0 && leads.count === 0) return false;

    /* Cambia quién cobra la comisión de esta paciente, así que queda constancia
       igual que en una reasignación hecha a mano. */
    await this.audit.registrar('Cliente', clienteId, 'AGENTE_RECLAMADO', usuarioId, {
      agenteId,
      clienteReclamado: cliente.count > 0,
      leadsReclamados: leads.count,
    });
    return true;
  }

  /** RF-23 — registra una consulta que no derivó en venta, sin exponer la tabla a otros módulos. */
  async registrarInteres(clienteId: string, dto: CreateInteresDto) {
    await this.findOne(clienteId);
    return this.prisma.interes.create({
      data: { ...dto, clienteId },
    });
  }

  /**
   * RF-21 — recalcula la categoría del cliente según su historial de ventas ganadas.
   * Regla por defecto (ajustable por un admin a futuro, RF-22):
   *   GOLD   ≥ 3 ventas ganadas o monto acumulado ≥ 10 000 Bs en los últimos 90 días
   *   SILVER 1-2 ventas ganadas
   *   BRONZE cliente con ventas pero fuera de la ventana de 90 días
   *   PROSPECTO sin ventas ganadas
   */
  async actualizarCategoria(clienteId: string): Promise<CategoriaCliente> {
    const hace90Dias = new Date();
    hace90Dias.setDate(hace90Dias.getDate() - 90);

    /* Se agrega en SQL en vez de traer todas las ventas del cliente a memoria
       para filtrarlas y sumarlas en JS: la base solo devuelve 3 números. */
    const [recientes, historicas] = await this.prisma.$transaction([
      this.prisma.venta.aggregate({
        where: { clienteId, estado: 'GANADA', createdAt: { gte: hace90Dias } },
        _count: true,
        _sum: { monto: true },
      }),
      this.prisma.venta.count({ where: { clienteId, estado: 'GANADA' } }),
    ]);

    const cantidadReciente = recientes._count;
    const montoReciente = Number(recientes._sum.monto ?? 0);

    let categoria: CategoriaCliente = 'PROSPECTO';
    if (cantidadReciente >= 3 || montoReciente >= 10_000) {
      categoria = 'GOLD';
    } else if (cantidadReciente >= 1) {
      categoria = 'SILVER';
    } else if (historicas >= 1) {
      categoria = 'BRONZE';
    }

    await this.prisma.cliente.update({ where: { id: clienteId }, data: { categoria } });
    return categoria;
  }

  /**
   * Historial clínico-comercial del paciente: los servicios que se le hicieron,
   * tomados de las planillas de comisiones ya importadas.
   *
   * Cruza por `pac`, el identificador de FileMaker que ambos lados comparten.
   * Es un join indexado sobre una columna única, no un escaneo sobre JSON.
   * Un cliente sin `pac` (alta manual, lead de redes) simplemente no tiene
   * historial todavía — no es un error.
   */
  async historialServicios(id: string, soloAgenteId?: string) {
    const cliente = await this.findOne(id, soloAgenteId);
    if (!cliente.pac) {
      return { pac: null, totalServicios: 0, montoTotal: 0, servicios: [] };
    }

    /* La query vive en ServiciosService y solo ahí: es su dominio, y tenerla
       duplicada acá significaba que un cambio de columnas había que acertarlo
       en dos sitios. */
    const servicios = await this.serviciosService.historialPorPac(cliente.pac);

    return {
      pac: cliente.pac,
      totalServicios: servicios.length,
      montoTotal: servicios.reduce((suma, s) => suma + Number(s.precio), 0),
      servicios,
    };
  }
}
