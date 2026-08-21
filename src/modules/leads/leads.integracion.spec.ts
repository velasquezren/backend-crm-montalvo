import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { ServiciosService } from '../servicios/servicios.service';
import { LeadsService } from './leads.service';

/**
 * Contra PostgreSQL real (`crm_test` en el :5433 local) — ver `clientes.integracion.spec.ts`.
 *
 * Cubre el hueco de escopado que tenía este módulo: `findAll`/`resumen` sí
 * filtraban por `soloAgenteId`, pero `updateEstado`/`asignarAgente` no repetían
 * el mismo chequeo — cualquier agente autenticado podía tocar CUALQUIER lead
 * del sistema por UUID. Mismo patrón que ya se probó en Clientes y
 * Conversaciones; ver `crm-backend-module`.
 *
 * `npm run test:integracion`.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';
if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService({ datasources: { db: { url: URL_TEST } } });
let service: LeadsService;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.auditLog.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.conversacion.deleteMany();
  await prisma.cliente.deleteMany();
  await prisma.usuario.deleteMany();
  service = new LeadsService(prisma, new ClientesService(prisma, new AuditService(prisma), new ServiciosService(prisma)));
});

async function usuario(nombre: string, email: string) {
  return prisma.usuario.create({ data: { nombre, email, passwordHash: 'x' } });
}

async function clienteConLead(nombre: string, telefono: string, agenteId?: string) {
  const cliente = await prisma.cliente.create({ data: { nombre, telefono, agenteId } });
  const lead = await prisma.lead.create({
    data: { clienteId: cliente.id, origen: 'WHATSAPP_DIRECTO', agenteId },
  });
  return { cliente, lead };
}

describe('LeadsService.updateEstado — escopado por agente', () => {
  it('404 si el lead es de otro agente', async () => {
    const yo = await usuario('Yo', 'yo@test.local');
    const otro = await usuario('Otro', 'otro@test.local');
    const { lead } = await clienteConLead('Ana', '+59170000001', otro.id);

    await expect(service.updateEstado(lead.id, 'CONTACTADO', yo.id)).rejects.toThrow(
      'no encontrado',
    );

    const sinCambios = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(sinCambios.estado).toBe('NUEVO');
  });

  it('permite el cambio sobre un lead propio', async () => {
    const yo = await usuario('Yo', 'yo@test.local');
    const { lead } = await clienteConLead('Ana', '+59170000001', yo.id);

    const actualizado = await service.updateEstado(lead.id, 'CONTACTADO', yo.id);

    expect(actualizado.estado).toBe('CONTACTADO');
  });

  it('permite el cambio sobre un lead del pool (sin asignar)', async () => {
    const yo = await usuario('Yo', 'yo@test.local');
    const { lead } = await clienteConLead('Ana', '+59170000001');

    const actualizado = await service.updateEstado(lead.id, 'CONTACTADO', yo.id);

    expect(actualizado.estado).toBe('CONTACTADO');
  });

  it('un admin (sin soloAgenteId) cambia el estado de cualquier lead', async () => {
    const otro = await usuario('Otro', 'otro@test.local');
    const { lead } = await clienteConLead('Ana', '+59170000001', otro.id);

    const actualizado = await service.updateEstado(lead.id, 'PERDIDO', undefined);

    expect(actualizado.estado).toBe('PERDIDO');
  });
});

describe('LeadsService.asignarAgente — delega en ClientesService y audita', () => {
  it('arrastra TODOS los leads abiertos del cliente, no solo el que se tocó', async () => {
    const nueva = await usuario('Nueva', 'nueva@test.local');
    const cliente = await prisma.cliente.create({ data: { nombre: 'Ana', telefono: '+59170000001' } });
    const leadUno = await prisma.lead.create({ data: { clienteId: cliente.id, origen: 'WHATSAPP_DIRECTO' } });
    const leadDos = await prisma.lead.create({ data: { clienteId: cliente.id, origen: 'PRESENCIAL' } });

    await service.asignarAgente(leadUno.id, nueva.id, 'usuario-admin');

    const otroLead = await prisma.lead.findUniqueOrThrow({ where: { id: leadDos.id } });
    expect(otroLead.agenteId).toBe(nueva.id);
  });

  it('deja rastro en AuditLog de quién reasignó', async () => {
    const nueva = await usuario('Nueva', 'nueva@test.local');
    const { cliente, lead } = await clienteConLead('Ana', '+59170000001');

    await service.asignarAgente(lead.id, nueva.id, 'usuario-admin');

    const registros = await prisma.auditLog.findMany({ where: { entidadId: cliente.id } });
    expect(registros).toHaveLength(1);
    expect(registros[0].usuarioId).toBe('usuario-admin');
  });

  it('rechaza un agente destino inactivo', async () => {
    const inactivo = await usuario('Inactivo', 'inactivo@test.local');
    await prisma.usuario.update({ where: { id: inactivo.id }, data: { activo: false } });
    const { lead } = await clienteConLead('Ana', '+59170000001');

    await expect(service.asignarAgente(lead.id, inactivo.id, 'usuario-admin')).rejects.toThrow(
      'no encontrado o inactivo',
    );
  });

  it('404 si el lead no existe', async () => {
    await expect(
      service.asignarAgente('00000000-0000-0000-0000-000000000000', null, 'usuario-admin'),
    ).rejects.toThrow('no encontrado');
  });
});
