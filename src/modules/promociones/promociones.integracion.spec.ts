import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';

import { AuditService } from '../../common/audit/audit.service';
import { fechaCivilClinica, textoDeFechaCivil } from '../../common/fechas/zona-clinica';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { imagenSintetica } from '../../common/storage/imagen-sintetica';
import { R2Service } from '../../common/storage/r2.service';
import { Rol } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { UsuariosService } from '../usuarios/usuarios.service';
import { PromocionesPublicoController } from './promociones-publico.controller';
import { PromocionesController } from './promociones.controller';
import { PromocionesService } from './promociones.service';

/*
 * Promociones de punta a punta (docs/promociones-y-directorio.md): HTTP con los
 * guards reales, Postgres real y un R2 en memoria. Nada sale de esta máquina.
 */

// URL deliberadamente fija; nunca usar DATABASE_URL ni cargar .env en esta suite.
const prisma = new PrismaService('postgresql://crm_app@127.0.0.1:5433/crm_test');

/** R2 en memoria con el mismo contrato que el real (lo que usa el módulo). */
const almacen = new Map<string, { bytes: Uint8Array; mime: string }>();
const r2 = {
  habilitado: true,
  async subir(clave: string, cuerpo: ArrayBuffer, mime: string) { almacen.set(clave, { bytes: new Uint8Array(cuerpo), mime }); },
  async leer(clave: string) {
    const o = almacen.get(clave);
    if (!o) return null;
    return { cuerpo: new Blob([Uint8Array.from(o.bytes)]).stream(), tipo: o.mime, bytes: o.bytes.byteLength };
  },
  async eliminar(clave: string) { almacen.delete(clave); },
  async urlFirmada(clave: string) { return `https://r2.invalid/${clave}?firmada`; },
};

@Module({
  imports: [JwtModule.register({ secret: 'jwt-sintetico-promos', signOptions: { expiresIn: '15m' } })],
  controllers: [PromocionesController, PromocionesPublicoController],
  providers: [
    { provide: PrismaService, useValue: prisma },
    AuditService, AuthService, UsuariosService, PromocionesService,
    { provide: R2Service, useValue: r2 },
    { provide: APP_GUARD, useClass: JwtAuthGuard }, { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
class ModuloPromocionesTest {}

const SUFIJO = '@promos.test';
const TITULO = 'Prueba integración';
const PREFIJO_TEL = '+591700031';
let app: INestApplication;
let base: string;
const usuarios: Record<'agente' | 'agente2' | 'admin' | 'admin2' | 'recepcion', { id: string; token: string }> = {} as never;

const hoy = () => fechaCivilClinica(new Date());
const dia = (desplazamiento: number) => textoDeFechaCivil(new Date(hoy().getTime() + desplazamiento * 86_400_000));

async function http(ruta: string, metodo = 'GET', bearer?: string, cuerpo?: unknown) {
  const r = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  return { status: r.status, headers: r.headers, body: (texto ? JSON.parse(texto) : {}) as Record<string, unknown> };
}
async function subirBanner(id: string, formato: string, imagen: Buffer, bearer = usuarios.agente.token) {
  const form = new FormData();
  form.append('archivo', new Blob([Uint8Array.from(imagen)], { type: 'image/png' }), 'banner.png');
  form.append('textoAlternativo', 'Banner de prueba con el precio');
  const r = await fetch(`${base}/promociones/${id}/banners/${formato}`, { method: 'PUT', headers: { Authorization: `Bearer ${bearer}` }, body: form });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
const borrador = (cambios: Record<string, unknown> = {}) => ({
  titulo: `${TITULO} control prenatal`,
  resumen: 'Tres controles con ecografía',
  condiciones: 'Válido en el mes. Incluye tres controles y una ecografía.',
  etiquetaOferta: '-20 %',
  precioRegular: 600,
  precioPromocional: 480,
  vigenteDesde: dia(-1),
  vigenteHasta: dia(30),
  ...cambios,
});
async function crearLista(cambios: Record<string, unknown> = {}) {
  const creada = await http('/promociones', 'POST', usuarios.agente.token, borrador(cambios));
  expect(creada.status).toBe(201);
  const id = creada.body['id'] as string;
  expect((await subirBanner(id, 'CUADRADO', imagenSintetica('png', 1080, 1080))).status).toBe(200);
  return id;
}

async function limpiar() {
  const ids = (await prisma.usuario.findMany({ where: { email: { endsWith: SUFIJO } }, select: { id: true } })).map(u => u.id);
  await prisma.auditLog.deleteMany({ where: { OR: [{ usuarioId: { in: ids } }, { entidad: 'Promocion' }] } });
  await prisma.venta.deleteMany({ where: { cliente: { telefono: { startsWith: PREFIJO_TEL } } } });
  await prisma.cliente.deleteMany({ where: { telefono: { startsWith: PREFIJO_TEL } } });
  await prisma.promocion.deleteMany({ where: { titulo: { startsWith: TITULO } } });
  await prisma.usuario.deleteMany({ where: { id: { in: ids } } });
  almacen.clear();
}

beforeAll(async () => {
  await limpiar();
  app = await NestFactory.create(ModuloPromocionesTest, { logger: false, abortOnError: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  const definiciones: [keyof typeof usuarios, Rol][] = [
    ['agente', 'AGENTE'], ['agente2', 'AGENTE'], ['admin', 'ADMIN'], ['admin2', 'ADMIN'], ['recepcion', 'RECEPCION'],
  ];
  for (const [clave, rol] of definiciones) {
    const u = await prisma.usuario.create({ data: { nombre: `Persona ${clave}`, email: `${clave}${SUFIJO}`, passwordHash: await bcrypt.hash('sintetico', 4), rol, activo: true } });
    usuarios[clave] = { id: u.id, token: (await app.get(AuthService).login({ email: u.email, password: 'sintetico' })).access_token };
  }
}, 30_000);

afterAll(async () => {
  await limpiar();
  await app?.close();
  await prisma.$disconnect();
});

describe('redactar: la agente crea, recepción solo mira', () => {
  it('nace como borrador con código y slug; recepción la ve pero no puede crearla', async () => {
    const creada = await http('/promociones', 'POST', usuarios.agente.token, borrador());
    expect(creada.status).toBe(201);
    expect(creada.body).toMatchObject({ estado: 'BORRADOR', vigencia: 'VIGENTE', precioPromocional: 480, puedeEditar: true, acciones: ['enviar', ] });
    expect(creada.body['codigo']).toMatch(/^PRM-[A-Z0-9]{5}$/);
    expect(creada.body['slug']).toMatch(/^prueba-integracion-control-prenatal-[a-z0-9]{5}$/);
    expect((await http('/promociones', 'POST', usuarios.recepcion.token, borrador())).status).toBe(403);
    expect((await http(`/promociones/${creada.body['id']}`, 'GET', usuarios.recepcion.token)).status).toBe(200);
  });

  it('precios incoherentes y fechas inexistentes se rechazan con un motivo', async () => {
    expect((await http('/promociones', 'POST', usuarios.agente.token, borrador({ precioPromocional: 700 }))).body['message']).toMatch(/menor que el regular/);
    expect((await http('/promociones', 'POST', usuarios.agente.token, borrador({ vigenteHasta: '2026-02-30' }))).status).toBe(400);
    expect((await http('/promociones', 'POST', usuarios.agente.token, borrador({ vigenteDesde: dia(5), vigenteHasta: dia(1) }))).body['message']).toMatch(/termina antes/);
  });
});

describe('banners', () => {
  it('valida proporción y medidas; reemplazar crea otra imagen y borra la anterior de R2', async () => {
    const id = (await http('/promociones', 'POST', usuarios.agente.token, borrador())).body['id'] as string;
    expect((await subirBanner(id, 'CUADRADO', imagenSintetica('png', 1080, 1350))).body['message']).toMatch(/proporción/);
    expect((await subirBanner(id, 'CUADRADO', imagenSintetica('png', 600, 600))).body['message']).toMatch(/al menos 1080×1080/);
    expect((await subirBanner(id, 'CUADRADO', Buffer.from('no soy una imagen'))).status).toBe(400);

    const primera = await subirBanner(id, 'CUADRADO', imagenSintetica('png', 1080, 1080));
    expect(primera.status).toBe(200);
    const clavePrimera = [...almacen.keys()].find(k => k.startsWith(`promociones/${id}/`))!;
    await subirBanner(id, 'CUADRADO', imagenSintetica('png', 1200, 1200));
    await new Promise(r => setTimeout(r, 50));
    expect(almacen.has(clavePrimera)).toBe(false);
    expect([...almacen.keys()].filter(k => k.startsWith(`promociones/${id}/`))).toHaveLength(1);
    expect(await prisma.promocionImagen.count({ where: { promocionId: id } })).toBe(1);
  });
});

describe('revisión y publicación', () => {
  it('sin banner no se puede enviar; la agente envía, un admin devuelve con motivo y luego publica', async () => {
    const id = (await http('/promociones', 'POST', usuarios.agente.token, borrador())).body['id'] as string;
    const sinBanner = await http(`/promociones/${id}/enviar`, 'POST', usuarios.agente.token);
    expect(sinBanner.status).toBe(400);
    expect(JSON.stringify(sinBanner.body['message'])).toMatch(/banner Cuadrado/);

    await subirBanner(id, 'CUADRADO', imagenSintetica('png', 1080, 1080));
    expect((await http(`/promociones/${id}/enviar`, 'POST', usuarios.agente.token)).body).toMatchObject({ estado: 'EN_REVISION', puedeEditar: false });

    /* En revisión, la agente ya no la cambia ni la publica. */
    expect((await http(`/promociones/${id}`, 'PATCH', usuarios.agente.token, { version: 99, resumen: 'cambio' })).status).toBe(409);
    const version = (await http(`/promociones/${id}`, 'GET', usuarios.agente.token)).body['version'];
    expect((await http(`/promociones/${id}`, 'PATCH', usuarios.agente.token, { version, resumen: 'cambio' })).status).toBe(403);
    expect((await http(`/promociones/${id}/publicar`, 'POST', usuarios.agente.token)).status).toBe(403);

    expect((await http(`/promociones/${id}/devolver`, 'POST', usuarios.admin.token, { motivo: 'x' })).status).toBe(400);
    expect((await http(`/promociones/${id}/devolver`, 'POST', usuarios.admin.token, { motivo: 'Falta aclarar qué incluye' })).body).toMatchObject({ estado: 'BORRADOR', motivoDevolucion: 'Falta aclarar qué incluye' });
    expect((await http(`/promociones/${id}/enviar`, 'POST', usuarios.agente.token)).body).toMatchObject({ estado: 'EN_REVISION', motivoDevolucion: null });

    const publicada = await http(`/promociones/${id}/publicar`, 'POST', usuarios.admin.token);
    expect(publicada.body).toMatchObject({ estado: 'PUBLICADA', revisadaPor: { id: usuarios.admin.id } });
    expect(publicada.body['publicadaEn']).toBeTruthy();

    const huellas = await prisma.auditLog.findMany({ where: { entidadId: id, accion: { startsWith: 'PROMOCION_' } }, orderBy: { createdAt: 'asc' } });
    expect(huellas.map(h => h.accion)).toEqual(['PROMOCION_CREADA', 'PROMOCION_ENVIAR', 'PROMOCION_DEVOLVER', 'PROMOCION_ENVIAR', 'PROMOCION_PUBLICAR']);
    expect(huellas.find(h => h.accion === 'PROMOCION_PUBLICAR')?.usuarioId).toBe(usuarios.admin.id);
  });

  it('una vencida no se publica; un admin no puede dejar una publicada incompleta', async () => {
    const id = await crearLista();
    await prisma.promocion.update({ where: { id }, data: { vigenteDesde: new Date(hoy().getTime() - 10 * 86_400_000), vigenteHasta: new Date(hoy().getTime() - 86_400_000) } });
    expect(JSON.stringify((await http(`/promociones/${id}/publicar`, 'POST', usuarios.admin.token)).body['message'])).toMatch(/ya terminó/);

    const otra = await crearLista();
    await http(`/promociones/${otra}/publicar`, 'POST', usuarios.admin.token);
    const version = (await http(`/promociones/${otra}`, 'GET', usuarios.admin.token)).body['version'];
    const r = await http(`/promociones/${otra}`, 'PATCH', usuarios.admin.token, { version, condiciones: '' });
    expect(r.status).toBe(400);
    expect((await prisma.promocion.findUniqueOrThrow({ where: { id: otra } })).condiciones).not.toBe('');
  });

  it('dos admins publicando a la vez: una transición válida, la otra 409', async () => {
    const id = await crearLista();
    await http(`/promociones/${id}/enviar`, 'POST', usuarios.agente.token);
    const r = await Promise.all([
      http(`/promociones/${id}/publicar`, 'POST', usuarios.admin.token),
      http(`/promociones/${id}/publicar`, 'POST', usuarios.admin2.token),
    ]);
    expect(r.map(x => x.status).sort()).toEqual([201, 409]);
    expect(await prisma.auditLog.count({ where: { entidadId: id, accion: 'PROMOCION_PUBLICAR' } })).toBe(1);
  });

  it('dos agentes editando el mismo borrador: la segunda recibe 409, no pisa a la primera', async () => {
    const id = (await http('/promociones', 'POST', usuarios.agente.token, borrador())).body['id'] as string;
    const version = (await http(`/promociones/${id}`, 'GET', usuarios.agente.token)).body['version'];
    const r = await Promise.all([
      http(`/promociones/${id}`, 'PATCH', usuarios.agente.token, { version, resumen: 'Versión de la primera' }),
      http(`/promociones/${id}`, 'PATCH', usuarios.agente2.token, { version, resumen: 'Versión de la segunda' }),
    ]);
    expect(r.map(x => x.status).sort()).toEqual([200, 409]);
    const ganadora = r.find(x => x.status === 200)!.body['resumen'];
    expect((await prisma.promocion.findUniqueOrThrow({ where: { id } })).resumen).toBe(ganadora);
  });

  it('lo archivado no se edita ni recibe anuncios', async () => {
    const id = await crearLista();
    await http(`/promociones/${id}/archivar`, 'POST', usuarios.admin.token);
    const version = (await http(`/promociones/${id}`, 'GET', usuarios.admin.token)).body['version'];
    expect((await http(`/promociones/${id}`, 'PATCH', usuarios.admin.token, { version, resumen: 'x x x' })).status).toBe(403);
    expect((await http(`/promociones/${id}/anuncios/120000999`, 'PUT', usuarios.agente.token)).status).toBe(400);
    expect((await http(`/promociones/${id}/publicar`, 'POST', usuarios.admin.token)).status).toBe(409);
  });
});

describe('API pública (la landing)', () => {
  it('muestra solo lo publicado y vigente, sin datos internos, y sirve su banner', async () => {
    const visible = await crearLista({ titulo: `${TITULO} visible`, destacada: true });
    await http(`/promociones/${visible}/publicar`, 'POST', usuarios.admin.token);
    const borradorId = await crearLista({ titulo: `${TITULO} borrador` });
    const futura = await crearLista({ titulo: `${TITULO} futura`, vigenteDesde: dia(3), vigenteHasta: dia(10) });
    await http(`/promociones/${futura}/publicar`, 'POST', usuarios.admin.token);

    const lista = await http('/publico/promociones?limite=100');
    expect(lista.status).toBe(200);
    expect(lista.headers.get('cache-control')).toMatch(/max-age=60/);
    const titulos = (lista.body['datos'] as { titulo: string }[]).map(p => p.titulo);
    expect(titulos).toContain(`${TITULO} visible`);
    expect(titulos).not.toContain(`${TITULO} borrador`);
    expect(titulos).not.toContain(`${TITULO} futura`);

    const publica = (lista.body['datos'] as Record<string, unknown>[]).find(p => p['titulo'] === `${TITULO} visible`)!;
    for (const interno of ['id', 'version', 'creadaPor', 'anuncios', 'resultados', 'estado', 'motivoDevolucion']) expect(publica).not.toHaveProperty(interno);
    expect(publica).toMatchObject({ moneda: 'BOB', precioPromocional: 480, mensajeWhatsapp: expect.stringContaining(publica['codigo'] as string) });

    const banner = (publica['banners'] as Record<string, { url: string }>)['CUADRADO'].url;
    const img = await fetch(base + banner);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('cache-control')).toMatch(/immutable/);
    expect(img.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(Buffer.from(await img.arrayBuffer()).subarray(0, 8)).toEqual(imagenSintetica('png', 1080, 1080).subarray(0, 8));

    /* El banner de un borrador no se sirve aunque se conozca su id. */
    const idImagenBorrador = (await prisma.promocionImagen.findFirstOrThrow({ where: { promocionId: borradorId } })).id;
    expect((await fetch(`${base}/publico/promociones/imagenes/${idImagenBorrador}`)).status).toBe(404);

    expect((await http(`/publico/promociones/${publica['slug']}`)).status).toBe(200);
  });

  it('pausada desaparece de la landing y su banner deja de servirse', async () => {
    const id = await crearLista({ titulo: `${TITULO} pausable` });
    await http(`/promociones/${id}/publicar`, 'POST', usuarios.admin.token);
    const slug = (await prisma.promocion.findUniqueOrThrow({ where: { id } })).slug;
    const imagen = (await prisma.promocionImagen.findFirstOrThrow({ where: { promocionId: id } })).id;
    expect((await fetch(`${base}/publico/promociones/imagenes/${imagen}`)).status).toBe(200);

    await http(`/promociones/${id}/pausar`, 'POST', usuarios.admin.token);
    expect((await http(`/publico/promociones/${slug}`)).status).toBe(404);
    expect((await fetch(`${base}/publico/promociones/imagenes/${imagen}`)).status).toBe(404);
  });

  it('cada canal ve lo suyo', async () => {
    const soloWhatsapp = await crearLista({ titulo: `${TITULO} solo whatsapp`, enLanding: false });
    await http(`/promociones/${soloWhatsapp}/publicar`, 'POST', usuarios.admin.token);
    const enLanding = ((await http('/publico/promociones?limite=100')).body['datos'] as { titulo: string }[]).map(p => p.titulo);
    const enWhatsapp = ((await http('/publico/promociones?limite=100&canal=whatsapp')).body['datos'] as { titulo: string }[]).map(p => p.titulo);
    expect(enLanding).not.toContain(`${TITULO} solo whatsapp`);
    expect(enWhatsapp).toContain(`${TITULO} solo whatsapp`);
  });
});

describe('anuncios de Meta y atribución', () => {
  it('lista los anuncios que trajeron pacientes sin promoción, los enlaza y cuenta leads y ventas', async () => {
    const anuncio = '120000000000777';
    const cliente = await prisma.cliente.create({
      data: { nombre: 'Paciente sintética', telefono: `${PREFIJO_TEL}01`, datosExtra: { campanaOrigen: { anuncioId: anuncio, titular: 'Control prenatal -20 %', imagenUrl: 'https://scontent.invalid/ad.jpg' } } },
    });
    const lead = await prisma.lead.create({ data: { clienteId: cliente.id, origen: 'WHATSAPP_DIRECTO', anuncioId: anuncio } });
    await prisma.venta.create({ data: { clienteId: cliente.id, agenteId: usuarios.agente.id, producto: 'Control prenatal', monto: 480, estado: 'GANADA', leadId: lead.id } });

    const sinPromo = await http('/promociones/anuncios/sin-promocion?limite=100', 'GET', usuarios.agente.token);
    const fila = (sinPromo.body['datos'] as Record<string, unknown>[]).find(a => a['anuncioId'] === anuncio);
    expect(fila).toMatchObject({ leads: 1, titular: 'Control prenatal -20 %', imagenUrl: 'https://scontent.invalid/ad.jpg' });
    expect((await http('/promociones/anuncios/sin-promocion', 'GET', usuarios.recepcion.token)).status).toBe(403);

    const id = await crearLista();
    const enlazada = await http(`/promociones/${id}/anuncios/${anuncio}`, 'PUT', usuarios.agente.token);
    expect(enlazada.body).toMatchObject({ anuncios: [{ anuncioId: anuncio }], resultados: { leads: 1, ventasGanadas: 1, montoVendido: 480 } });
    expect((await http(`/promociones/${id}/anuncios/${anuncio}`, 'PUT', usuarios.agente.token)).status).toBe(200);

    const otra = await crearLista({ titulo: `${TITULO} otra` });
    expect((await http(`/promociones/${otra}/anuncios/${anuncio}`, 'PUT', usuarios.agente.token)).body['message']).toMatch(/ya está enlazado/);

    const yaNoEsta = (await http('/promociones/anuncios/sin-promocion?limite=100', 'GET', usuarios.agente.token)).body['datos'] as { anuncioId: string }[];
    expect(yaNoEsta.map(a => a.anuncioId)).not.toContain(anuncio);

    const atribucion = await http(`/promociones/atribucion/${anuncio}`, 'GET', usuarios.recepcion.token);
    expect(atribucion.body['promocion']).toMatchObject({ id, precioPromocional: 480, vigencia: 'VIGENTE' });
    expect((await http('/promociones/atribucion/120000000000000', 'GET', usuarios.recepcion.token)).body).toEqual({ promocion: null });
    expect((await http('/promociones/atribucion/no-es-un-id', 'GET', usuarios.recepcion.token)).status).toBe(400);
  });
});
