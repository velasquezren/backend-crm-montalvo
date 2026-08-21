import { BadRequestException } from '@nestjs/common';

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

const prisma = new PrismaService({ datasources: { db: { url: URL_TEST } } });

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

    it('cierra los leads abiertos de la paciente', async () => {
      const lead = await prisma.lead.create({
        data: { clienteId, origen: 'PRESENCIAL', estado: 'NUEVO' },
      });

      await service.create(ventaBase(), agenteId);

      expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).estado).toBe(
        'CONVERTIDO',
      );
    });
  });
});
