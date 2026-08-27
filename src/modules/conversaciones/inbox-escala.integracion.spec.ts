import { ConfigService } from '@nestjs/config';

import { AuditService } from '../../common/audit/audit.service';
import { R2Service } from '../../common/storage/r2.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { ServiciosService } from '../servicios/servicios.service';
import { WhatsappCloudService } from '../../common/whatsapp/whatsapp-cloud.service';
import { ConversacionesGateway } from './conversaciones.gateway';
import { DespachadorSalienteService } from './despachador-saliente.service';
import { ConversacionesService } from './conversaciones.service';

/**
 * El inbox por encima del viejo tope de 500, contra un PostgreSQL DE VERDAD.
 *
 * ## Qué se está demostrando
 *
 * Hasta el 2026-08-27 `findAll` devolvía las 500 conversaciones más recientes y
 * el navegador resolvía pestañas, filtro por agente y buscador **en memoria
 * sobre ese corte**. La consecuencia no era lentitud: era que una conversación
 * en el puesto 501 **no aparecía al buscar a esa paciente por nombre**. La
 * agente leía "sin resultados" y concluía que la paciente no estaba en el
 * sistema. Ya había pasado al cruzar las 100; al ritmo medido (+13,3/día sobre
 * 325) volvía a pasar el 8 de septiembre de 2026.
 *
 * Por eso estas pruebas no comprueban que "compila" ni que la consulta es
 * rápida. Comprueban lo único que importaba: **que una conversación antigua
 * sigue siendo encontrable**, y que cruzar el viejo límite no cambia nada.
 *
 * Van contra Postgres real porque lo que hay que demostrar lo decide Postgres:
 * el `OR` de visibilidad combinado con los filtros de vista, el `skip`/`take`
 * sobre 1.000 filas y el `contains` contra los índices GIN trigram. Una base
 * falsa aceptaría igual una consulta mal escrita.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';

/* Mismo cerrojo que el resto de la suite: esta prueba borra tablas enteras. */
if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService({ datasources: { db: { url: URL_TEST } } });

class GatewayEspia {
  readonly emitidos: string[] = [];
  emitirActividad(conversacionId: string): void {
    this.emitidos.push(conversacionId);
  }
  notificarEntrante(conversacionId: string): void {
    this.emitirActividad(conversacionId);
  }
}

class R2Espia {
  habilitado = false;
  async subir(): Promise<void> {}
  async urlFirmada(): Promise<string | null> {
    return null;
  }
}

let service: ConversacionesService;
let admin: { id: string };

/** El id que se le pasa a `findAll` como "quién pregunta" cuando es un ADMIN. */
const comoAdmin = () => ({ soloAgenteId: undefined, usuarioId: admin.id });

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.auditLog.deleteMany();
  await prisma.mensaje.deleteMany();
  await prisma.conversacion.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.cliente.deleteMany();
  await prisma.usuario.deleteMany();

  const gateway = new GatewayEspia();
  const r2 = new R2Espia();
  const config = new ConfigService({});
  const clientesService = new ClientesService(prisma, new AuditService(prisma), new ServiciosService(prisma));
  const whatsapp = new WhatsappCloudService(config);

  service = new ConversacionesService(
    prisma,
    clientesService,
    gateway as unknown as ConversacionesGateway,
    r2 as unknown as R2Service,
    whatsapp,
    new DespachadorSalienteService(
      prisma,
      gateway as unknown as ConversacionesGateway,
      r2 as unknown as R2Service,
      whatsapp,
    ),
  );

  admin = await prisma.usuario.create({
    data: { nombre: 'Admin', email: 'admin@test.local', passwordHash: 'x', rol: 'ADMIN', activo: true },
  });
});

async function crearAgente(nombre: string) {
  return prisma.usuario.create({
    data: { nombre, email: `${nombre}@test.local`, passwordHash: 'x', rol: 'AGENTE', activo: true },
  });
}

/**
 * Siembra `cuantas` conversaciones con `updatedAt` escalonado: la #0 es la más
 * ANTIGUA y la última la más reciente. Devuelve los ids en ese mismo orden.
 *
 * El escalonado es lo que hace la prueba honesta — sin él todas comparten
 * `updatedAt` y "la conversación número 1.000 por antigüedad" no significa nada.
 * `@updatedAt` solo pisa el valor en los UPDATE, así que en `createMany` se
 * puede fijar a mano; la prueba de orden de más abajo lo verifica.
 */
async function sembrarConversaciones(
  cuantas: number,
  opciones: { nombreDeLaMasAntigua?: string; telefonoDeLaMasAntigua?: string; agenteId?: string } = {},
): Promise<string[]> {
  const base = Date.now() - cuantas * 60_000;

  const clientes = Array.from({ length: cuantas }, (_, i) => ({
    nombre: i === 0 && opciones.nombreDeLaMasAntigua ? opciones.nombreDeLaMasAntigua : `Paciente ${i}`,
    telefono:
      i === 0 && opciones.telefonoDeLaMasAntigua
        ? opciones.telefonoDeLaMasAntigua
        : `+5917${String(i).padStart(7, '0')}`,
  }));

  await prisma.cliente.createMany({ data: clientes });
  const creados = await prisma.cliente.findMany({ select: { id: true, telefono: true } });
  const idClientePorTelefono = new Map(creados.map(c => [c.telefono, c.id]));

  await prisma.conversacion.createMany({
    data: clientes.map((c, i) => ({
      clienteId: idClientePorTelefono.get(c.telefono)!,
      agenteId: opciones.agenteId ?? null,
      updatedAt: new Date(base + i * 60_000),
    })),
  });

  const conversaciones = await prisma.conversacion.findMany({
    select: { id: true, cliente: { select: { telefono: true } } },
  });
  const idPorTelefono = new Map(conversaciones.map(c => [c.cliente.telefono, c.id]));

  return clientes.map(c => idPorTelefono.get(c.telefono)!);
}

describe('Inbox por encima del viejo tope de 500', () => {
  /**
   * EL caso. Con el código anterior esta prueba fallaba: la conversación más
   * antigua de 1.000 quedaba en el puesto 1.000 por `updatedAt`, fuera del
   * corte de 500, y el buscador —que filtraba en memoria sobre lo recibido—
   * devolvía cero. La paciente existía y el sistema decía que no.
   */
  it('encuentra por nombre una conversación que quedaría en el puesto 1.000', async () => {
    const ids = await sembrarConversaciones(1000, {
      nombreDeLaMasAntigua: 'Zulema Antigua Quispe',
      telefonoDeLaMasAntigua: '+59188800999',
    });
    const laMasAntigua = ids[0];

    /* Primero se demuestra que de verdad está fuera del viejo corte: si por lo
       que sea acabara dentro de las 500, la prueba no probaría nada. */
    const posicion = await prisma.conversacion.count({
      where: { updatedAt: { gt: (await prisma.conversacion.findUniqueOrThrow({ where: { id: laMasAntigua } })).updatedAt } },
    });
    expect(posicion).toBe(999);

    const { datos } = await service.findAll(comoAdmin().soloAgenteId, comoAdmin().usuarioId, {
      busqueda: 'Zulema',
    });

    expect(datos).toHaveLength(1);
    expect(datos[0].id).toBe(laMasAntigua);
    expect(datos[0].cliente.nombre).toBe('Zulema Antigua Quispe');
  });

  it('también la encuentra por teléfono', async () => {
    const ids = await sembrarConversaciones(1000, {
      nombreDeLaMasAntigua: 'Zulema Antigua Quispe',
      telefonoDeLaMasAntigua: '+59188800999',
    });

    const { datos } = await service.findAll(undefined, admin.id, { busqueda: '88800999' });

    expect(datos.map(c => c.id)).toEqual([ids[0]]);
  });

  /**
   * El comportamiento no puede cambiar al cruzar 500. Con el código anterior,
   * `total` se quedaba clavado en 500 a partir de ahí y las conversaciones
   * sobrantes desaparecían.
   */
  it.each([499, 500, 501, 1000])('con %i conversaciones el total es exacto', async cuantas => {
    await sembrarConversaciones(cuantas);

    const pagina = await service.findAll(undefined, admin.id, {});

    expect(pagina.total).toBe(cuantas);
    expect(pagina.contadores.total).toBe(cuantas);
    /* Y la más antigua sigue siendo alcanzable navegando hasta el final. */
    const ultima = await service.findAll(undefined, admin.id, { pagina: pagina.totalPaginas });
    expect(ultima.datos.length).toBeGreaterThan(0);
  });

  it('paginar 1.000 conversaciones no duplica ni se salta ninguna', async () => {
    await sembrarConversaciones(1000);

    const vistos: string[] = [];
    let pagina = 1;
    let totalPaginas = 1;

    do {
      const res = await service.findAll(undefined, admin.id, { pagina, limite: 100 });
      totalPaginas = res.totalPaginas;
      vistos.push(...res.datos.map(c => c.id));
      pagina++;
    } while (pagina <= totalPaginas);

    expect(vistos).toHaveLength(1000);
    expect(new Set(vistos).size).toBe(1000);
  });

  it('la primera página son las más recientes, en orden', async () => {
    const ids = await sembrarConversaciones(600);
    const masRecientes = [...ids].reverse().slice(0, 50);

    const { datos } = await service.findAll(undefined, admin.id, {});

    expect(datos.map(c => c.id)).toEqual(masRecientes);
  });
});

describe('Los filtros del inbox se resuelven sobre el conjunto completo', () => {
  it('el contador de "sin asignar" cuenta las 1.000, no las de la página', async () => {
    await sembrarConversaciones(1000);

    const { datos, contadores } = await service.findAll(undefined, admin.id, {});

    expect(datos).toHaveLength(50); // una página
    expect(contadores.sinAsignar).toBe(1000); // pero el contador ve todo
  });

  it('"mis chats" encuentra la conversación antigua de esa agente', async () => {
    const ana = await crearAgente('ana');
    const ids = await sembrarConversaciones(1000);
    /* La más antigua de todas es suya: fuera del viejo corte de 500. */
    await prisma.conversacion.update({ where: { id: ids[0] }, data: { agenteId: ana.id } });

    const { datos, total, contadores } = await service.findAll(undefined, ana.id, { tab: 'MIS_CHATS' });

    expect(total).toBe(1);
    expect(datos.map(c => c.id)).toEqual([ids[0]]);
    expect(contadores.misChats).toBe(1);
  });

  it('el filtro por agente del admin también llega al fondo de la lista', async () => {
    const ana = await crearAgente('ana');
    const ids = await sembrarConversaciones(1000);
    await prisma.conversacion.update({ where: { id: ids[0] }, data: { agenteId: ana.id } });

    const { datos } = await service.findAll(undefined, admin.id, { agenteId: ana.id });

    expect(datos.map(c => c.id)).toEqual([ids[0]]);
  });

  /* Los comodines de LIKE los escribe la gente todo el día en esta clínica
     ("20%"), y Prisma los pasa crudos a la consulta. Sin escapar, buscar `%`
     devolvía el inbox entero fingiendo ser un resultado de búsqueda. */
  it('un % en el buscador no devuelve el inbox entero', async () => {
    await sembrarConversaciones(20);

    const { total } = await service.findAll(undefined, admin.id, { busqueda: '%' });

    expect(total).toBe(0);
  });
});

describe('La pestaña "Sin responder" a escala', () => {
  it('cuenta sobre las 1.000 y encuentra la antigua que sigue esperando', async () => {
    const ids = await sembrarConversaciones(1000);
    await prisma.conversacion.update({ where: { id: ids[0] }, data: { esperandoRespuesta: true } });

    const { datos, total, contadores } = await service.findAll(undefined, admin.id, {
      tab: 'SIN_RESPONDER',
    });

    expect(total).toBe(1);
    expect(datos.map(c => c.id)).toEqual([ids[0]]);
    expect(contadores.sinResponder).toBe(1);
  });
});

describe('El permiso sigue mandando por encima de cualquier filtro', () => {
  /**
   * Lo más importante de todo el cambio: mover la búsqueda al servidor no
   * puede convertirse en una forma de encontrar lo que no te toca. Antes el
   * buscador solo veía lo que el backend ya te había enviado —filtrado por
   * rol—, así que era imposible por construcción. Ahora la consulta la arma el
   * servidor, y hay que demostrar que el AND con el permiso sigue ahí.
   */
  it('una agente no encuentra por búsqueda la conversación de otra', async () => {
    const ana = await crearAgente('ana');
    const beatriz = await crearAgente('beatriz');

    const cliente = await prisma.cliente.create({
      data: { nombre: 'Paciente Reservada', telefono: '+59179999999', agenteId: beatriz.id },
    });
    await prisma.conversacion.create({ data: { clienteId: cliente.id, agenteId: beatriz.id } });

    /* Beatriz sí la encuentra. */
    const deBeatriz = await service.findAll(beatriz.id, beatriz.id, { busqueda: 'Reservada' });
    expect(deBeatriz.total).toBe(1);

    /* Ana no, por mucho que escriba el nombre exacto. */
    const deAna = await service.findAll(ana.id, ana.id, { busqueda: 'Reservada' });
    expect(deAna.total).toBe(0);
    expect(deAna.datos).toEqual([]);

    /* Y tampoco por teléfono, que es el otro campo del buscador. */
    const porTelefono = await service.findAll(ana.id, ana.id, { busqueda: '79999999' });
    expect(porTelefono.total).toBe(0);
  });

  it('los contadores de una agente no incluyen lo ajeno', async () => {
    const ana = await crearAgente('ana');
    const beatriz = await crearAgente('beatriz');

    const ids = await sembrarConversaciones(30);
    /* 10 para Ana, 10 para Beatriz, 10 en el pool. */
    for (let i = 0; i < 10; i++) {
      await prisma.conversacion.update({ where: { id: ids[i] }, data: { agenteId: ana.id } });
    }
    for (let i = 10; i < 20; i++) {
      await prisma.conversacion.update({ where: { id: ids[i] }, data: { agenteId: beatriz.id } });
    }

    const { contadores } = await service.findAll(ana.id, ana.id, {});

    /* Ana ve las suyas + el pool, nunca las de Beatriz. */
    expect(contadores.total).toBe(20);
    expect(contadores.misChats).toBe(10);
    expect(contadores.sinAsignar).toBe(10);
  });
});

describe('Refresco de una sola fila para el tiempo real', () => {
  it('devuelve la conversación cuando sigue encajando en la vista activa', async () => {
    const ids = await sembrarConversaciones(3);

    const { conversacion, contadores } = await service.resumenParaInbox(ids[0], undefined, admin.id, {});

    expect(conversacion?.id).toBe(ids[0]);
    expect(contadores.total).toBe(3);
  });

  /**
   * El caso que pidió el enunciado: si por la propia actualización la
   * conversación deja de pertenecer al conjunto visible, el navegador tiene que
   * poder quitarla en vez de dejar una fila que ya no corresponde.
   */
  it('devuelve null si la conversación ya no encaja en la pestaña activa', async () => {
    const ids = await sembrarConversaciones(3);
    await prisma.conversacion.update({ where: { id: ids[0] }, data: { esperandoRespuesta: true } });

    /* Estando en "Sin responder", ahí está. */
    const antes = await service.resumenParaInbox(ids[0], undefined, admin.id, { tab: 'SIN_RESPONDER' });
    expect(antes.conversacion?.id).toBe(ids[0]);

    /* Le contestan: sale de la pestaña. */
    await prisma.conversacion.update({ where: { id: ids[0] }, data: { esperandoRespuesta: false } });

    const despues = await service.resumenParaInbox(ids[0], undefined, admin.id, { tab: 'SIN_RESPONDER' });
    expect(despues.conversacion).toBeNull();
    expect(despues.contadores.sinResponder).toBe(0);
  });

  it('no sirve por esta vía una conversación que la agente no puede ver', async () => {
    const ana = await crearAgente('ana');
    const beatriz = await crearAgente('beatriz');
    const cliente = await prisma.cliente.create({
      data: { nombre: 'Ajena', telefono: '+59178888888', agenteId: beatriz.id },
    });
    const conv = await prisma.conversacion.create({
      data: { clienteId: cliente.id, agenteId: beatriz.id },
    });

    const { conversacion } = await service.resumenParaInbox(conv.id, ana.id, ana.id, {});

    expect(conversacion).toBeNull();
  });
});
