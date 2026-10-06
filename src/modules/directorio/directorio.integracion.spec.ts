import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';

import { AuditService } from '../../common/audit/audit.service';
import { AvisoLandingService, EtiquetaLanding } from '../../common/landing/aviso-landing.service';
import { fechaCivilClinica, textoDeFechaCivil } from '../../common/fechas/zona-clinica';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { imagenSintetica } from '../../common/storage/imagen-sintetica';
import { R2Service } from '../../common/storage/r2.service';
import { Rol } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { UsuariosService } from '../usuarios/usuarios.service';
import { DirectorioPublicoController } from './directorio-publico.controller';
import { DirectorioController } from './directorio.controller';
import { DirectorioService } from './directorio.service';

/*
 * Directorio médico de punta a punta: HTTP con los guards reales, Postgres real
 * y un R2 en memoria (docs/promociones-y-directorio.md).
 */

// URL deliberadamente fija; nunca usar DATABASE_URL ni cargar .env en esta suite.
const prisma = new PrismaService('postgresql://crm_app@127.0.0.1:5433/crm_test');

const almacen = new Map<string, { bytes: Uint8Array; mime: string }>();
const r2 = {
  habilitado: true,
  async subir(clave: string, cuerpo: ArrayBuffer, mime: string) { almacen.set(clave, { bytes: new Uint8Array(cuerpo), mime }); },
  async leer(clave: string) {
    const o = almacen.get(clave);
    return o ? { cuerpo: new Blob([Uint8Array.from(o.bytes)]).stream(), tipo: o.mime, bytes: o.bytes.byteLength } : null;
  },
  async eliminar(clave: string) { almacen.delete(clave); },
  async urlFirmada(clave: string) { return `https://r2.invalid/${clave}?firmada`; },
};

/** Los avisos que recibiría la landing, en orden. */
const avisos: EtiquetaLanding[][] = [];
const landing: Pick<AvisoLandingService, 'avisar'> = { avisar: (...etiquetas) => void avisos.push(etiquetas) };

@Module({
  imports: [JwtModule.register({ secret: 'jwt-sintetico-directorio', signOptions: { expiresIn: '15m' } })],
  controllers: [DirectorioController, DirectorioPublicoController],
  providers: [
    { provide: PrismaService, useValue: prisma },
    AuditService, AuthService, UsuariosService, DirectorioService,
    { provide: R2Service, useValue: r2 },
    { provide: AvisoLandingService, useValue: landing },
    { provide: APP_GUARD, useClass: JwtAuthGuard }, { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
class ModuloDirectorioTest {}

const SUFIJO = '@directorio.test';
const PREFIJO = 'Prueba Dir';
let app: INestApplication;
let base: string;
const usuarios: Record<'admin' | 'agente' | 'recepcion', { id: string; token: string }> = {} as never;

const dia = (desplazamiento: number) => textoDeFechaCivil(new Date(fechaCivilClinica(new Date()).getTime() + desplazamiento * 86_400_000));

async function http(ruta: string, metodo = 'GET', bearer?: string, cuerpo?: unknown) {
  const r = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  return { status: r.status, body: (texto ? JSON.parse(texto) : {}) as Record<string, unknown> };
}
async function subirFoto(id: string, imagen: Buffer) {
  const form = new FormData();
  form.append('archivo', new Blob([Uint8Array.from(imagen)], { type: 'image/jpeg' }), 'foto.jpg');
  const r = await fetch(`${base}/directorio/medicos/${id}/foto`, { method: 'POST', headers: { Authorization: `Bearer ${usuarios.admin.token}` }, body: form });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
async function especialidad(nombre: string) {
  const r = await http('/directorio/especialidades', 'POST', usuarios.admin.token, { nombre: `${PREFIJO} ${nombre}` });
  expect(r.status).toBe(201);
  return r.body as { id: string; slug: string };
}

async function limpiar() {
  const ids = (await prisma.usuario.findMany({ where: { email: { endsWith: SUFIJO } }, select: { id: true } })).map(u => u.id);
  await prisma.auditLog.deleteMany({ where: { usuarioId: { in: ids } } });
  await prisma.perfilMedico.deleteMany({ where: { nombrePublico: { startsWith: PREFIJO } } });
  await prisma.especialidad.deleteMany({ where: { nombre: { startsWith: PREFIJO } } });
  await prisma.medico.deleteMany({ where: { codigo: { startsWith: 'PRUEBADIR' } } });
  await prisma.usuario.deleteMany({ where: { id: { in: ids } } });
  almacen.clear();
}

beforeAll(async () => {
  await limpiar();
  app = await NestFactory.create(ModuloDirectorioTest, { logger: false, abortOnError: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  for (const [clave, rol] of [['admin', 'ADMIN'], ['agente', 'AGENTE'], ['recepcion', 'RECEPCION']] as [keyof typeof usuarios, Rol][]) {
    const u = await prisma.usuario.create({ data: { nombre: `Persona ${clave}`, email: `${clave}${SUFIJO}`, passwordHash: await bcrypt.hash('sintetico', 4), rol, activo: true } });
    usuarios[clave] = { id: u.id, token: (await app.get(AuthService).login({ email: u.email, password: 'sintetico' })).access_token };
  }
}, 30_000);

afterAll(async () => {
  await limpiar();
  await app?.close();
  await prisma.$disconnect();
});

describe('especialidades', () => {
  it('administración las crea con slug estable; nombres repetidos dan 409; las agentes no las tocan', async () => {
    const gine = await especialidad('Ginecología');
    expect(gine.slug).toBe('prueba-dir-ginecologia');
    expect((await http('/directorio/especialidades', 'POST', usuarios.admin.token, { nombre: `${PREFIJO} Ginecología` })).status).toBe(409);
    expect((await http('/directorio/especialidades', 'POST', usuarios.agente.token, { nombre: `${PREFIJO} Otra` })).status).toBe(403);
    expect((await http('/directorio/especialidades', 'GET', usuarios.recepcion.token)).status).toBe(200);
  });
});

describe('fichas de médicos', () => {
  it('se enlaza al médico de la planilla una sola vez; sin-ficha deja de listarlo', async () => {
    const medico = await prisma.medico.create({ data: { codigo: 'PRUEBADIR1', nombre: 'Rojas Claudia' } });
    const sinFicha = async () => ((await http('/directorio/medicos/sin-ficha?buscar=PRUEBADIR&limite=100', 'GET', usuarios.admin.token)).body['datos'] as { id: string }[]).map(m => m.id);
    expect(await sinFicha()).toContain(medico.id);

    const ficha = await http('/directorio/medicos', 'POST', usuarios.admin.token, { nombrePublico: `${PREFIJO} Dra. Claudia Rojas`, medicoId: medico.id });
    expect(ficha.status).toBe(201);
    expect(ficha.body).toMatchObject({ publicado: false, medico: { codigo: 'PRUEBADIR1' }, resumenHorario: 'Con cita a solicitud' });
    expect(await sinFicha()).not.toContain(medico.id);
    expect((await http('/directorio/medicos', 'POST', usuarios.admin.token, { nombrePublico: `${PREFIJO} Duplicada`, medicoId: medico.id })).status).toBe(409);

    /* Dos fichas con el mismo nombre conviven: el slug se desambigua. */
    const homonima = await http('/directorio/medicos', 'POST', usuarios.admin.token, { nombrePublico: `${PREFIJO} Dra. Claudia Rojas` });
    expect(homonima.body['slug']).toBe(`${ficha.body['slug']}-2`);
  });

  it('horario: rechaza solapes, se guarda entero, se resume en una frase y respeta la versión', async () => {
    const ficha = (await http('/directorio/medicos', 'POST', usuarios.admin.token, { nombrePublico: `${PREFIJO} Dr. Horario` })).body;
    const version = ficha['version'] as number;
    const solapado = await http(`/directorio/medicos/${ficha['id']}/horario`, 'PUT', usuarios.admin.token, {
      version, bloques: [{ diaSemana: 1, desde: '08:00', hasta: '12:00' }, { diaSemana: 1, desde: '11:00', hasta: '13:00' }],
    });
    expect(solapado.status).toBe(400);
    expect(JSON.stringify(solapado.body['message'])).toMatch(/superponen/);

    const semana = [1, 2, 3, 4, 5].map(d => ({ diaSemana: d, desde: '08:00', hasta: '12:00', lugar: 'Consultorio 3' }));
    const guardado = await http(`/directorio/medicos/${ficha['id']}/horario`, 'PUT', usuarios.admin.token, { version, bloques: [...semana, { diaSemana: 6, desde: '09:00', hasta: '12:00' }] });
    expect(guardado.status).toBe(200);
    expect(guardado.body['resumenHorario']).toBe('Lunes a viernes, 08:00–12:00 · sábado, 09:00–12:00');
    expect(guardado.body['horario']).toHaveLength(6);

    /* Con la versión vieja, 409: alguien guardó entretanto. */
    const viejo = await http(`/directorio/medicos/${ficha['id']}/horario`, 'PUT', usuarios.admin.token, { version, bloques: [] });
    expect(viejo.status).toBe(409);
    expect(await prisma.horarioMedico.count({ where: { perfilMedicoId: ficha['id'] as string } })).toBe(6);
    expect((await http(`/directorio/medicos/${ficha['id']}/horario`, 'PUT', usuarios.agente.token, { version: version + 1, bloques: [] })).status).toBe(403);
  });

  it('publicar exige una especialidad; lo publicado aparece en el directorio público, lo oculto no', async () => {
    const gine = await especialidad('Obstetricia');
    const ficha = (await http('/directorio/medicos', 'POST', usuarios.admin.token, { nombrePublico: `${PREFIJO} Dra. Pública` })).body;
    expect((await http(`/directorio/medicos/${ficha['id']}/publicacion`, 'PUT', usuarios.admin.token, { publicado: true })).status).toBe(400);
    avisos.length = 0;
    const conEspecialidad = await http(`/directorio/medicos/${ficha['id']}`, 'PATCH', usuarios.admin.token, {
      version: ficha['version'], especialidadIds: [gine.id], resumen: 'Control prenatal y parto humanizado', precioConsulta: 250, matricula: 'MAT-123',
    });
    expect(conEspecialidad.status).toBe(200);
    expect(avisos).toEqual([]); // una ficha oculta no le interesa a la landing
    expect((await http(`/directorio/medicos/${ficha['id']}/publicacion`, 'PUT', usuarios.admin.token, { publicado: true })).body['publicado']).toBe(true);
    expect(avisos).toEqual([['directorio', 'promociones']]);
    const oculta = (await http('/directorio/medicos', 'POST', usuarios.admin.token, { nombrePublico: `${PREFIJO} Dra. Oculta`, especialidadIds: [gine.id] })).body;

    const publicos = await http(`/publico/directorio/medicos?especialidad=${gine.slug}`);
    const nombres = (publicos.body['datos'] as { nombre: string }[]).map(m => m.nombre);
    expect(nombres).toContain(`${PREFIJO} Dra. Pública`);
    expect(nombres).not.toContain(`${PREFIJO} Dra. Oculta`);
    const tarjeta = (publicos.body['datos'] as Record<string, unknown>[]).find(m => m['nombre'] === `${PREFIJO} Dra. Pública`)!;
    expect(tarjeta).toMatchObject({ precioConsulta: 250, especialidades: [{ slug: gine.slug }], resumenHorario: 'Con cita a solicitud' });
    for (const interno of ['id', 'version', 'medico', 'publicado', 'fotoClave']) expect(tarjeta).not.toHaveProperty(interno);
    expect((await http(`/publico/directorio/medicos/${oculta['slug']}`)).status).toBe(404);

    const especialidades = (await http('/publico/directorio/especialidades?limite=100')).body['datos'] as { slug: string; medicos: number }[];
    expect(especialidades.find(e => e.slug === gine.slug)?.medicos).toBe(1);

    /* Una ficha publicada no se queda sin especialidad. */
    const version = (await http(`/directorio/medicos/${ficha['id']}`, 'GET', usuarios.admin.token)).body['version'];
    expect((await http(`/directorio/medicos/${ficha['id']}`, 'PATCH', usuarios.admin.token, { version, especialidadIds: [] })).status).toBe(400);
  });

  it('ausencias: las pasadas se rechazan; las futuras salen en la ficha pública', async () => {
    const esp = await especialidad('Pediatría');
    const ficha = (await http('/directorio/medicos', 'POST', usuarios.admin.token, { nombrePublico: `${PREFIJO} Dr. Ausente`, especialidadIds: [esp.id] })).body;
    await http(`/directorio/medicos/${ficha['id']}/publicacion`, 'PUT', usuarios.admin.token, { publicado: true });
    expect((await http(`/directorio/medicos/${ficha['id']}/ausencias`, 'POST', usuarios.admin.token, { desde: dia(-5), hasta: dia(-2) })).status).toBe(400);
    expect((await http(`/directorio/medicos/${ficha['id']}/ausencias`, 'POST', usuarios.admin.token, { desde: dia(9), hasta: dia(3) })).status).toBe(400);
    const ausencia = await http(`/directorio/medicos/${ficha['id']}/ausencias`, 'POST', usuarios.admin.token, { desde: dia(3), hasta: dia(9), motivoPublico: 'Congreso' });
    expect(ausencia.status).toBe(201);
    const publica = await http(`/publico/directorio/medicos/${ficha['slug']}`);
    expect(publica.body['ausencias']).toEqual([{ desde: dia(3), hasta: dia(9), motivo: 'Congreso' }]);
    /* También en el listado: la landing no ofrece a la paciente un día en que el médico no está. */
    const listado = (await http(`/publico/directorio/medicos?especialidad=${esp.slug}`)).body['datos'] as Record<string, unknown>[];
    expect(listado.find(m => m['slug'] === ficha['slug'])?.['ausencias']).toEqual([{ desde: dia(3), hasta: dia(9), motivo: 'Congreso' }]);
    expect((await http(`/directorio/medicos/${ficha['id']}/ausencias/${ausencia.body['id']}`, 'DELETE', usuarios.admin.token)).status).toBe(204);
    expect((await http(`/publico/directorio/medicos/${ficha['slug']}`)).body['ausencias']).toEqual([]);
  });

  it('foto: se valida, se sirve solo si la ficha está publicada y reemplazarla borra la anterior', async () => {
    const esp = await especialidad('Dermatología');
    const ficha = (await http('/directorio/medicos', 'POST', usuarios.admin.token, { nombrePublico: `${PREFIJO} Dra. Foto`, especialidadIds: [esp.id] })).body;
    expect((await subirFoto(ficha['id'] as string, imagenSintetica('jpg', 200, 200))).status).toBe(400);
    expect((await subirFoto(ficha['id'] as string, imagenSintetica('jpg', 800, 1000))).status).toBe(201);
    const fotoId = (await prisma.perfilMedico.findUniqueOrThrow({ where: { id: ficha['id'] as string } })).fotoId!;
    expect((await fetch(`${base}/publico/directorio/fotos/${fotoId}`)).status).toBe(404);

    await http(`/directorio/medicos/${ficha['id']}/publicacion`, 'PUT', usuarios.admin.token, { publicado: true });
    const tarjeta = ((await http(`/publico/directorio/medicos?especialidad=${esp.slug}`)).body['datos'] as { fotoUrl: string }[])[0];
    const foto = await fetch(base + tarjeta.fotoUrl);
    expect(foto.status).toBe(200);
    expect(foto.headers.get('content-type')).toBe('image/jpeg');
    expect(foto.headers.get('cache-control')).toMatch(/immutable/);

    await subirFoto(ficha['id'] as string, imagenSintetica('jpg', 900, 900));
    await new Promise(r => setTimeout(r, 50));
    expect([...almacen.keys()].filter(k => k.startsWith(`directorio/${ficha['id']}/`))).toHaveLength(1);
    expect((await fetch(`${base}/publico/directorio/fotos/${fotoId}`)).status).toBe(404);
  });
});
