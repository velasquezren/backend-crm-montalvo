import { BadRequestException, NotFoundException } from '@nestjs/common';

import { AuditService } from '../../common/audit/audit.service';
import { R2Service } from '../../common/storage/r2.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { LeadsService } from '../leads/leads.service';
import { ServiciosService } from '../servicios/servicios.service';
import { VentasService } from './ventas.service';

/**
 * Pruebas contra el Postgres de verdad (`crm_test` en el :5433 local).
 *
 * El módulo se desplegó sin ninguna prueba y decide dos cosas caras: qué
 * comisión se genera, y qué archivo del bucket se puede leer. Lo que se fija
 * aquí es sobre todo la segunda: la clave de R2 llega en el body, o sea que es
 * entrada de usuario, y firmarla sin comprobar de quién es convierte el
 * formulario de ventas en un lector del bucket entero.
 *
 * Se comprueba además que el CRM en tiempo real no toca `VentaImportada`: la
 * planilla mensual de FileMaker y las ventas de las agentes conviven, y esa
 * separación es la premisa de todo el módulo de comisiones.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';

if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService(URL_TEST);

/** R2 es red; se registra qué se subiría y qué se firmaría. */
class R2Espia {
  readonly firmadas: string[] = [];
  habilitado = true;
  async subir(): Promise<void> {}
  async urlFirmada(key: string): Promise<string | null> {
    this.firmadas.push(key);
    return `https://r2.local/${key}`;
  }
  async eliminar(): Promise<void> {}
}

let service: VentasService;
let r2: R2Espia;
let agenteId: string;
let otraAgenteId: string;
let clienteId: string;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  /* Las suites comparten `crm_test` y corren en serie. Las demás limpian
     borrando `Cliente`, que es lo que había que borrar antes de que existieran
     ventas: dejar filas de `Venta` aquí hace que la FK `Venta_clienteId_fkey`
     les reviente el `beforeEach` a todas. Cada suite devuelve la base como la
     encontró. */
  await prisma.venta.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.cliente.deleteMany();
  await prisma.usuario.deleteMany();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.auditLog.deleteMany();
  await prisma.venta.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.cliente.deleteMany();
  await prisma.usuario.deleteMany();

  r2 = new R2Espia();
  const audit = new AuditService(prisma);
  service = new VentasService(
    prisma,
    new ClientesService(prisma, audit, new ServiciosService(prisma)),
    new LeadsService(prisma, new ClientesService(prisma, audit, new ServiciosService(prisma))),
    audit,
    r2 as unknown as R2Service,
  );

  const agente = await prisma.usuario.create({
    data: { nombre: 'vendedora', email: 'v@test.local', passwordHash: 'x', rol: 'AGENTE', activo: true },
  });
  const otra = await prisma.usuario.create({
    data: { nombre: 'otra', email: 'o@test.local', passwordHash: 'x', rol: 'AGENTE', activo: true },
  });
  const cliente = await prisma.cliente.create({
    data: { nombre: 'Paciente prueba', telefono: '+59179000001' },
  });
  agenteId = agente.id;
  otraAgenteId = otra.id;
  clienteId = cliente.id;
});

const ventaBase = () => ({ clienteId, producto: 'Botox', monto: 1200 });

describe('VentasService contra Postgres real', () => {
  describe('el comprobante que se firma tiene que ser propio', () => {
    it('acepta una clave de la carpeta de la agente', async () => {
      const venta = await service.create(
        { ...ventaBase(), comprobanteKey: `comprobantes/${agenteId}/abc.jpg` },
        agenteId,
      );

      expect(venta.comprobanteUrl).toContain(`comprobantes/${agenteId}/abc.jpg`);
    });

    /* El caso que motivó la comprobación: el body podía traer la clave de
       CUALQUIER objeto del bucket y el detalle devolvía su URL firmada. */
    it('rechaza la clave de la memoria de otra agente', async () => {
      await expect(
        service.create(
          { ...ventaBase(), comprobanteKey: `memoria/${otraAgenteId}/privado.jpg` },
          agenteId,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rechaza el comprobante de otra agente', async () => {
      await expect(
        service.create(
          { ...ventaBase(), comprobanteKey: `comprobantes/${otraAgenteId}/suyo.jpg` },
          agenteId,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('lo rechazado no llega a firmarse ni se guarda la venta', async () => {
      await expect(
        service.create({ ...ventaBase(), comprobanteKey: 'whatsapp/otro.jpg' }, agenteId),
      ).rejects.toThrow(BadRequestException);

      expect(r2.firmadas).toHaveLength(0);
      expect(await prisma.venta.count()).toBe(0);
    });

    /* Segunda barrera: aunque una fila vieja tuviera una clave de fuera, la
       lectura no la firma. */
    it('una venta con clave ajena ya guardada no devuelve URL al listarla', async () => {
      await prisma.venta.create({
        data: { clienteId, agenteId, producto: 'x', monto: 1, comprobanteKey: 'memoria/x/y.jpg' },
      });

      const { datos } = await service.findAll({});

      expect(datos[0].comprobanteUrl).toBeNull();
      expect(r2.firmadas).toHaveLength(0);
    });
  });

  describe('subida del comprobante', () => {
    const archivo = (mimetype: string, size = 1024) => ({
      originalname: 'recibo.jpg',
      mimetype,
      size,
      buffer: Buffer.alloc(size),
    });

    it('guarda bajo la carpeta de quien sube, no donde diga el cliente', async () => {
      const subido = await service.subirComprobante(archivo('image/jpeg'), agenteId);

      expect(subido.comprobanteKey.startsWith(`comprobantes/${agenteId}/`)).toBe(true);
    });

    it.each(['image/jpeg', 'image/png', 'application/pdf'])('acepta %s', async mime => {
      await expect(service.subirComprobante(archivo(mime), agenteId)).resolves.toBeDefined();
    });

    it.each(['text/html', 'application/zip', 'video/mp4'])('rechaza %s', async mime => {
      await expect(service.subirComprobante(archivo(mime), agenteId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('sin archivo da 400 y no un 500', async () => {
      await expect(
        service.subirComprobante(undefined as never, agenteId),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('convivencia con la planilla de FileMaker', () => {
    it('una venta del CRM no toca VentaImportada', async () => {
      const importadasAntes = await prisma.ventaImportada.count();

      await service.create(ventaBase(), agenteId);

      expect(await prisma.ventaImportada.count()).toBe(importadasAntes);
    });

    it('sin leadId, cierra TODOS los leads abiertos de la paciente (comportamiento previo)', async () => {
      const lead = await prisma.lead.create({
        data: { clienteId, origen: 'PRESENCIAL', estado: 'NUEVO' },
      });

      await service.create(ventaBase(), agenteId);

      expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).estado).toBe(
        'CONVERTIDO',
      );
    });
  });

  describe('vínculo con el lead de origen', () => {
    it('con leadId, cierra SOLO ese lead y deja abiertos los demás del cliente', async () => {
      const leadDeEstaVenta = await prisma.lead.create({
        data: { clienteId, origen: 'INSTAGRAM_LEAD_AD', estado: 'CONTACTADO' },
      });
      const otroLeadSinRelacion = await prisma.lead.create({
        data: { clienteId, origen: 'FACEBOOK_LEAD_AD', estado: 'NUEVO' },
      });

      const venta = await service.create({ ...ventaBase(), leadId: leadDeEstaVenta.id }, agenteId);

      expect(venta.leadId).toBe(leadDeEstaVenta.id);
      expect((await prisma.lead.findUniqueOrThrow({ where: { id: leadDeEstaVenta.id } })).estado).toBe(
        'CONVERTIDO',
      );
      expect((await prisma.lead.findUniqueOrThrow({ where: { id: otroLeadSinRelacion.id } })).estado).toBe(
        'NUEVO',
      );
    });

    it('la venta queda trazable hasta el anuncio SIN mirar datosExtra', async () => {
      /* Es la métrica de CAMP-1: poder ir `Venta → Lead → anuncioId` con un
         JOIN, en vez de reconstruir la atribución desde el snapshot JSON del
         cliente, que guarda el ÚLTIMO referral y se sobrescribe. Medido el
         2026-09-18: las 14 ventas de producción tenían `leadId` en NULL, así
         que esta consulta no devolvía nada. */
      const leadDeCampana = await prisma.lead.create({
        data: { clienteId, origen: 'INSTAGRAM_MENSAJE', estado: 'NUEVO', anuncioId: '120212345678' },
      });

      const venta = await service.create({ ...ventaBase(), leadId: leadDeCampana.id }, agenteId);

      const trazada = await prisma.venta.findUniqueOrThrow({
        where: { id: venta.id },
        select: { monto: true, lead: { select: { anuncioId: true } } },
      });
      expect(trazada.lead?.anuncioId).toBe('120212345678');
      expect(Number(trazada.monto)).toBeGreaterThan(0);
    });

    it('sin lead, la venta se guarda igual y queda en NULL', async () => {
      /* NULL honesto es mejor que una atribución inventada: un cliente sin
         lead no tiene origen publicitario que declarar. */
      const venta = await service.create(ventaBase(), agenteId);
      expect(venta.leadId).toBeNull();
    });

    it('rechaza un leadId que pertenece a otro cliente', async () => {
      const otroCliente = await prisma.cliente.create({
        data: { nombre: 'Otra paciente', telefono: '+59170099999' },
      });
      const leadAjeno = await prisma.lead.create({
        data: { clienteId: otroCliente.id, origen: 'PRESENCIAL', estado: 'NUEVO' },
      });

      await expect(service.create({ ...ventaBase(), leadId: leadAjeno.id }, agenteId)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('motivo de pérdida', () => {
    it('exige motivo al registrar una venta directamente como PERDIDA', async () => {
      await expect(
        service.create({ ...ventaBase(), estado: 'PERDIDA' }, agenteId),
      ).rejects.toThrow('Para registrar una venta como perdida hay que indicar el motivo.');
    });

    it('exige motivo al cambiar una venta a PERDIDA', async () => {
      const venta = await service.create(ventaBase(), agenteId);

      await expect(service.cambiarEstado(venta.id, 'PERDIDA', agenteId)).rejects.toThrow(
        'Para marcar una venta como perdida hay que indicar el motivo.',
      );
    });

    it('guarda el motivo y lo limpia si la venta vuelve a GANADA', async () => {
      const venta = await service.create(ventaBase(), agenteId);

      const perdida = await service.cambiarEstado(venta.id, 'PERDIDA', agenteId, 'Se fue con la competencia');
      expect(perdida.motivoPerdida).toBe('Se fue con la competencia');

      const recuperada = await service.cambiarEstado(venta.id, 'GANADA', agenteId);
      expect(recuperada.motivoPerdida).toBeNull();
    });
  });

  describe('cambiar el estado desde el detalle', () => {
    it('devuelve la venta con su paciente: el detalle la reemplaza con esta respuesta', async () => {
      const venta = await service.create(ventaBase(), agenteId);
      const cambiada = await service.cambiarEstado(venta.id, 'EN_PROCESO', agenteId);
      expect(cambiada.cliente).toMatchObject({ id: clienteId, telefono: '+59179000001' });
      expect(cambiada.agente).toMatchObject({ id: agenteId });
    });

    it('sin cambio real no escribe en la bitácora', async () => {
      const venta = await service.create(ventaBase(), agenteId);
      await service.cambiarEstado(venta.id, 'GANADA', agenteId);
      expect(await prisma.auditLog.count({ where: { entidadId: venta.id, accion: 'CAMBIO_ESTADO' } })).toBe(0);
    });
  });

  describe('registrar dos veces la misma venta', () => {
    const clave = '5d7a2c1e-8f4b-4b6a-9c3d-2e1f0a9b8c7d';

    it('un doble envío o un reintento cuenta UNA venta y la audita una vez', async () => {
      const [a, b] = await Promise.all([
        service.create({ ...ventaBase(), clientRequestId: clave }, agenteId),
        service.create({ ...ventaBase(), clientRequestId: clave }, agenteId),
      ]);
      expect(a.id).toBe(b.id);
      expect(await prisma.venta.count()).toBe(1);
      expect(await prisma.auditLog.count({ where: { accion: 'CREADA' } })).toBe(1);

      const reintento = await service.create({ ...ventaBase(), clientRequestId: clave }, agenteId);
      expect(reintento.id).toBe(a.id);
    });

    it('la clave de otra agente no devuelve su venta', async () => {
      await service.create({ ...ventaBase(), clientRequestId: clave }, agenteId);
      await expect(service.create({ ...ventaBase(), clientRequestId: clave }, otraAgenteId)).rejects.toThrow();
    });

    /* La idempotencia devuelve la venta existente SIN repetir sus efectos. Si
       la venta pudiera quedar guardada sin ellos, el reintento la daría por
       buena y el lead y la categoría se quedarían mal para siempre. */
    it('si un efecto falla no queda la venta a medias, y el reintento lo completa todo', async () => {
      const lead = await prisma.lead.create({ data: { clienteId, origen: 'PRESENCIAL', estado: 'NUEVO' } });
      const leads = (service as unknown as { leadsService: LeadsService }).leadsService;
      jest.spyOn(leads, 'marcarConvertidos').mockRejectedValueOnce(new Error('la base se cayó a mitad'));

      await expect(service.create({ ...ventaBase(), clientRequestId: clave }, agenteId)).rejects.toThrow(
        'la base se cayó a mitad',
      );
      expect(await prisma.venta.count()).toBe(0);
      /* `actualizarCategoria` ya había corrido: también se deshace. */
      expect((await prisma.cliente.findUniqueOrThrow({ where: { id: clienteId } })).categoria).toBe('PROSPECTO');

      await service.create({ ...ventaBase(), clientRequestId: clave }, agenteId);
      expect(await prisma.venta.count()).toBe(1);
      expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).estado).toBe('CONVERTIDO');
      expect((await prisma.cliente.findUniqueOrThrow({ where: { id: clienteId } })).categoria).toBe('SILVER');
    });
  });

  describe('resumen de lo filtrado', () => {
    it('suma TODAS las ventas del filtro, no solo una página', async () => {
      for (let i = 0; i < 30; i++) await service.create({ ...ventaBase(), monto: 100, modulo: 'CONSULTA', metodoPago: 'QR' }, agenteId);
      await service.create({ ...ventaBase(), monto: 50 }, agenteId);

      const resumen = await service.resumen({});
      expect(resumen.porEstado).toEqual([{ clave: 'GANADA', cantidad: 31, monto: 3050 }]);
      expect(resumen.porModulo).toEqual(
        expect.arrayContaining([{ clave: 'CONSULTA', cantidad: 30, monto: 3000 }, { clave: null, cantidad: 1, monto: 50 }]),
      );
      expect((await service.findAll({ limite: 25 })).datos).toHaveLength(25);
    });

    it('filtra por módulo y por «sin módulo», igual en listado y resumen', async () => {
      await service.create({ ...ventaBase(), modulo: 'LABORATORIO' }, agenteId);
      await service.create(ventaBase(), agenteId);

      expect((await service.findAll({ modulo: 'LABORATORIO' })).total).toBe(1);
      expect((await service.findAll({ sinModulo: true })).total).toBe(1);
      expect((await service.resumen({ sinModulo: true })).porEstado[0]!.cantidad).toBe(1);
    });

    it('respeta el alcance de la agente', async () => {
      await service.create(ventaBase(), agenteId);
      await service.create(ventaBase(), otraAgenteId);
      expect((await service.resumen({ agenteId })).porEstado[0]!.cantidad).toBe(1);
    });
  });

  describe('categoría del paciente al corregir el estado', () => {
    const categoria = async () =>
      (await prisma.cliente.findUniqueOrThrow({ where: { id: clienteId } })).categoria;

    it('una venta anulada deja de contar: el paciente vuelve a su categoría real', async () => {
      const venta = await service.create(ventaBase(), agenteId);
      expect(await categoria()).toBe('SILVER');

      await service.cambiarEstado(venta.id, 'PERDIDA', agenteId, 'Pago rechazado');
      expect(await categoria()).toBe('PROSPECTO');

      await service.cambiarEstado(venta.id, 'GANADA', agenteId);
      expect(await categoria()).toBe('SILVER');
    });

    /* Sin transacción, el estado quedaba cambiado y el reintento caía en «sin
       cambio real»: la categoría ya no se recalculaba nunca. */
    it('si recalcular la categoría falla, el estado no cambia y el reintento la recalcula', async () => {
      const venta = await service.create(ventaBase(), agenteId);
      const clientes = (service as unknown as { clientesService: ClientesService }).clientesService;
      jest.spyOn(clientes, 'actualizarCategoria').mockRejectedValueOnce(new Error('la base se cayó a mitad'));

      await expect(service.cambiarEstado(venta.id, 'PERDIDA', agenteId, 'Pago rechazado')).rejects.toThrow(
        'la base se cayó a mitad',
      );
      expect((await prisma.venta.findUniqueOrThrow({ where: { id: venta.id } })).estado).toBe('GANADA');

      await service.cambiarEstado(venta.id, 'PERDIDA', agenteId, 'Pago rechazado');
      expect(await categoria()).toBe('PROSPECTO');
    });
  });

  /**
   * Corregir la atribución de una venta ya registrada — CAMP-1.
   *
   * Existe porque desde CAMP-1 `Venta.leadId` decide de qué anuncio se dirá que
   * vino el dinero, y equivocarse entre dos leads no puede costar un UPDATE a
   * mano en producción. La superficie es mínima a propósito: cambia el origen y
   * nada más.
   */
  describe('corregir el lead de origen de una venta existente', () => {
    it('1 · asigna el lead a una venta que no tenía origen', async () => {
      const venta = await service.create(ventaBase(), agenteId);
      expect(venta.leadId).toBeNull();
      const lead = await prisma.lead.create({
        data: { clienteId, origen: 'FACEBOOK_LEAD_AD', estado: 'NUEVO' },
      });

      const corregida = await service.corregirOrigen(venta.id, { leadId: lead.id }, agenteId);

      expect(corregida.leadId).toBe(lead.id);
      expect(corregida.lead?.origen).toBe('FACEBOOK_LEAD_AD');
    });

    it('2 · reemplaza el lead por otro del mismo cliente', async () => {
      const elegidoMal = await prisma.lead.create({
        data: { clienteId, origen: 'INSTAGRAM_MENSAJE', estado: 'NUEVO' },
      });
      const elCorrecto = await prisma.lead.create({
        data: { clienteId, origen: 'FACEBOOK_LEAD_AD', estado: 'NUEVO' },
      });
      const venta = await service.create({ ...ventaBase(), leadId: elegidoMal.id }, agenteId);

      const corregida = await service.corregirOrigen(venta.id, { leadId: elCorrecto.id }, agenteId);

      expect(corregida.leadId).toBe(elCorrecto.id);
    });

    it('3 · quita la atribución con null', async () => {
      const lead = await prisma.lead.create({
        data: { clienteId, origen: 'PRESENCIAL', estado: 'NUEVO' },
      });
      const venta = await service.create({ ...ventaBase(), leadId: lead.id }, agenteId);

      const corregida = await service.corregirOrigen(venta.id, { leadId: null }, agenteId);

      expect(corregida.leadId).toBeNull();
      /* Quitar la atribución es una respuesta válida —"no se sabe de dónde
         vino"—, no un borrado a medias: la venta sigue completa. */
      expect(Number(corregida.monto)).toBe(1200);
    });

    it('4 · un lead de OTRA paciente responde 400 y no dice nada de ella', async () => {
      const otraPaciente = await prisma.cliente.create({
        data: { nombre: 'Otra paciente', telefono: '+59170099998' },
      });
      const leadAjeno = await prisma.lead.create({
        data: { clienteId: otraPaciente.id, origen: 'WHATSAPP_DIRECTO', estado: 'NUEVO' },
      });
      const venta = await service.create(ventaBase(), agenteId);

      await expect(
        service.corregirOrigen(venta.id, { leadId: leadAjeno.id }, agenteId),
      ).rejects.toThrow(BadRequestException);

      /* Mismo mensaje que para un lead inexistente: distinguirlos permitiría
         sondear qué ids hay en la base. */
      await expect(
        service.corregirOrigen(venta.id, { leadId: leadAjeno.id }, agenteId),
      ).rejects.toThrow('El lead indicado no corresponde a este cliente.');
      expect((await prisma.venta.findUniqueOrThrow({ where: { id: venta.id } })).leadId).toBeNull();
    });

    it('5 · una venta inexistente responde 404', async () => {
      await expect(
        service.corregirOrigen('00000000-0000-4000-8000-00000000dead', { leadId: null }, agenteId),
      ).rejects.toThrow(NotFoundException);
    });

    it('5b · la venta de otra agente responde 404, no 403', async () => {
      const lead = await prisma.lead.create({
        data: { clienteId, origen: 'WHATSAPP_DIRECTO', estado: 'NUEVO' },
      });
      const venta = await service.create(ventaBase(), agenteId);

      /* `soloAgenteId` es lo que devuelve `alcanceAgente` para una AGENTE. Que
         un id exista tampoco es información que deba filtrarse, así que 404 y
         no 403 — mismo criterio que ClientesService.findOne. */
      await expect(
        service.corregirOrigen(venta.id, { leadId: lead.id }, otraAgenteId, otraAgenteId),
      ).rejects.toThrow(NotFoundException);
      expect((await prisma.venta.findUniqueOrThrow({ where: { id: venta.id } })).leadId).toBeNull();
    });

    it('5c · un ADMIN (sin alcance) sí corrige la venta de otra agente', async () => {
      const lead = await prisma.lead.create({
        data: { clienteId, origen: 'WHATSAPP_DIRECTO', estado: 'NUEVO' },
      });
      const venta = await service.create(ventaBase(), agenteId);

      const corregida = await service.corregirOrigen(venta.id, { leadId: lead.id }, otraAgenteId);

      expect(corregida.leadId).toBe(lead.id);
    });

    it('6 · corregir NO crea otra venta', async () => {
      const lead = await prisma.lead.create({
        data: { clienteId, origen: 'WHATSAPP_DIRECTO', estado: 'NUEVO' },
      });
      const venta = await service.create(ventaBase(), agenteId);

      await service.corregirOrigen(venta.id, { leadId: lead.id }, agenteId);
      await service.corregirOrigen(venta.id, { leadId: null }, agenteId);

      expect(await prisma.venta.count()).toBe(1);
      expect((await prisma.venta.findFirstOrThrow()).id).toBe(venta.id);
    });

    it('7 · corregir NO altera importe, estado, agente ni comprobante', async () => {
      const lead = await prisma.lead.create({
        data: { clienteId, origen: 'WHATSAPP_DIRECTO', estado: 'NUEVO' },
      });
      const venta = await service.create(
        { ...ventaBase(), estado: 'PERDIDA', motivoPerdida: 'precio', comprobanteKey: `comprobantes/${agenteId}/r.jpg` },
        agenteId,
      );

      const corregida = await service.corregirOrigen(venta.id, { leadId: lead.id }, agenteId);

      expect(Number(corregida.monto)).toBe(Number(venta.monto));
      expect(corregida.estado).toBe('PERDIDA');
      expect(corregida.motivoPerdida).toBe('precio');
      expect(corregida.agenteId).toBe(agenteId);
      expect(corregida.comprobanteKey).toBe(venta.comprobanteKey);
    });

    it('8 · tras corregir, la trazabilidad hasta el anuncio apunta al lead nuevo', async () => {
      const anuncioViejo = await prisma.lead.create({
        data: { clienteId, origen: 'INSTAGRAM_MENSAJE', estado: 'NUEVO', anuncioId: '111111111' },
      });
      const anuncioBueno = await prisma.lead.create({
        data: { clienteId, origen: 'FACEBOOK_LEAD_AD', estado: 'NUEVO', anuncioId: '222222222' },
      });
      const venta = await service.create({ ...ventaBase(), leadId: anuncioViejo.id }, agenteId);

      await service.corregirOrigen(venta.id, { leadId: anuncioBueno.id }, agenteId);

      const trazada = await prisma.venta.findUniqueOrThrow({
        where: { id: venta.id },
        select: { lead: { select: { anuncioId: true } } },
      });
      expect(trazada.lead?.anuncioId).toBe('222222222');
    });

    it('9 · NO rehace la historia del embudo: los estados de los leads no se tocan', async () => {
      const elegidoMal = await prisma.lead.create({
        data: { clienteId, origen: 'INSTAGRAM_MENSAJE', estado: 'NUEVO' },
      });
      const elCorrecto = await prisma.lead.create({
        data: { clienteId, origen: 'FACEBOOK_LEAD_AD', estado: 'NUEVO' },
      });
      /* Crear la venta GANADA cierra el lead citado vía `marcarConvertidos`. */
      const venta = await service.create({ ...ventaBase(), leadId: elegidoMal.id }, agenteId);
      expect((await prisma.lead.findUniqueOrThrow({ where: { id: elegidoMal.id } })).estado).toBe(
        'CONVERTIDO',
      );

      await service.corregirOrigen(venta.id, { leadId: elCorrecto.id }, agenteId);

      /* Lo importante es lo que NO pasa. Volver a correr `marcarConvertidos`
         pondría CONVERTIDO el lead nuevo con la fecha de hoy y no existe la
         operación inversa para reabrir el viejo, así que la corrección
         inventaría un embudo que nunca ocurrió. El coste aceptado es este:
         `elegidoMal` queda CONVERTIDO sin venta que lo respalde. */
      expect((await prisma.lead.findUniqueOrThrow({ where: { id: elCorrecto.id } })).estado).toBe(
        'NUEVO',
      );
      expect((await prisma.lead.findUniqueOrThrow({ where: { id: elegidoMal.id } })).estado).toBe(
        'CONVERTIDO',
      );
    });

    it('10 · la corrección queda en la bitácora existente', async () => {
      const lead = await prisma.lead.create({
        data: { clienteId, origen: 'WHATSAPP_DIRECTO', estado: 'NUEVO' },
      });
      const venta = await service.create(ventaBase(), agenteId);

      await service.corregirOrigen(venta.id, { leadId: lead.id }, agenteId);

      const entrada = await prisma.auditLog.findFirstOrThrow({
        where: { entidad: 'Venta', entidadId: venta.id, accion: 'CAMBIO_ORIGEN' },
      });
      expect(entrada.usuarioId).toBe(agenteId);
      expect(entrada.cambios).toEqual({ de: null, a: lead.id });
    });

    it('11 · corregir al mismo lead no escribe una entrada de bitácora vacía', async () => {
      const lead = await prisma.lead.create({
        data: { clienteId, origen: 'WHATSAPP_DIRECTO', estado: 'NUEVO' },
      });
      const venta = await service.create({ ...ventaBase(), leadId: lead.id }, agenteId);

      const igual = await service.corregirOrigen(venta.id, { leadId: lead.id }, agenteId);

      expect(igual.leadId).toBe(lead.id);
      expect(
        await prisma.auditLog.count({ where: { entidadId: venta.id, accion: 'CAMBIO_ORIGEN' } }),
      ).toBe(0);
    });
  });
});
