import { BadRequestException, ConflictException, ForbiddenException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { CategoriaCliente, EstadoLead, Prisma } from '../../prisma/prisma-client';
import { campoDeIndice, candidatosDeChoqueUnico, tablaDelChoque } from '../../prisma/choque-unico';

import { AuditService } from '../../common/audit/audit.service';
import { terminoBusqueda } from '../../common/dto/busqueda';
import { normalizarTelefono } from '../../common/telefono/telefono';
import { calcularPaginacion, construirOrden, paginar } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { ServiciosService } from '../servicios/servicios.service';
import { CategoriaPacienteService } from './categoria-paciente.service';
import { CreateClienteDto } from './dto/create-cliente.dto';
import { CreateInteresDto } from './dto/create-interes.dto';
import { QueryClienteDto } from './dto/query-cliente.dto';
import { UpdateClienteDto } from './dto/update-cliente.dto';

/**
 * Prefijo del nombre con el que se da de alta a quien escribe por WhatsApp sin
 * que Meta mande su nombre de perfil.
 *
 * Vive aquí, y no en `IngestaWhatsappService`, porque el nombre de un `Cliente`
 * es de este módulo: el otro lo construía con una plantilla propia y este
 * comprobaba el resultado con `startsWith('WhatsApp +')` — dos literales en dos
 * archivos que tenían que coincidir sin que nada lo verificara. El día que la
 * normalización de teléfonos deje de anteponer el `+`, el alta seguiría
 * funcionando y el ascenso del nombre provisional al real dejaría de ocurrir,
 * en silencio y para siempre.
 */
const PREFIJO_NOMBRE_PROVISIONAL = 'WhatsApp ';

/** Nombre de relleno mientras no se sepa cómo se llama de verdad. */
/** Ver `normalizarTelefono`: la ficha se guarda con la misma clave que usa el webhook. */
function telefonoCanonico(telefono: string): string {
  const canonico = normalizarTelefono(telefono);
  if (!canonico) throw new BadRequestException(`«${telefono}» no es un número de teléfono válido.`);
  return canonico;
}

export function nombreProvisional(telefono: string): string {
  return `${PREFIJO_NOMBRE_PROVISIONAL}${telefono}`;
}

/** ¿Este nombre es el marcador de arriba y no el de una persona? */
export function esNombreProvisional(nombre: string): boolean {
  return nombre.startsWith(PREFIJO_NOMBRE_PROVISIONAL);
}

/**
 * Quién pregunta, a efectos de lo que se le puede revelar de OTRA ficha.
 *
 * El 409 de un dato repetido nombra a quien lo tiene —«ese número ya es de Ana
 * Pérez»—, y eso es revelar una ficha. Se revela con la MISMA regla con que se
 * ve: alcance global, todas; una agente, solo las de su cartera; quien no entra
 * en Clientes (la asistente desde Resultados), ninguna. Sin esto, una agente
 * de ventas que tecleaba un número se enteraba del nombre de una paciente de
 * otra agente.
 */
export type VisorFichas =
  | { readonly alcance: 'global' }
  | { readonly alcance: 'cartera'; readonly agenteId: string }
  | { readonly alcance: 'ninguno' };

/**
 * La ficha que ya usa un teléfono, vista contra el paciente de un informe.
 *
 * Existe porque el teléfono es único en el CRM y el informe se reconoce por PAC
 * o CI: una paciente que escribió por WhatsApp ANTES de ir a la clínica tiene
 * ficha sin PAC, su informe llega con PAC y queda «sin vincular», y crearle
 * ficha rebota contra su propio número. Lo correcto es vincular, no duplicar.
 *
 * - `LIBRE`: nadie tiene ese número.
 * - `VINCULABLE`: la ficha no tiene PAC y nada la contradice (sin CI, o el
 *   mismo CI). Puede ser la paciente — lo decide una persona viendo el nombre.
 * - `OCUPADO`: tiene otro PAC u otro CI: es otra persona, casi siempre un
 *   familiar que comparte el WhatsApp. No se toca.
 *
 * Nunca se vincula solo: madre e hija con el mismo número es lo corriente, y
 * vincular por teléfono le pegaría el informe de la hija a la ficha de la madre.
 */
export type FichaDelTelefono =
  | { readonly estado: 'LIBRE' }
  | { readonly estado: 'VINCULABLE'; readonly id: string; readonly nombre: string; readonly provisional: boolean }
  | { readonly estado: 'OCUPADO' };

/** El visor que corresponde al alcance de siempre (`alcanceAgente`). */
function visorDe(soloAgenteId: string | undefined): VisorFichas {
  return soloAgenteId === undefined ? { alcance: 'global' } : { alcance: 'cartera', agenteId: soloAgenteId };
}

/**
 * Qué decirle a la agente cuando un índice único de `Cliente` rebota.
 *
 * Lleva el nombre de quien ya tiene ese valor porque sin él el mensaje es un
 * callejón sin salida: «ese número está en uso» no deja decidir nada, mientras
 * que «ese número es de María Pérez» dice al instante si es la misma persona
 * con ficha duplicada o un número tecleado mal.
 */
const MENSAJE_UNICO: Record<string, (valor: string, duenio?: string) => string> = {
  telefono: (valor, duenio) =>
    duenio ? `El teléfono ${valor} ya es de ${duenio}.` : `Ya existe un paciente con el teléfono ${valor}.`,
  pac: (valor, duenio) =>
    duenio ? `El código PAC ${valor} ya es de ${duenio}.` : `Ya existe un paciente con el código PAC ${valor}.`,
};

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
const CATEGORIAS_CLIENTE = Object.values(CategoriaCliente);

/** Los números de la cabecera de Clientes, sobre todo lo que el usuario puede ver. */
export interface ResumenClientes {
  porCategoria: Record<CategoriaCliente, number>;
  sinAsignar: number;
}

const CAMPOS_CLIENTE = {
  id: true,
  nombre: true,
  telefono: true,
  email: true,
  categoria: true,
  /* Para que la ficha diga «fijada a mano» o «automática». */
  categoriaFijadaEn: true,
  agenteId: true,
  agente: { select: { id: true, nombre: true } },
  conversaciones: {
    where: { linea: { comercial: true } },
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
  /* La ficha y el chat avisan que no quiere promociones. */
  bajaPromocionesEn: true,
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
    private readonly categorias: CategoriaPacienteService,
  ) {}

  /**
   * Convierte el rebote de un índice único en el 409 que corresponde, con el
   * campo que chocó de verdad.
   *
   * **No se comprueba antes con un `findUnique`.** Ese patrón lo desmiente el
   * comentario de `obtenerOCrearPorTelefono` unas líneas más abajo, escrito
   * tras probarlo: entre el SELECT y el INSERT cabe otra petición, y bajo
   * carrera real uno de los dos choca igual — con la diferencia de que
   * entonces sale un 500 en vez de un 409, y la agente ve "error del
   * servidor" donde debería leer "ese PAC ya es de otra paciente". Además son
   * dos viajes a la base por alta que no hacen falta: el índice ya sabe la
   * respuesta.
   */
  private async traducirChoqueUnico(
    error: unknown,
    valores: Record<string, string | null | undefined>,
    visor: VisorFichas,
  ): Promise<void> {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return;

    /* El campo no sale de `meta.target`: con el driver adapter de Prisma 7 esa
       propiedad no existe y esta traducción llevaba muerta desde la migración
       —un teléfono repetido salía como error crudo—. Ver `choque-unico.ts`. */
    const tabla = tablaDelChoque(error);
    const campos = candidatosDeChoqueUnico(error).map(candidato => campoDeIndice(candidato, tabla));

    for (const campo of campos) {
      const mensaje = MENSAJE_UNICO[campo];
      if (!mensaje) continue;
      const valor = valores[campo] ?? '';
      /* Una consulta de más, y solo cuando YA se ha chocado: el camino feliz no
         paga nada. Si falla, el mensaje sigue sirviendo sin el nombre. */
      const duenio = valor ? await this.duenioDe(campo, valor, visor).catch(() => undefined) : undefined;
      /* `campo` va en el cuerpo para que la interfaz marque el control que hay
         que corregir. Sin él tendría que deducirlo del texto del mensaje, y un
         choque de PAC acabaría señalando la casilla del teléfono. */
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        message: mensaje(valor, duenio),
        campo,
      });
    }
  }

  /**
   * Quién tiene ya ese valor único, para nombrarlo en el conflicto — solo si
   * quien pregunta podría ver esa ficha. Ver `VisorFichas`.
   */
  private async duenioDe(campo: string, valor: string, visor: VisorFichas): Promise<string | undefined> {
    if (visor.alcance === 'ninguno' || (campo !== 'telefono' && campo !== 'pac')) return undefined;
    const ficha = await this.prisma.cliente.findUnique({
      where: campo === 'telefono' ? { telefono: valor } : { pac: valor },
      select: { nombre: true, agenteId: true },
    });
    if (!ficha || (visor.alcance === 'cartera' && ficha.agenteId !== visor.agenteId)) return undefined;
    /* El marcador «WhatsApp +591…» no es un nombre: decirlo no ayuda a nadie. */
    return esNombreProvisional(ficha.nombre) ? undefined : ficha.nombre;
  }

  async create(dto: CreateClienteDto, soloAgenteId?: string) {
    return this.crear(dto, soloAgenteId, visorDe(soloAgenteId));
  }

  /**
   * Alta de la ficha de un paciente que el portal de Resultados conoce y el CRM
   * no, por encargo de la asistente que va a avisarle.
   *
   * Método propio y estrecho, y no `create`, a propósito: la asistente no entra
   * en Clientes, así que solo puede dar el teléfono —nombre, PAC y CI los pone
   * quien llama, sacados del informe— y la ficha nace sin agente comercial. Un
   * dato repetido no nombra a nadie: ella no ve esas fichas.
   */
  async altaDesdeResultados(paciente: { nombre: string; pac: string | null; ci: string | null }, telefono: string) {
    return this.crear(
      { nombre: paciente.nombre, telefono, pac: paciente.pac ?? undefined, ci: paciente.ci ?? undefined },
      undefined,
      { alcance: 'ninguno' },
    );
  }

  /**
   * Corrige el teléfono de la ficha a la que va un aviso de Resultados. Solo el
   * teléfono; queda en la auditoría como cualquier edición. La autorización es
   * de quien llama (el informe es de esa ficha); aquí se decide qué se revela.
   */
  /** Qué es, frente a este paciente, la ficha que ya usa este teléfono. Ver `FichaDelTelefono`. */
  async fichaDelTelefono(telefono: string, paciente: { pac: string | null; ci: string | null }): Promise<FichaDelTelefono> {
    const ficha = await this.prisma.cliente.findUnique({
      where: { telefono: telefonoCanonico(telefono) },
      select: { id: true, nombre: true, pac: true, ci: true },
    });
    if (!ficha) return { estado: 'LIBRE' };
    return esVinculable(ficha, paciente)
      ? { estado: 'VINCULABLE', id: ficha.id, nombre: ficha.nombre, provisional: esNombreProvisional(ficha.nombre) }
      : { estado: 'OCUPADO' };
  }

  /**
   * Le pone a una ficha existente el PAC (y el CI, si no tenía) del paciente de
   * un informe, después de que la asistente confirmó que es la misma persona.
   *
   * Se revalida aquí: entre la pregunta y el «sí» alguien pudo ponerle otro PAC.
   * El nombre solo se reemplaza si era el provisional «WhatsApp +591…»; uno
   * escrito por una agente se respeta. Si el PAC ya es de OTRA ficha, el índice
   * rebota y sale el 409 de siempre, sin nombrar a nadie.
   */
  async vincularDesdeResultados(
    clienteId: string,
    paciente: { nombre: string; pac: string | null; ci: string | null },
    usuarioId: string,
  ) {
    const ficha = await this.prisma.cliente.findUnique({
      where: { id: clienteId },
      select: { nombre: true, pac: true, ci: true },
    });
    if (!ficha || !esVinculable(ficha, paciente)) {
      throw new ConflictException('Esa ficha cambió y ya no se puede vincular. Recarga la cola.');
    }
    return this.actualizar(
      clienteId,
      {
        ...(paciente.pac ? { pac: paciente.pac } : {}),
        ...(paciente.ci && !ficha.ci ? { ci: paciente.ci } : {}),
        ...(esNombreProvisional(ficha.nombre) ? { nombre: paciente.nombre } : {}),
      },
      usuarioId,
      undefined,
      { alcance: 'ninguno' },
    );
  }

  /**
   * La paciente pidió no recibir más promociones (tocó «No me interesa»).
   * Devuelve `true` solo la primera vez: tocarlo de nuevo no cambia la fecha ni
   * vuelve a confirmar. Condicionado en el UPDATE, no leído antes: dos webhooks
   * del mismo toque no la registran dos veces.
   */
  async registrarBajaPromociones(clienteId: string): Promise<boolean> {
    const { count } = await this.prisma.cliente.updateMany({
      where: { id: clienteId, bajaPromocionesEn: null },
      data: { bajaPromocionesEn: new Date() },
    });
    if (count) await this.audit.registrar('Cliente', clienteId, 'BAJA_PROMOCIONES');
    return count > 0;
  }

  /**
   * La paciente paró o reanudó las promociones desde los ajustes de WhatsApp
   * (webhook `user_preferences`), o Meta rechazó una plantilla con 131050
   * porque ya las había parado. Es la misma decisión que el botón «No me
   * interesa», dicha en otro sitio: sin confirmación, porque ella no escribió
   * en el chat.
   *
   * Reanudar sí borra la baja, aunque la hubiera dado con el botón: es un gesto
   * explícito, posterior y de ella, sobre promociones de este negocio.
   * Condicionado en el UPDATE, como la baja: un webhook repetido no deja
   * dos entradas en la auditoría.
   *
   * Un teléfono sin ficha no crea una: si nunca fue paciente no hay nada que
   * registrar, y la baja de Meta sigue vigente en su lado igual.
   */
  async preferenciaPromocionesDesdeWhatsapp(telefono: string, recibe: boolean): Promise<boolean> {
    const cliente = await this.findByTelefono(telefono);
    if (!cliente) return false;
    if (!recibe) return this.registrarBajaPromociones(cliente.id);
    const { count } = await this.prisma.cliente.updateMany({
      where: { id: cliente.id, bajaPromocionesEn: { not: null } },
      data: { bajaPromocionesEn: null },
    });
    if (count) await this.audit.registrar('Cliente', cliente.id, 'ALTA_PROMOCIONES');
    return count > 0;
  }

  /** Desde cuándo no quiere promociones, o null si las acepta. */
  async bajaDePromociones(clienteId: string): Promise<Date | null> {
    const cliente = await this.prisma.cliente.findUnique({ where: { id: clienteId }, select: { bajaPromocionesEn: true } });
    return cliente?.bajaPromocionesEn ?? null;
  }

  async telefonoDesdeResultados(clienteId: string, telefono: string, usuarioId: string) {
    return this.actualizar(clienteId, { telefono }, usuarioId, undefined, { alcance: 'ninguno' });
  }

  private async crear(dto: CreateClienteDto, soloAgenteId: string | undefined, visor: VisorFichas) {
    if (soloAgenteId && dto.agenteId != null && dto.agenteId !== soloAgenteId) {
      throw new ForbiddenException('Solo un administrador puede asignar pacientes a otro agente');
    }
    if (dto.agenteId != null) await this.validarAgenteActivo(dto.agenteId);

    // `fechaNacimiento` NO entra en datosExtra: es columna propia. Meterla en
    // el JSON era lo que hacía que editarla no cambiara nada en pantalla.
    dto = { ...dto, telefono: telefonoCanonico(dto.telefono) };
    const { empresa, fechaNacimiento, lugarNacimiento, datosExtra, pac, ci, ...restoDto } = dto;
    const datosExtraCombinados = {
      ...(datosExtra || {}),
    };

    const pacNormalizado = pac ? pac.trim().toUpperCase() : null;

    try {
      const creado = await this.prisma.cliente.create({
        data: {
          ...restoDto,
          pac: pacNormalizado,
          ci: ci ? ci.trim() : null,
          ...(fechaNacimiento !== undefined ? { fechaNacimiento: new Date(fechaNacimiento) } : {}),
          ...(empresa !== undefined ? { empresaTrabajo: empresa || null } : {}),
          ...(lugarNacimiento !== undefined ? { ciLugar: lugarNacimiento || null } : {}),
          datosExtra: Object.keys(datosExtraCombinados).length > 0 ? (datosExtraCombinados as Prisma.InputJsonValue) : undefined,
        },
      });
      /* Con PAC trae su historial de FileMaker: puede nacer ya Gold. */
      if (pacNormalizado) creado.categoria = await this.actualizarCategoria(creado.id);
      return creado;
    } catch (error: unknown) {
      await this.traducirChoqueUnico(error, { telefono: dto.telefono, pac: pacNormalizado }, visor);
      throw error;
    }
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
    const alcance: Prisma.ClienteWhereInput = soloAgenteId ? { OR: [{ agenteId: soloAgenteId }, { agenteId: null }] } : {};
    const where: Prisma.ClienteWhereInput = {
      categoria: query.categoria,
      ...alcance,
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

    /* Una sola ida a la base: página, total y los números de la cabecera. */
    const [datos, total, sinAsignar, ...porCategoria] = await this.prisma.$transaction([
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
      /* Los números de la cabecera, sobre TODO lo que el usuario puede ver: ni
         el chip de categoría ni el buscador los mueven (crm-design-system,
         «Filtros»). Se contaban en el navegador sobre las 25 filas de la
         página, así que «Pacientes Gold» decía cuántas había en esa página. */
      /* «Sin asignar» como lo pinta la tabla: sin dueña en la ficha ni agente en
         su chat comercial (`agenteEfectivo`, más abajo). */
      this.prisma.cliente.count({
        where: { AND: [alcance, { agenteId: null, conversaciones: { none: { linea: { comercial: true }, agenteId: { not: null } } } }] },
      }),
      /* Un `count` por categoría y no un `groupBy`: cuatro, por el índice de
         `categoria`, y con tipos que no se pierden dentro de `$transaction`. */
      ...CATEGORIAS_CLIENTE.map(categoria => this.prisma.cliente.count({ where: { AND: [alcance, { categoria }] } })),
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

    const resumen: ResumenClientes = {
      porCategoria: { GOLD: 0, SILVER: 0, BRONZE: 0, PROSPECTO: 0 },
      sinAsignar,
    };
    CATEGORIAS_CLIENTE.forEach((categoria, i) => (resumen.porCategoria[categoria] = porCategoria[i]));

    return { ...paginar(datosMapeados, total, query), resumen };
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
    const canonico = normalizarTelefono(telefono);
    return canonico ? this.prisma.cliente.findUnique({ where: { telefono: canonico } }) : null;
  }

  /**
   * Reconoce a pacientes de OTRO sistema —el portal de resultados— entre las
   * fichas del CRM, en lote (una página de la cola, no una consulta por fila).
   *
   * 1. **PAC**, que es único aquí por índice y se guarda ya canónico.
   * 2. Si no hay PAC o no cruza, **CI**, solo cuando en forma canónica
   *    coincide con exactamente UNA ficha. Medido en producción el
   *    2026-09-22: 14.077 fichas con CI y 18 CI repetidos. Un CI repetido no
   *    se resuelve eligiendo uno: se devuelve `CI_REPETIDO` y la asistente lo
   *    ve, porque avisar a la persona equivocada revela que otra tiene un
   *    resultado.
   *
   * Canónico = mayúsculas y sin separadores: el CRM tiene 481 CI con guiones
   * o espacios y 45 en minúsculas, y en el otro sistema se teclean a mano.
   * La comparación del CI recorre la tabla (no hay índice sobre la
   * expresión); son ~16.000 filas y una consulta por página.
   *
   * Sin escopado por agente a propósito: identifica a una persona por una
   * clave exacta, no lista cartera. Quien llame decide qué hace con ella.
   */
  async reconocerPacientes(identificadores: ReadonlyArray<{ pac: string | null; ci: string | null }>): Promise<ReconocimientoPaciente[]> {
    const pacs = [...new Set(identificadores.map(i => canonico(i.pac)).filter((c): c is string => !!c))];
    const cis = [...new Set(identificadores.map(i => canonico(i.ci)).filter((c): c is string => !!c))];
    const [porPac, porCi] = await Promise.all([
      /* Canónico en los DOS lados, igual que el CI: la ficha guarda el PAC tal
         como se tecleó (mayúsculas, pero con sus guiones), y comparar la forma
         sin separadores contra la columna cruda hacía que «PRUEBA-7761» del
         portal no encontrara nunca a «PRUEBA-7761» del CRM. */
      pacs.length
        ? this.prisma.$queryRaw<Array<{ clave: string; id: string; nombre: string; telefono: string }>>`
            SELECT upper(regexp_replace(pac, '[^A-Za-z0-9]', '', 'g')) AS clave, id, nombre, telefono
              FROM "Cliente"
             WHERE upper(regexp_replace(pac, '[^A-Za-z0-9]', '', 'g')) = ANY(${pacs}::text[])`
        : Promise.resolve([]),
      cis.length
        ? this.prisma.$queryRaw<Array<{ clave: string; id: string; nombre: string; telefono: string }>>`
            SELECT upper(regexp_replace(ci, '[^A-Za-z0-9]', '', 'g')) AS clave, id, nombre, telefono
              FROM "Cliente"
             WHERE upper(regexp_replace(ci, '[^A-Za-z0-9]', '', 'g')) = ANY(${cis}::text[])`
        : Promise.resolve([]),
    ]);
    const fichasPorPac = new Map<string, Array<{ id: string; nombre: string; telefono: string }>>();
    for (const { clave, ...ficha } of porPac) fichasPorPac.set(clave, [...(fichasPorPac.get(clave) ?? []), ficha]);
    const fichasPorCi = new Map<string, Array<{ id: string; nombre: string; telefono: string }>>();
    for (const { clave, ...ficha } of porCi) fichasPorCi.set(clave, [...(fichasPorCi.get(clave) ?? []), ficha]);

    return identificadores.map(({ pac, ci }): ReconocimientoPaciente => {
      /* Dos fichas que solo difieren en un guion («P-1» y «P1») no se
         resuelven eligiendo una: se sigue al CI, y si tampoco, no se avisa. */
      const conPac = fichasPorPac.get(canonico(pac) ?? '') ?? [];
      if (conPac.length === 1) return { cliente: conPac[0], via: 'PAC', motivo: null };
      const conCi = fichasPorCi.get(canonico(ci) ?? '') ?? [];
      if (conCi.length === 1) return { cliente: conCi[0], via: 'CI', motivo: null };
      return { cliente: null, via: null, motivo: conCi.length > 1 ? 'CI_REPETIDO' : 'SIN_COINCIDENCIA' };
    });
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
    telefono = telefonoCanonico(telefono);
    const existente = await this.findByTelefono(telefono);
    if (existente) {
      /* Si el cliente se dio de alta con el marcador ("WhatsApp +591…") y ahora
         Meta nos entrega el nombre de perfil real, lo ascendemos. Nunca pisa un
         nombre legítimo, como los importados de FileMaker. */
      if (nombre && !esNombreProvisional(nombre) && esNombreProvisional(existente.nombre)) {
        return this.prisma.cliente.update({
          where: { id: existente.id },
          data: { nombre },
        });
      }
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

  /** Serializa el alta comercial recuperada con las reasignaciones del paciente (F04). */
  async agenteParaAltaInicial(tx: Prisma.TransactionClient, clienteId: string): Promise<string | null> {
    const filas = await tx.$queryRaw<Array<{ agenteId: string | null }>>`
      SELECT "agenteId" FROM "Cliente" WHERE "id" = ${clienteId} FOR UPDATE
    `;
    if (!filas.length) throw new NotFoundException('Cliente no encontrado');
    return filas[0].agenteId;
  }

  /** `soloAgenteId` — ver la nota de `findOne`: mismo hueco existía en edición. */
  async update(id: string, dto: UpdateClienteDto, usuarioId?: string, soloAgenteId?: string) {
    return this.actualizar(id, dto, usuarioId, soloAgenteId, visorDe(soloAgenteId));
  }

  private async actualizar(
    id: string,
    dto: UpdateClienteDto,
    usuarioId: string | undefined,
    soloAgenteId: string | undefined,
    visor: VisorFichas,
  ) {
    const cliente = await this.findOne(id, soloAgenteId);
    if (soloAgenteId && dto.agenteId !== undefined) {
      if (dto.agenteId !== cliente.agenteId) {
        throw new ForbiddenException('Solo un administrador puede reasignar pacientes');
      }
      // El formulario reenvía el agente efectivo incluso al editar solo la ficha.
      // Para AGENTE ese valor repetido no autoriza escribir propiedad ni cascadas.
      dto = { ...dto, agenteId: undefined };
    }
    if (dto.agenteId != null) await this.validarAgenteActivo(dto.agenteId);
    if (dto.telefono !== undefined) dto = { ...dto, telefono: telefonoCanonico(dto.telefono) };

    // La edición fusiona sobre lo que hay, así que el JSON se relee de la base.
    // Es una lectura por clave primaria: más barata que arrastrarlo en cada
    // findOne solo para este caso.
    const guardado = await this.prisma.cliente.findUnique({
      where: { id },
      select: { datosExtra: true },
    });
    const datosExtraExistentes =
      (guardado?.datosExtra as Prisma.JsonObject | null) ?? {};

    const { empresa, fechaNacimiento, lugarNacimiento, datosExtra, pac, ci, recibePromociones, ...restoDto } = dto;

    /* `pac` y `ci` solo se tocan si venían en el cuerpo: `undefined` significa
       "no lo mandaron", que no es lo mismo que `null` ("bórralo"). La colisión
       de `pac` la resuelve el índice único al escribir, no un SELECT previo —
       ver `traducirChoqueUnico`. */
    const pacData = pac !== undefined ? { pac: pac ? pac.trim().toUpperCase() : null } : {};
    const ciData = ci !== undefined ? { ci: ci ? ci.trim() : null } : {};

    /* `empresa`, `lugarNacimiento` y `fechaNacimiento` tienen columna propia y
       van ahí, no al JSON: escribir en los dos sitios es lo que hacía que la
       ficha (que lee la columna) ignorara lo editado. El JSON queda solo para
       lo que no tiene columna — notas, etiquetas y el residuo de FileMaker. */
    const nuevosDatosExtra = {
      ...datosExtraExistentes,
      ...(datosExtra || {}),
    };

    const actualizado = await this.ejecutarActualizacion(
      this.prisma.cliente.update({
        where: { id },
        data: {
          ...restoDto,
          ...pacData,
          ...ciData,
          // A sus columnas, no al JSON: es lo que hace que el cambio se vea.
          ...(fechaNacimiento !== undefined
            ? { fechaNacimiento: fechaNacimiento ? new Date(fechaNacimiento) : null }
            : {}),
          ...(empresa !== undefined ? { empresaTrabajo: empresa || null } : {}),
          ...(lugarNacimiento !== undefined ? { ciLugar: lugarNacimiento || null } : {}),
          /* Darla de baja otra vez no mueve la fecha: es la de cuándo lo pidió. */
          ...(recibePromociones !== undefined
            ? { bajaPromocionesEn: recibePromociones ? null : (cliente.bajaPromocionesEn ?? new Date()) }
            : {}),
          datosExtra: nuevosDatosExtra as Prisma.InputJsonValue,
        },
      }),
      [...(dto.agenteId !== undefined
        ? [
            this.prisma.lead.updateMany({
              where: { clienteId: id },
              data: { agenteId: dto.agenteId },
            }),
            this.prisma.conversacion.updateMany({
              where: { clienteId: id, linea: { comercial: true } },
              data: { agenteId: dto.agenteId },
            }),
          ]
        : [])],
    /* El teléfono va aquí igual que el PAC: sin él, el 409 de un número
       repetido salía sin número y sin dueño («Ya existe un paciente con el
       teléfono .»), que no le sirve a nadie para corregirlo. */
    { pac: pacData.pac, telefono: restoDto.telefono },
    visor);

    await this.audit.registrar('Cliente', id, 'ACTUALIZADO', usuarioId, { ...dto });
    /* El PAC la une a su historial de FileMaker (también al vincularla desde
       Resultados): su valor cambió, y su categoría con él. */
    if (pacData.pac !== undefined && pacData.pac !== cliente.pac) {
      actualizado.categoria = await this.actualizarCategoria(id);
    }
    return actualizado;
  }

  /**
   * `$transaction` de la edición, con el rebote del índice único traducido a
   * 409 igual que en el alta. Aparte para que el `try` no envuelva las 30
   * líneas de armado del `data`, donde nada puede lanzar un P2002.
   */
  private async ejecutarActualizacion<T>(
    principal: Prisma.PrismaPromise<T>,
    extras: Prisma.PrismaPromise<unknown>[],
    valores: Record<string, string | null | undefined>,
    visor: VisorFichas,
  ): Promise<T> {
    try {
      /* La principal va aparte para no perder su tipo: una lista mezclada sale
         de `$transaction` como `unknown[]`, y con eso `update` devolvía
         `unknown` a quien lo llamara. Va primera, así que es la posición 0. */
      const [resultado] = await this.prisma.$transaction([principal, ...extras]);
      return resultado as T;
    } catch (error: unknown) {
      await this.traducirChoqueUnico(error, valores, visor);
      throw error;
    }
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
  async registrarInteres(clienteId: string, dto: CreateInteresDto, soloAgenteId?: string) {
    await this.findOne(clienteId, soloAgenteId);
    if (soloAgenteId && dto.agenteId != null && dto.agenteId !== soloAgenteId) {
      throw new ForbiddenException('Solo un administrador puede registrar un interés a nombre de otro agente');
    }
    if (dto.agenteId != null) await this.validarAgenteActivo(dto.agenteId);
    return this.prisma.interes.create({
      data: { ...dto, clienteId },
    });
  }

  private async validarAgenteActivo(agenteId: string): Promise<void> {
    const agente = await this.prisma.usuario.findFirst({
      where: { id: agenteId, activo: true },
      select: { id: true },
    });
    if (!agente) throw new NotFoundException(`Agente ${agenteId} no encontrado o inactivo`);
  }

  /**
   * Recalcula la categoría de una paciente con su valor real —FileMaker más el
   * CRM, ver `categoria-paciente.ts`— y la devuelve. Si está fijada a mano,
   * no la toca y devuelve la fijada.
   *
   * `tx`: Ventas la llama dentro de la transacción que guarda la venta, para
   * que la venta y su categoría se confirmen juntas o no se confirme ninguna.
   */
  async actualizarCategoria(
    clienteId: string,
    soloAgenteId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<CategoriaCliente> {
    if (soloAgenteId) await this.findOne(clienteId, soloAgenteId);
    const db = tx ?? this.prisma;
    await this.categorias.recalcular(clienteId, db);
    const { categoria } = await db.cliente.findUniqueOrThrow({ where: { id: clienteId }, select: { categoria: true } });
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
    /* Las cifras se piden aparte de la lista, y no se derivan de ella: la lista
       lleva tope y contarla decía «200 servicios» a quien tenía más, con un
       monto igual de corto. Un paciente real llegó a 31 servicios en un mes, así
       que 200 se cruza en unos siete meses de historial. */
    const [servicios, resumen] = await Promise.all([
      this.serviciosService.historialPorPac(cliente.pac),
      this.serviciosService.resumenHistorialPorPac(cliente.pac),
    ]);

    return {
      pac: cliente.pac,
      totalServicios: resumen.servicios,
      montoTotal: resumen.gastado,
      servicios,
    };
  }
}

/** Cómo se reconoció a un paciente de otro sistema, o por qué no. */
export interface ReconocimientoPaciente {
  cliente: { id: string; nombre: string; telefono: string } | null;
  via: 'PAC' | 'CI' | null;
  motivo: 'SIN_COINCIDENCIA' | 'CI_REPETIDO' | null;
}

/** Mayúsculas y sin separadores: `pac-33009`, `PAC 33009` y `PAC33009` son la misma clave. */
/**
 * ¿Puede ser esta ficha el paciente del informe? Sin PAC propio, y sin un CI
 * que diga lo contrario. Comparado en forma canónica, como el reconocimiento.
 */
function esVinculable(ficha: { pac: string | null; ci: string | null }, paciente: { ci: string | null }): boolean {
  if (ficha.pac) return false;
  return !ficha.ci || !paciente.ci || canonico(ficha.ci) === canonico(paciente.ci);
}

function canonico(valor: string | null): string | null {
  return valor?.toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
}
