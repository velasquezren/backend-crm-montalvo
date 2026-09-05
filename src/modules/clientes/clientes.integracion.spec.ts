import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ServiciosService } from '../servicios/servicios.service';
import { ClientesService } from './clientes.service';

/**
 * Contra PostgreSQL real (`crm_test` en el :5433 local). El orden de un listado
 * lo decide la base: comprobarlo con un doble solo diría que le pedimos el
 * `orderBy` correcto, no que las filas salgan en ese orden.
 *
 * `npm run test:integracion`.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';
if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService(URL_TEST);
let service: ClientesService;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.auditLog.deleteMany();
  await prisma.cliente.deleteMany();
  await prisma.usuario.deleteMany();
  service = new ClientesService(prisma, new AuditService(prisma), new ServiciosService(prisma));
});

async function cliente(nombre: string, telefono: string, categoria: 'GOLD' | 'PROSPECTO' = 'PROSPECTO') {
  return prisma.cliente.create({ data: { nombre, telefono, categoria } });
}

describe('ClientesService.findAll — orden por columna', () => {
  it('sin orden explícito, lo recién tocado va primero', async () => {
    await cliente('Ana', '+59170000001');
    await new Promise(r => setTimeout(r, 5));
    const beto = await cliente('Beto', '+59170000002');

    const { datos } = await service.findAll({});

    expect(datos[0].id).toBe(beto.id);
  });

  it('ordena por nombre ascendente y descendente', async () => {
    await cliente('Carlos', '+59170000003');
    await cliente('Ana', '+59170000001');
    await cliente('Beto', '+59170000002');

    const asc = await service.findAll({ orden: 'nombre', direccion: 'asc' });
    expect(asc.datos.map(c => c.nombre)).toEqual(['Ana', 'Beto', 'Carlos']);

    const desc = await service.findAll({ orden: 'nombre', direccion: 'desc' });
    expect(desc.datos.map(c => c.nombre)).toEqual(['Carlos', 'Beto', 'Ana']);
  });

  it('sin dirección explícita ordena ascendente', async () => {
    await cliente('Zoe', '+59170000009');
    await cliente('Ana', '+59170000001');

    const { datos } = await service.findAll({ orden: 'nombre' });

    expect(datos.map(c => c.nombre)).toEqual(['Ana', 'Zoe']);
  });

  /**
   * Trampa que conviene tener fijada: Postgres ordena un enum por el orden en
   * que está DECLARADO en `schema.prisma`, no alfabéticamente. `CategoriaCliente`
   * va de peor a mejor (PROSPECTO → BRONZE → SILVER → GOLD), así que descendente
   * saca a los mejores pacientes primero, que es justo lo que se quiere al
   * ordenar por esa columna. Si alguien reordena el enum, esto lo delata.
   */
  it('ordena por categoría siguiendo el ranking del enum, no el alfabeto', async () => {
    await cliente('Prospecto', '+59170000001', 'PROSPECTO');
    await cliente('Dorado', '+59170000002', 'GOLD');

    const desc = await service.findAll({ orden: 'categoria', direccion: 'desc' });
    expect(desc.datos[0].categoria).toBe('GOLD');

    const asc = await service.findAll({ orden: 'categoria', direccion: 'asc' });
    expect(asc.datos[0].categoria).toBe('PROSPECTO');
  });

  /* El orden no puede saltarse la paginación ni el filtro: lo que se ordena es
     el conjunto FILTRADO, no la página que tocó salir. */
  it('ordena sobre el total filtrado, no solo dentro de la página', async () => {
    for (const n of ['Ana', 'Beto', 'Carlos', 'Delia', 'Elena']) {
      await cliente(n, `+5917000000${n.length}${n[0]}`);
    }

    const primera = await service.findAll({ orden: 'nombre', direccion: 'desc', limite: 2, pagina: 1 });
    const segunda = await service.findAll({ orden: 'nombre', direccion: 'desc', limite: 2, pagina: 2 });

    expect(primera.datos.map(c => c.nombre)).toEqual(['Elena', 'Delia']);
    expect(segunda.datos.map(c => c.nombre)).toEqual(['Carlos', 'Beto']);
    expect(primera.total).toBe(5);
  });

  it('combina búsqueda y orden', async () => {
    await cliente('Ana Rojas', '+59170000001');
    await cliente('Ana Vera', '+59170000002');
    await cliente('Beto Rojas', '+59170000003');

    const { datos, total } = await service.findAll({
      busqueda: 'Ana',
      orden: 'nombre',
      direccion: 'desc',
    });

    expect(total).toBe(2);
    expect(datos.map(c => c.nombre)).toEqual(['Ana Vera', 'Ana Rojas']);
  });

  it('el orden respeta el escopado por agente', async () => {
    const agente = await prisma.usuario.create({
      data: { nombre: 'Agente', email: 'a@test.local', passwordHash: 'x' },
    });
    const otro = await prisma.usuario.create({
      data: { nombre: 'Otro', email: 'o@test.local', passwordHash: 'x' },
    });
    await prisma.cliente.create({
      data: { nombre: 'Ana', telefono: '+59170000001', agenteId: agente.id },
    });
    await prisma.cliente.create({
      data: { nombre: 'Beto', telefono: '+59170000002', agenteId: otro.id },
    });

    const { datos, total } = await service.findAll({ orden: 'nombre' }, agente.id);

    expect(total).toBe(1);
    expect(datos[0].nombre).toBe('Ana');
  });
});
