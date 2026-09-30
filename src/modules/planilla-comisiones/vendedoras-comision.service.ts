import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AreaVendedora, Prisma, TipoVendedora, VendedoraComision } from '../../prisma/prisma-client';

import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ActualizarVendedoraDto, CrearVendedoraDto } from './dto/configuracion.dto';
import { ResumenAnualService } from './resumen-anual.service';

/**
 * El directorio de vendedoras de la planilla: listarlas con su usuario del
 * CRM, dar de alta a quien cobra sin vender (marketing) y editar tipo, área,
 * sueldo, `activa` y `oculta`.
 *
 * Vivía en `PlanillaComisionesService`, que además importa, clasifica,
 * ajusta y lleva el ciclo de vida del periodo. No toca ningún periodo: por
 * eso solo invalida la vista anual y nunca la analítica (ver
 * `invalidarCachesDelPeriodo`).
 *
 * El alta automática al importar (`sincronizarVendedoras`) se queda en la
 * importación: ocurre dentro de su transacción.
 */
@Injectable()
export class VendedorasComisionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly resumenAnual: ResumenAnualService,
  ) {}

  /**
   * Vendedoras con el agente del CRM que les corresponde.
   *
   * El cruce es por `codigo` (el `vendedora_pk` del Excel es el mismo
   * identificador que lleva el agente), así que no hay ningún enlace que
   * mantener ni vincular a mano: si el agente tiene su código puesto, aparece.
   */
  async listarVendedoras() {
    /* Las ocultas van al final —no se esconden de ESTE endpoint— porque el
       directorio de configuración es el único sitio desde donde se las puede
       volver a mostrar: filtrarlas aquí las dejaría enterradas para siempre.
       Quien decide no pintarlas es la pantalla, y con un contador a la vista. */
    const vendedoras = await this.prisma.vendedoraComision.findMany({
      orderBy: [{ oculta: 'asc' }, { configurada: 'asc' }, { nombre: 'asc' }],
    });

    /* `foto` viaja porque la ficha de desempeño pone la cara de la ejecutiva en
       su avatar, y este endpoint es el único que ya cruza vendedora con usuario
       —`Usuario.codigo` ES el `vendedora_pk` del Excel—. Además está cacheado 60 s
       en el frontend, así que las fotos se piden una vez por sesión y no en cada
       cambio de periodo. Medido en producción: 3 fotos de ~10 KB, 30 KB en total. */
    const agentes = await this.prisma.usuario.findMany({
      where: { codigo: { in: vendedoras.map(v => v.codigo) } },
      select: { id: true, nombre: true, email: true, codigo: true, activo: true, foto: true },
    });
    const porCodigo = new Map(agentes.map(a => [a.codigo, a]));

    return vendedoras.map(v => ({ ...v, agente: porCodigo.get(v.codigo) ?? null }));
  }

  /**
   * Da de alta a alguien que cobra por planilla pero no vende.
   *
   * Nace `configurada: true` porque el alta manual ES el acto de configurarla:
   * quien la crea está eligiendo su tipo, su área y su sueldo en ese momento.
   * El `configurada: false` existe para las que se autocrean al importar, que
   * son las que nadie ha mirado todavía.
   */
  async crearVendedora(datos: CrearVendedoraDto, usuarioId: string) {
    const codigo = datos.codigo.trim();
    const yaExiste = await this.prisma.vendedoraComision.findUnique({ where: { codigo } });
    if (yaExiste) {
      /* Un 409 con el nombre de quien ocupa el código, no un choque de índice:
         el caso típico es teclear el código de alguien que ya está y no
         entender por qué falla. */
      throw new ConflictException(
        `El código ${codigo} ya lo tiene "${yaExiste.nombre}". Los códigos no se repiten.`,
      );
    }

    const vendedora = await this.prisma.vendedoraComision.create({
      data: {
        codigo,
        nombre: datos.nombre.trim().slice(0, 200),
        tipo: datos.tipo ?? TipoVendedora.VENDEDORA,
        area: datos.area ?? AreaVendedora.EJECUTIVA,
        sueldoBase: datos.sueldoBase ?? 0,
        configurada: true,
      },
    });

    this.resumenAnual.invalidar();
    await this.audit.registrar('VendedoraComision', vendedora.id, 'CREAR', usuarioId, {
      codigo,
      nombre: vendedora.nombre,
      area: vendedora.area,
    });
    return vendedora;
  }

  async actualizarVendedora(
    id: string,
    datos: ActualizarVendedoraDto,
    usuarioId: string,
  ) {
    const actual = await this.prisma.vendedoraComision.findUnique({ where: { id } });
    if (!actual) {
      throw new NotFoundException(`Vendedora ${id} no encontrada`);
    }

    /* `oculta`/`motivoOculta` NO se copian del DTO: los resuelve
       `cambiosDeVisibilidad()` entero, con su regla y su fecha. Dejarlos pasar
       por el spread permitiría escribir un motivo sin ocultar a nadie. */
    const { oculta: _oculta, motivoOculta: _motivo, ...resto } = datos;

    const vendedora = await this.prisma.vendedoraComision.update({
      where: { id },
      // Editarla desde el panel es exactamente el acto de configurarla.
      data: { ...resto, configurada: true, ...this.cambiosDeVisibilidad(actual, datos) },
    });

    /* Tipo y área deciden objetivo y bonos de la vista anual; `activa` y
       `oculta` deciden si la vendedora aparece en ella. */
    this.resumenAnual.invalidar();

    await this.audit.registrar('VendedoraComision', id, 'ACTUALIZAR', usuarioId, {
      ...(datos as Record<string, unknown>),
    });
    return vendedora;
  }

  /**
   * Los campos que acompañan a un cambio de `oculta`, y la regla que lo protege.
   *
   * Ocultar exige motivo por la misma razón que excluir una venta del cálculo
   * (ver `ajustarVenta`): el efecto es que una persona desaparece de la planilla
   * que administración firma, y meses después nadie recuerda si fue un despido,
   * una renuncia o un clic equivocado. El motivo y la fecha quedan en la propia
   * fila —no solo en la auditoría— para que la pantalla pueda explicarlo sin
   * cruzar tablas.
   *
   * Volver a mostrarla limpia los dos: dejarlos puestos haría que apareciera en
   * los informes y "oculta desde marzo por despido" a la vez, que es la misma
   * incoherencia que se arregló en las ventas reincluidas.
   */
  private cambiosDeVisibilidad(
    actual: VendedoraComision,
    datos: ActualizarVendedoraDto,
  ): Prisma.VendedoraComisionUpdateInput {
    if (datos.oculta === undefined || datos.oculta === actual.oculta) {
      /* Un PATCH que no toca la visibilidad no puede arrastrar `motivoOculta`
         suelto: sin `oculta` no significa nada. */
      return {};
    }

    if (datos.oculta) {
      const motivo = datos.motivoOculta?.trim();
      if (!motivo) {
        throw new BadRequestException(
          'Para ocultar una vendedora de los informes hay que indicar el motivo.',
        );
      }
      return { oculta: true, ocultaDesde: new Date(), motivoOculta: motivo };
    }

    return { oculta: false, ocultaDesde: null, motivoOculta: null };
  }
}
