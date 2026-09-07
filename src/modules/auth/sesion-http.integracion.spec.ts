import { Controller, Get, INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsuariosService } from '../usuarios/usuarios.service';
import { UsuariosController } from '../usuarios/usuarios.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ConversacionesGateway } from '../conversaciones/conversaciones.gateway';
import { PushService } from '../../common/push/push.service';

const url = 'postgresql://crm_app:crm_dev_local@127.0.0.1:5433/crm_test';
const prisma = new PrismaService(url);
@Controller('f05')
class RecursoProtegido {
  @Get() leer(@CurrentUser() u: UsuarioJwt) { return { id: u.sub, rol: u.rol }; }
  @Get('admin') @Roles('ADMIN') administrar() { return { permitido: true }; }
}
@Module({
  imports: [JwtModule.register({ secret: 'clave-ficticia-F05-local', signOptions: { expiresIn: '8h' } })],
  controllers: [AuthController, UsuariosController, RecursoProtegido],
  providers: [AuthService, UsuariosService, ConversacionesGateway,
    { provide: PrismaService, useValue: prisma }, { provide: PushService, useValue: {} },
    { provide: APP_GUARD, useClass: JwtAuthGuard }, { provide: APP_GUARD, useClass: RolesGuard }],
})
class AplicacionSesion {}
let app: INestApplication;
let base: string;
let usuarioId: string;
const password = 'F05-password-local!';
const sockets: WebSocket[] = [];
type Credencial = { access: string; cookie: string; body: Record<string, unknown>; setCookie: string };
async function http(ruta: string, metodo = 'GET', token?: string, body?: unknown, cookie?: string) {
  const r = await fetch(base + ruta, { method: metodo, headers: {
    'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(cookie ? { Cookie: cookie } : {}),
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  return r;
}
async function login(rememberMe = true): Promise<Credencial> {
  const r = await http('/auth/login', 'POST', undefined, { email: 'usuario@f05.test', password, rememberMe });
  expect(r.status).toBe(201);
  const body = await r.json() as Record<string, unknown>;
  const setCookie = r.headers.get('set-cookie')!;
  return { access: String(body.access_token), cookie: setCookie.split(';')[0], body, setCookie };
}
async function conectar(token: string) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/socket.io/?EIO=4&transport=websocket');
  sockets.push(ws);
  const paquetes: string[] = [];
  const conexion = new Promise<string>((resolve, reject) => {
    const limite = setTimeout(() => reject(new Error('Sin respuesta al handshake de Socket.IO')), 3000);
    ws.addEventListener('error', () => { clearTimeout(limite); reject(new Error('Error WebSocket')); });
    ws.addEventListener('message', e => {
      const p = String(e.data); paquetes.push(p);
      if (p.startsWith('0')) ws.send('40/realtime,' + JSON.stringify({ token }));
      if (p === '2') ws.send('3');
      if (p.startsWith('40/realtime,') || p.startsWith('44/realtime,')) { clearTimeout(limite); resolve(p); }
    });
  });
  return { ws, paquetes, resultado: await conexion };
}
async function esperarPaquete(socket: Awaited<ReturnType<typeof conectar>>, contenido: string): Promise<void> {
  if (socket.paquetes.some(p => p.includes(contenido))) return;
  await new Promise<void>((resolve, reject) => {
    const recibir = (e: MessageEvent) => {
      if (!String(e.data).includes(contenido)) return;
      clearTimeout(limite); socket.ws.removeEventListener('message', recibir); resolve();
    };
    const limite = setTimeout(() => { socket.ws.removeEventListener('message', recibir); reject(new Error('Falta paquete ' + contenido)); }, 3000);
    socket.ws.addEventListener('message', recibir);
  });
}
beforeAll(async () => {
  app = await NestFactory.create(AplicacionSesion, { logger: false, abortOnError: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: false } }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(0, '127.0.0.1'); base = await app.getUrl();
});
beforeEach(async () => {
  await prisma.usuario.deleteMany({ where: { email: { endsWith: '@f05.test' } } });
  usuarioId = (await prisma.usuario.create({ data: { email: 'usuario@f05.test', nombre: 'F05 usuario', passwordHash: await bcrypt.hash(password, 4), rol: 'ADMIN' } })).id;
});
afterEach(() => { for (const ws of sockets.splice(0)) ws.close(); jest.restoreAllMocks(); });
afterAll(async () => { await prisma.usuario.deleteMany({ where: { email: { endsWith: '@f05.test' } } }); await app?.close(); await prisma.$disconnect(); });

it('login deja el refresh exclusivamente en cookie HttpOnly y conserva rememberMe', async () => {
  const s = await login();
  expect(s.body).not.toHaveProperty('refresh_token');
  expect(s.setCookie).toContain('HttpOnly'); expect(s.setCookie).toContain('Max-Age=2592000');
  expect((await login(false)).setCookie).not.toContain('Max-Age');
});
it('un refresh firmado no sirve como bearer', async () => {
  const s = await login();
  expect((await http('/f05', 'GET', decodeURIComponent(s.cookie.split('=')[1]))).status).toBe(401);
});
it.each([{ sub: 'inexistente' }, { sub: 'inexistente', rol: 'ADMIN', type: 'otro' }])('rechaza payload firmado incompleto o de otro propósito: %j', async payload => {
  expect((await http('/f05', 'GET', app.get(JwtService).sign(payload))).status).toBe(401);
});
it('desactivar impide HTTP y refresh; reactivar no revive las credenciales anteriores', async () => {
  const s = await login(); const usuarios = app.get(UsuariosService);
  await usuarios.desactivar(usuarioId);
  expect((await http('/f05', 'GET', s.access)).status).toBe(401);
  expect((await http('/auth/refresh', 'POST', undefined, {}, s.cookie)).status).toBe(401);
  await usuarios.update(usuarioId, { activo: true });
  expect((await http('/f05', 'GET', s.access)).status).toBe(401);
});
it('degradar un rol invalida el token administrativo anterior', async () => {
  const s = await login(); await app.get(UsuariosService).update(usuarioId, { rol: 'AGENTE' });
  expect((await http('/f05/admin', 'GET', s.access)).status).toBe(401);
  const nuevo = await login(); expect((await http('/f05/admin', 'GET', nuevo.access)).status).toBe(403);
});
it('cambiar contraseña invalida acceso y refresh anteriores', async () => {
  const s = await login(); await app.get(UsuariosService).update(usuarioId, { password: 'F05-password-nuevo!' });
  expect((await http('/f05', 'GET', s.access)).status).toBe(401);
  expect((await http('/auth/refresh', 'POST', undefined, {}, s.cookie)).status).toBe(401);
});
it('logout revoca esa sesión y conserva otra sesión del mismo usuario', async () => {
  const a = await login(); const b = await login();
  expect((await http('/auth/logout', 'POST', a.access, {}, a.cookie)).status).toBe(204);
  expect((await http('/f05', 'GET', a.access)).status).toBe(401);
  expect((await http('/auth/refresh', 'POST', undefined, {}, a.cookie)).status).toBe(401);
  expect((await http('/f05', 'GET', b.access)).status).toBe(200);
});
it('refresh vigente emite acceso utilizable y no devuelve otra credencial de refresh', async () => {
  const s = await login();
  const antes = await prisma.sesionUsuario.findMany({ where: { usuarioId } });
  const r = await http('/auth/refresh', 'POST', undefined, {}, s.cookie);
  expect(r.status).toBe(201); const body = await r.json() as Record<string, unknown>;
  expect(body).not.toHaveProperty('refresh_token'); expect((await http('/f05', 'GET', String(body.access_token))).status).toBe(200);
  expect(await prisma.sesionUsuario.findMany({ where: { usuarioId } })).toEqual(antes);
  expect(r.headers.get('set-cookie')).toBeNull();
});
it('el handshake de Socket.IO rechaza un refresh antes de aceptar la conexión', async () => {
  const s = await login(); const socket = await conectar(decodeURIComponent(s.cookie.split('=')[1]));
  expect(socket.resultado).toMatch(/^44\/realtime,/);
});
it('el socket válido conecta, pero tras desactivación no recibe nuevos eventos', async () => {
  const s = await login(); const socket = await conectar(s.access);
  expect(socket.resultado).toMatch(/^40\/realtime,/);
  app.get(ConversacionesGateway).emitirActividad('F05-evento-autorizado');
  await esperarPaquete(socket, 'F05-evento-autorizado');
  await app.get(UsuariosService).desactivar(usuarioId);
  app.get(ConversacionesGateway).emitirActividad('F05-evento-protegido');
  await esperarPaquete(socket, '41/realtime,');
  expect(socket.paquetes.some(p => p.includes('F05-evento-protegido'))).toBe(false);
});
it('expirar el access desconecta un socket ya abierto sin esperar un evento de negocio', async () => {
  const s = await login();
  const jwt = new JwtService({ secret: 'clave-ficticia-F05-local' });
  const corto = jwt.sign({ ...jwt.decode<Record<string, unknown>>(s.access), exp: Math.floor(Date.now() / 1000) + 2 });
  const socket = await conectar(corto);
  await esperarPaquete(socket, '41/realtime,');
});
it('logout impide la siguiente difusión y un nuevo handshake con la credencial revocada', async () => {
  const s = await login(); const socket = await conectar(s.access);
  await http('/auth/logout', 'POST', s.access, {}, s.cookie);
  app.get(ConversacionesGateway).emitirActividad('F05-despues-logout');
  await esperarPaquete(socket, '41/realtime,');
  expect(socket.paquetes.some(p => p.includes('F05-despues-logout'))).toBe(false);
  expect((await conectar(s.access)).resultado).toMatch(/^44\/realtime,/);
});
it('fallos de base durante HTTP o refresh son 500; la misma sesión sigue utilizable', async () => {
  const s = await login();
  const consulta = jest.spyOn(prisma.sesionUsuario, 'findUnique');
  consulta.mockRejectedValueOnce(new Error('F05 base no disponible'));
  expect((await http('/f05', 'GET', s.access)).status).toBe(500);
  consulta.mockRejectedValueOnce(new Error('F05 base no disponible'));
  expect((await http('/auth/refresh', 'POST', undefined, {}, s.cookie)).status).toBe(500);
  expect((await http('/f05', 'GET', s.access)).status).toBe(200);
});
it('fallo de base en handshake devuelve 503 y permite reconectar con la misma sesión', async () => {
  const s = await login();
  jest.spyOn(prisma.sesionUsuario, 'findUnique').mockRejectedValueOnce(new Error('F05 base no disponible'));
  const rechazado = await conectar(s.access);
  expect(rechazado.resultado).toContain('"status":503');
  expect((await conectar(s.access)).resultado).toMatch(/^40\/realtime,/);
});
it('una sesión ausente, vencida o de otro usuario no autoriza aunque la firma sea válida', async () => {
  const s = await login(); const jwt = new JwtService({ secret: 'clave-ficticia-F05-local' });
  const original = jwt.decode<Record<string, unknown>>(s.access);
  for (const cambios of [{ sid: 'no-existe' }, { sub: 'otro-usuario' }, { versionSesion: 99 }]) {
    expect((await http('/f05', 'GET', jwt.sign({ ...original, ...cambios }))).status).toBe(401);
  }
  await prisma.sesionUsuario.update({ where: { id: String(original.sid) }, data: { expiraEn: new Date(0) } });
  expect((await http('/f05', 'GET', s.access)).status).toBe(401);
});
it('logout sin cookie puede revocar mediante un access expirado y es idempotente', async () => {
  const s = await login(); const jwt = new JwtService({ secret: 'clave-ficticia-F05-local' });
  const vencido = jwt.sign({ ...jwt.decode<Record<string, unknown>>(s.access), exp: 1 });
  for (let n = 0; n < 2; n++) expect((await http('/auth/logout', 'POST', vencido, {})).status).toBe(204);
  expect((await http('/auth/refresh', 'POST', undefined, {}, s.cookie)).status).toBe(401);
});
it('logout que falla en la base responde 500, sin afirmar una revocación que no ocurrió', async () => {
  const s = await login();
  jest.spyOn(prisma.sesionUsuario, 'deleteMany').mockRejectedValueOnce(new Error('F05 base no disponible'));
  expect((await http('/auth/logout', 'POST', s.access, {}, s.cookie)).status).toBe(500);
  expect((await http('/f05', 'GET', s.access)).status).toBe(200);
  expect((await http('/auth/logout', 'POST', s.access, {}, s.cookie)).status).toBe(204);
  expect((await http('/f05', 'GET', s.access)).status).toBe(401);
});
it('logout con bearer de A y cookie de B revoca A sin borrar ni revocar B', async () => {
  const a = await login(); const b = await login();
  const salida = await http('/auth/logout', 'POST', a.access, {}, b.cookie);
  expect(salida.status).toBe(204);
  expect(salida.headers.get('set-cookie')).toBeNull();
  expect((await http('/f05', 'GET', a.access)).status).toBe(401);
  expect((await http('/f05', 'GET', b.access)).status).toBe(200);
  expect((await http('/auth/refresh', 'POST', undefined, {}, b.cookie)).status).toBe(201);
});
it('refresh con bearer de A y cookie de B no sustituye silenciosamente una sesión por otra', async () => {
  const a = await login(); const b = await login();
  expect((await http('/auth/refresh', 'POST', a.access, {}, b.cookie)).status).toBe(401);
  const jwt = new JwtService({ secret: 'clave-ficticia-F05-local' });
  const accessVencido = jwt.sign({ ...jwt.decode<Record<string, unknown>>(a.access), exp: 1 });
  expect((await http('/auth/refresh', 'POST', accessVencido, {}, a.cookie)).status).toBe(201);
  expect((await http('/f05', 'GET', b.access)).status).toBe(200);
});
