import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AllExceptionsFilter } from '../filters/all-exceptions.filter';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { PushService } from '../push/push.service';
import { R2Service } from '../storage/r2.service';
import { AuthController } from '../../modules/auth/auth.controller';
import { AuthService } from '../../modules/auth/auth.service';
import { UsuariosController } from '../../modules/usuarios/usuarios.controller';
import { UsuariosService } from '../../modules/usuarios/usuarios.service';
import { ClientesController } from '../../modules/clientes/clientes.controller';
import { ClientesService } from '../../modules/clientes/clientes.service';
import { ServiciosService } from '../../modules/servicios/servicios.service';
import { ActividadesController } from '../../modules/actividades/actividades.controller';
import { ActividadesService } from '../../modules/actividades/actividades.service';
import { VentasController } from '../../modules/ventas/ventas.controller';
import { VentasService } from '../../modules/ventas/ventas.service';
import { LeadsController } from '../../modules/leads/leads.controller';
import { LeadsService } from '../../modules/leads/leads.service';
import { ConversacionesController } from '../../modules/conversaciones/conversaciones.controller';
import { ConversacionesService } from '../../modules/conversaciones/conversaciones.service';
import { ConversacionesGateway } from '../../modules/conversaciones/conversaciones.gateway';
import { WhatsappCloudService } from '../whatsapp/whatsapp-cloud.service';
import { DespachadorSalienteService } from '../../modules/conversaciones/despachador-saliente.service';
import { CatalogoClinicoService } from '../../modules/planilla-comisiones/catalogo-clinico.service';

const url = process.env['DATABASE_URL_TEST'] ?? 'postgresql://crm_app:crm_dev_local@127.0.0.1:5433/crm_test';
const destino = new URL(url);
if (destino.pathname !== '/crm_test' || !['localhost', '127.0.0.1', '[::1]'].includes(destino.hostname)) {
  throw new Error('F04 solo permite crm_test en loopback');
}
const prisma = new PrismaService(url);
const password = 'Prueba-F04-local!';
const sufijo = '@f04.test';
const telefonos = { startsWith: '+59170004' };

/** Transporte Nest real. Solo las salidas externas no usadas tienen dobles. */
@Module({
  imports: [JwtModule.register({ secret: 'secreto-ficticio-f04-solo-tests', signOptions: { expiresIn: '15m' } })],
  controllers: [AuthController, UsuariosController, ClientesController, ActividadesController, VentasController, LeadsController, ConversacionesController],
  providers: [
    { provide: PrismaService, useValue: prisma }, AuditService, AuthService, UsuariosService,
    ClientesService, ServiciosService, ActividadesService, VentasService, LeadsService,
    ConversacionesService, CatalogoClinicoService,
    { provide: R2Service, useValue: {} }, { provide: PushService, useValue: {} },
    { provide: WhatsappCloudService, useValue: {} }, { provide: DespachadorSalienteService, useValue: {} },
    { provide: ConversacionesGateway, useValue: { emitirActividad: () => undefined } },
    { provide: APP_GUARD, useClass: JwtAuthGuard }, { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
class ModuloAutorizacionHttp {}

let app: INestApplication;
let base: string;
let hash: string;
let ids: { agente: string; otro: string; admin: string; super: string; inactivo: string };
let tokens: Record<keyof typeof ids, string>;
let clientes: { propio: string; ajeno: string; pool: string; otroPropio: string };
let actividad: string;
let lead: string;
let chat: string;

async function limpiar() {
  const usuarios = await prisma.usuario.findMany({ where: { email: { endsWith: sufijo } }, select: { id: true } });
  await prisma.venta.deleteMany({ where: { cliente: { telefono: telefonos } } });
  await prisma.cliente.deleteMany({ where: { telefono: telefonos } });
  await prisma.auditLog.deleteMany({ where: { usuarioId: { in: usuarios.map(u => u.id) } } });
  await prisma.usuario.deleteMany({ where: { email: { endsWith: sufijo } } });
}

async function http(rol: keyof typeof ids | null, metodo: string, ruta: string, cuerpo?: unknown) {
  const r = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(rol ? { Authorization: `Bearer ${tokens[rol]}` } : {}) },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const body = r.headers.get('content-type')?.includes('application/json')
    ? await r.json() as Record<string, unknown>
    : { texto: await r.text() };
  return { status: r.status, body };
}

async function foto() {
  const where = { cliente: { telefono: telefonos } };
  return {
    clientes: await prisma.cliente.findMany({ where: { telefono: telefonos }, orderBy: { id: 'asc' } }),
    leads: await prisma.lead.findMany({ where, orderBy: { id: 'asc' } }),
    conversaciones: await prisma.conversacion.findMany({ where, orderBy: { id: 'asc' } }),
    actividades: await prisma.actividad.findMany({ where, orderBy: { id: 'asc' } }),
    ventas: await prisma.venta.findMany({ where, orderBy: { id: 'asc' } }),
    intereses: await prisma.interes.findMany({ where, orderBy: { id: 'asc' } }),
    auditoria: await prisma.auditLog.findMany({ where: { usuarioId: { in: Object.values(ids) } }, orderBy: { id: 'asc' } }),
  };
}

async function rechazada(rol: keyof typeof ids, metodo: string, ruta: string, cuerpo: unknown, status: number) {
  const antes = await foto();
  const respuesta = await http(rol, metodo, ruta, cuerpo);
  expect(respuesta.status).toBe(status);
  expect(await foto()).toEqual(antes);
}

beforeAll(async () => {
  await prisma.$connect();
  hash = await bcrypt.hash(password, 4);
  app = await NestFactory.create(ModuloAutorizacionHttp, { logger: false, abortOnError: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: false } }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
}, 30_000);

beforeEach(async () => {
  await limpiar();
  const usuarios = await Promise.all((['agente', 'otro', 'admin', 'super', 'inactivo'] as const).map(nombre =>
    prisma.usuario.create({ data: {
      nombre: `F04 ${nombre}`, email: nombre + sufijo, passwordHash: hash,
      rol: nombre === 'super' ? 'SUPER_ADMIN' : nombre === 'admin' ? 'ADMIN' : 'AGENTE',
      activo: nombre !== 'inactivo', codigo: 'F04-' + nombre,
    } })));
  ids = { agente: usuarios[0].id, otro: usuarios[1].id, admin: usuarios[2].id, super: usuarios[3].id, inactivo: usuarios[4].id };
  // F05 exige una sesión persistida: las credenciales salen del login real.
  tokens = Object.fromEntries(await Promise.all(usuarios.map(async u => [
    u.email.split('@')[0], u.activo ? (await app.get(AuthService).login({ email: u.email, password })).access_token : '',
  ]))) as typeof tokens;
  const creacion = async (nombre: string, n: number, agenteId: string | null) =>
    prisma.cliente.create({ data: { nombre: 'F04 ' + nombre, telefono: '+5917000400' + n, agenteId } });
  const propios = await Promise.all([creacion('propio', 1, ids.agente), creacion('ajeno', 2, ids.otro), creacion('pool', 3, null), creacion('otro propio', 4, ids.agente)]);
  clientes = { propio: propios[0].id, ajeno: propios[1].id, pool: propios[2].id, otroPropio: propios[3].id };
  lead = (await prisma.lead.create({ data: { clienteId: clientes.propio, agenteId: ids.agente, origen: 'PRESENCIAL' } })).id;
  chat = (await prisma.conversacion.create({ data: { clienteId: clientes.propio, agenteId: ids.agente } })).id;
  actividad = (await prisma.actividad.create({ data: {
    clienteId: clientes.propio, agenteId: ids.agente, leadId: lead,
    tipo: 'TAREA', titulo: 'F04 tarea', fechaProgramada: new Date('2033-01-01T12:00:00Z'),
  } })).id;
});

afterAll(async () => { await limpiar(); await app?.close(); await prisma.$disconnect(); });

describe('F04 · identidad y gestión administrativa', () => {
  it('sin JWT no accede al perfil', async () => {
    expect((await http(null, 'GET', '/auth/perfil')).status).toBe(401);
  });
  it('rechaza un JWT firmado con otra clave', async () => {
    tokens.agente = new JwtService({ secret: 'otra-clave-ficticia' }).sign({ sub: ids.agente, rol: 'AGENTE' });
    await rechazada('agente', 'PATCH', `/clientes/${clientes.propio}`, { nombre: 'F04 intrusión' }, 401);
  });

  it.each(['agente', 'admin', 'super'] as const)('%s no modifica codigo, rol ni activo por perfil; sí su nombre', async rol => {
    const antes = await prisma.usuario.findUniqueOrThrow({ where: { id: ids[rol] } });
    const r = await http(rol, 'PATCH', '/auth/perfil', { nombre: 'F04 perfil editado', codigo: 'F04-intruso', rol: 'SUPER_ADMIN', activo: false });
    expect(r.status).toBe(200);
    const final = await prisma.usuario.findUniqueOrThrow({ where: { id: ids[rol] } });
    expect(final.nombre).toBe('F04 perfil editado');
    expect(final.codigo).toBe(antes.codigo);
    expect(final.rol).toBe(antes.rol);
    expect(final.activo).toBe(antes.activo);
  });

  it('ADMIN no puede gestionar codigo; SUPER_ADMIN sí por Usuarios', async () => {
    expect((await http('admin', 'PATCH', `/usuarios/${ids.otro}`, { codigo: 'F04-autorizado' })).status).toBe(403);
    expect((await http('super', 'PATCH', `/usuarios/${ids.otro}`, { codigo: 'F04-autorizado' })).status).toBe(200);
    expect((await prisma.usuario.findUniqueOrThrow({ where: { id: ids.otro } })).codigo).toBe('F04-autorizado');
  });

  it('login rechaza al usuario inactivo aunque la contraseña sea válida', async () => {
    expect((await http(null, 'POST', '/auth/login', { email: 'inactivo' + sufijo, password })).status).toBe(401);
  });

  it('el login real emite un JWT que atraviesa los guards del perfil', async () => {
    const login = await http(null, 'POST', '/auth/login', { email: 'agente' + sufijo, password });
    expect(login.status).toBe(201);
    tokens.agente = String(login.body.access_token);
    expect((await http('agente', 'GET', '/auth/perfil')).body.id).toBe(ids.agente);
  });
});

describe('F04 · ficha y asignación comercial', () => {
  it('agente no edita la ficha ajena', async () => {
    await rechazada('agente', 'PATCH', `/clientes/${clientes.ajeno}`, { nombre: 'F04 cambio' }, 404);
  });
  it.each(['otro', null] as const)('agente no reasigna ni desasigna por PATCH de ficha: %s', async destino => {
    await rechazada('agente', 'PATCH', `/clientes/${clientes.propio}`, { nombre: 'F04 cambio', agenteId: destino ? ids[destino] : null }, 403);
  });
  it('agente no reclama manualmente el pool por PATCH de ficha', async () => {
    await rechazada('agente', 'PATCH', `/clientes/${clientes.pool}`, { agenteId: ids.agente }, 403);
  });
  it.each(['admin', 'super'] as const)('%s reasigna cliente, leads y conversación de manera coherente', async rol => {
    expect((await http(rol, 'PATCH', `/clientes/${clientes.propio}`, { agenteId: ids.otro })).status).toBe(200);
    expect((await prisma.cliente.findUniqueOrThrow({ where: { id: clientes.propio } })).agenteId).toBe(ids.otro);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead } })).agenteId).toBe(ids.otro);
    expect((await prisma.conversacion.findUniqueOrThrow({ where: { id: chat } })).agenteId).toBe(ids.otro);
  });
  it('el formulario de ficha puede reenviar el mismo agente sin ejecutar una reasignación', async () => {
    await prisma.cliente.update({ where: { id: clientes.propio }, data: { agenteId: null } });
    await prisma.lead.update({ where: { id: lead }, data: { agenteId: ids.otro } });
    expect((await http('agente', 'PATCH', `/clientes/${clientes.propio}`, { nombre: 'F04 edición legítima', agenteId: ids.agente })).status).toBe(200);
    expect((await prisma.cliente.findUniqueOrThrow({ where: { id: clientes.propio } })).agenteId).toBeNull();
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead } })).agenteId).toBe(ids.otro);
  });
  it('ADMIN no asigna una ficha a un destinatario inactivo', async () => {
    await rechazada('admin', 'PATCH', `/clientes/${clientes.propio}`, { agenteId: ids.inactivo }, 404);
  });
  it('ADMIN puede desasignar cliente, leads y conversación al pool', async () => {
    expect((await http('admin', 'PATCH', `/clientes/${clientes.propio}`, { agenteId: null })).status).toBe(200);
    expect((await prisma.cliente.findUniqueOrThrow({ where: { id: clientes.propio } })).agenteId).toBeNull();
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead } })).agenteId).toBeNull();
    expect((await prisma.conversacion.findUniqueOrThrow({ where: { id: chat } })).agenteId).toBeNull();
  });
  it('agente puede editar la ficha del pool reenviando agenteId null', async () => {
    expect((await http('agente', 'PATCH', `/clientes/${clientes.pool}`, { nombre: 'F04 pool editado', agenteId: null })).status).toBe(200);
    expect((await prisma.cliente.findUniqueOrThrow({ where: { id: clientes.pool } })).agenteId).toBeNull();
  });
  it('ADMIN crea un paciente para un agente activo, pero no para uno inactivo', async () => {
    const datos = { nombre: 'F04 alta asignada', telefono: '+59170004005' };
    await rechazada('admin', 'POST', '/clientes', { ...datos, agenteId: ids.inactivo }, 404);
    const r = await http('admin', 'POST', '/clientes', { ...datos, agenteId: ids.otro });
    expect(r.status).toBe(201); expect(r.body.agenteId).toBe(ids.otro);
  });
  it('agente no asigna a otra persona al crear paciente', async () => {
    await rechazada('agente', 'POST', '/clientes', { nombre: 'F04 nueva', telefono: '+59170004005', agenteId: ids.otro }, 403);
  });
  it('el alta de paciente permite pool y asignación inicial propia', async () => {
    expect((await http('agente', 'POST', '/clientes', { nombre: 'F04 nueva', telefono: '+59170004005' })).status).toBe(201);
    expect((await http('agente', 'POST', '/clientes', { nombre: 'F04 propia', telefono: '+59170004006', agenteId: ids.agente })).status).toBe(201);
  });
  it.each(['leads', 'conversaciones'] as const)('la ruta específica %s/:id/agente exige ADMIN y destinatario activo', async recurso => {
    const ruta = `/${recurso}/${recurso === 'leads' ? lead : chat}/agente`;
    await rechazada('agente', 'PATCH', ruta, { agenteId: ids.otro }, 403);
    await rechazada('admin', 'PATCH', ruta, { agenteId: ids.inactivo }, 404);
    expect((await http('admin', 'PATCH', ruta, { agenteId: ids.otro })).status).toBe(200);
  });
});

describe('F04 · actividades y destino de relaciones', () => {
  const datos = { tipo: 'TAREA', titulo: 'F04 seguimiento', fechaProgramada: '2033-01-02T12:00:00Z' };
  it('create y update rechazan el mismo cliente ajeno', async () => {
    await rechazada('agente', 'POST', '/actividades', { ...datos, clienteId: clientes.ajeno }, 404);
    await rechazada('agente', 'PATCH', `/actividades/${actividad}`, { clienteId: clientes.ajeno }, 404);
  });
  it('no cambia una actividad de otra agente', async () => {
    await rechazada('otro', 'PATCH', `/actividades/${actividad}`, { titulo: 'F04 intrusión' }, 404);
  });
  it('cambiar cliente no conserva silenciosamente un lead del cliente anterior', async () => {
    await rechazada('agente', 'PATCH', `/actividades/${actividad}`, { clienteId: clientes.otroPropio }, 404);
  });
  it('permite cambiar a cliente accesible si se retira explícitamente el lead anterior', async () => {
    const r = await http('agente', 'PATCH', `/actividades/${actividad}`, { clienteId: clientes.otroPropio, leadId: null });
    expect(r.status).toBe(200); expect(r.body.clienteId).toBe(clientes.otroPropio); expect(r.body.leadId).toBeNull();
  });
  it('ADMIN puede cambiar a otro cliente con su lead correspondiente', async () => {
    const nuevoLead = await prisma.lead.create({ data: { clienteId: clientes.ajeno, agenteId: ids.otro, origen: 'PRESENCIAL' } });
    const r = await http('admin', 'PATCH', `/actividades/${actividad}`, { clienteId: clientes.ajeno, leadId: nuevoLead.id });
    expect(r.status).toBe(200); expect(r.body.leadId).toBe(nuevoLead.id);
  });
  it('ADMIN no agenda para un usuario inactivo', async () => {
    await rechazada('admin', 'POST', '/actividades', { ...datos, clienteId: clientes.propio, agenteId: ids.inactivo }, 404);
  });
  it('agenteId ajeno en alta de actividad no sustituye al dueño fijado por JWT', async () => {
    const r = await http('agente', 'POST', '/actividades', { ...datos, clienteId: clientes.propio, agenteId: ids.otro });
    expect(r.status).toBe(201); expect(r.body.agenteId).toBe(ids.agente);
  });
  it('agenda propia permite editar título tras reasignar paciente, pero no cambiar sus relaciones sin alcance', async () => {
    await prisma.cliente.update({ where: { id: clientes.propio }, data: { agenteId: ids.otro } });
    expect((await http('agente', 'PATCH', `/actividades/${actividad}`, { titulo: 'F04 seguimiento previo' })).status).toBe(200);
    await rechazada('agente', 'PATCH', `/actividades/${actividad}`, { leadId: null }, 404);
  });
  it('create y update rechazan un lead de otro cliente aunque ambos clientes sean accesibles', async () => {
    const otroLead = await prisma.lead.create({ data: { clienteId: clientes.otroPropio, agenteId: ids.agente, origen: 'PRESENCIAL' } });
    await rechazada('agente', 'POST', '/actividades', { ...datos, clienteId: clientes.propio, leadId: otroLead.id }, 404);
    await rechazada('agente', 'PATCH', `/actividades/${actividad}`, { leadId: otroLead.id }, 404);
  });
  it('ValidationPipe rechaza fechas y enums inválidos antes de escribir', async () => {
    await rechazada('agente', 'POST', '/actividades', { ...datos, tipo: 'INEXISTENTE', fechaProgramada: 'incorrecta', clienteId: clientes.propio }, 400);
  });
});

describe('F04 · operaciones sobre pacientes', () => {
  it.each(['intereses', 'recalcular-categoria'])('%s rechaza el mismo paciente ajeno que GET', async comando => {
    expect((await http('agente', 'GET', `/clientes/${clientes.ajeno}`)).status).toBe(404);
    await rechazada('agente', 'POST', `/clientes/${clientes.ajeno}/${comando}`, { descripcion: 'F04 consulta', origen: 'PRESENCIAL' }, 404);
  });
  it('una agente no atribuye un interés a otra persona', async () => {
    await rechazada('agente', 'POST', `/clientes/${clientes.propio}/intereses`, { descripcion: 'F04 consulta', origen: 'PRESENCIAL', agenteId: ids.otro }, 403);
  });
  it('ADMIN atribuye intereses a usuarios activos; se conserva la atribución propia y la omitida', async () => {
    const ruta = `/clientes/${clientes.propio}/intereses`;
    const datos = { descripcion: 'F04 consulta', origen: 'PRESENCIAL' };
    await rechazada('admin', 'POST', ruta, { ...datos, agenteId: ids.inactivo }, 404);
    expect((await http('admin', 'POST', ruta, { ...datos, agenteId: ids.otro })).body.agenteId).toBe(ids.otro);
    expect((await http('agente', 'POST', ruta, { ...datos, agenteId: ids.agente })).body.agenteId).toBe(ids.agente);
    expect((await http('agente', 'POST', ruta, datos)).body.agenteId).toBeNull();
  });
  it.each(['propio', 'pool'] as const)('permite registrar interés y recalcular categoría de paciente %s', async tipo => {
    expect((await http('agente', 'POST', `/clientes/${clientes[tipo]}/intereses`, { descripcion: 'F04 consulta', origen: 'PRESENCIAL' })).status).toBe(201);
    expect((await http('agente', 'POST', `/clientes/${clientes[tipo]}/recalcular-categoria`, {})).status).toBe(201);
  });
  it('ventas rechaza paciente ajeno antes de crear venta o convertir leads', async () => {
    await rechazada('agente', 'POST', '/ventas', { clienteId: clientes.ajeno, producto: 'F04 consulta', monto: 100 }, 404);
  });
  it('ventas mantiene la pertenencia del lead al cliente y la identidad del vendedor del JWT', async () => {
    const datos = { clienteId: clientes.otroPropio, producto: 'F04 consulta', monto: 100 };
    await rechazada('agente', 'POST', '/ventas', { ...datos, leadId: lead }, 400);
    const r = await http('agente', 'POST', '/ventas', { ...datos, agenteId: ids.otro });
    expect(r.status).toBe(201); expect(r.body.agenteId).toBe(ids.agente);
  });
  it('el respaldo de dueño en Conversación también protege comandos sobre un cliente sin agente directo', async () => {
    await prisma.cliente.update({ where: { id: clientes.propio }, data: { agenteId: null } });
    await rechazada('otro', 'POST', '/ventas', { clienteId: clientes.propio, producto: 'F04 consulta', monto: 100 }, 404);
    await rechazada('otro', 'POST', `/clientes/${clientes.propio}/intereses`, { descripcion: 'F04 consulta', origen: 'PRESENCIAL' }, 404);
    await rechazada('otro', 'POST', '/leads/presencial', { nombre: 'F04 paciente', telefono: '+59170004001' }, 404);
  });
  it.each(['agente', 'admin', 'super'] as const)('%s puede registrar una venta en su alcance', async rol => {
    const clienteId = rol === 'agente' ? clientes.propio : clientes.ajeno;
    const r = await http(rol, 'POST', '/ventas', { clienteId, producto: 'F04 consulta', monto: 100 });
    expect(r.status).toBe(201); expect(r.body.agenteId).toBe(ids[rol]);
  });
  it('cambiar estado de una venta sigue reservado a ADMIN', async () => {
    const venta = await http('agente', 'POST', '/ventas', { clienteId: clientes.propio, producto: 'F04 consulta', monto: 100 });
    const ruta = `/ventas/${String(venta.body.id)}/estado`;
    await rechazada('agente', 'PATCH', ruta, { estado: 'PERDIDA', motivoPerdida: 'F04 cancelación' }, 403);
    expect((await http('admin', 'PATCH', ruta, { estado: 'PERDIDA', motivoPerdida: 'F04 cancelación' })).status).toBe(200);
  });
  it('presencial no abre una puerta hacia un paciente ajeno buscándolo por teléfono', async () => {
    await rechazada('agente', 'POST', '/leads/presencial', { nombre: 'F04 paciente', telefono: '+59170004002', interes: 'F04 consulta' }, 404);
  });
  it.each(['agente', 'admin'] as const)('presencial permite paciente accesible para %s', async rol => {
    const telefono = rol === 'agente' ? '+59170004003' : '+59170004002';
    expect((await http(rol, 'POST', '/leads/presencial', { nombre: 'F04 paciente', telefono, interes: 'F04 consulta' })).status).toBe(201);
  });
  it('presencial crea paciente nuevo, lead e interés con el actor autenticado', async () => {
    const r = await http('agente', 'POST', '/leads/presencial', { nombre: 'F04 nueva', telefono: '+59170004005', interes: 'F04 consulta', agenteId: ids.otro });
    expect(r.status).toBe(201);
    const nuevo = await prisma.cliente.findUniqueOrThrow({ where: { telefono: '+59170004005' }, include: { leads: true, intereses: true } });
    expect(nuevo.agenteId).toBe(ids.agente);
    expect(nuevo.leads.map(l => l.agenteId)).toEqual([ids.agente]);
    expect(nuevo.intereses.map(i => i.agenteId)).toEqual([ids.agente]);
  });
});
