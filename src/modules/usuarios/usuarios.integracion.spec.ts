import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

import { PrismaService } from '../../prisma/prisma.service';
import { Rol } from '../../prisma/prisma-client';
import { UsuariosService } from './usuarios.service';

/**
 * Contra PostgreSQL real (`crm_test` en el :5433 local). `npm run test:integracion`.
 *
 * Lo que protege este service:
 *
 *  1. Que nunca se quede el sistema sin ningún SUPER_ADMIN activo — es el
 *     único rol que puede gestionar agentes o crear otro, así que perderlo es
 *     quedar bloqueado para siempre.
 *  2. Que nadie se toque sus propios privilegios (rol, estado activo).
 *  3. El código de empresa único, y los silencios de línea que solo valen
 *     sobre lo que la cuenta ve.
 *
 * **Antes era un doble de Prisma**, y el día que el silencio pasó a su propia
 * tabla se rompieron las 15 pruebas sin que ninguna regla hubiera cambiado: el
 * doble tenía que imitar cada `select` y cada relación del service. Una prueba
 * que cae por un refactor correcto y pasaría con un índice único roto no
 * protege nada. Aquí el índice, las FK y las transacciones son los de verdad.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';
if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const DOMINIO = '@usuarios.test';
const VENTAS = '00000000-0000-4000-8000-000000000001';
const RECEPCION = '00000000-0000-4000-8000-000000000003';

const prisma = new PrismaService(URL_TEST);
const servicio = new UsuariosService(prisma);
let hash: string;

async function alta(nombre: string, rol: Rol, extra: { activo?: boolean; codigo?: string | null; lineas?: string[] } = {}) {
  return prisma.usuario.create({
    data: {
      nombre,
      email: `${nombre}${DOMINIO}`,
      passwordHash: hash,
      rol,
      activo: extra.activo ?? true,
      codigo: extra.codigo ?? null,
      lineasWhatsapp: { create: (extra.lineas ?? []).map(lineaId => ({ lineaId })) },
    },
  });
}

async function limpiar() {
  const ids = (await prisma.usuario.findMany({ where: { email: { endsWith: DOMINIO } }, select: { id: true } })).map(u => u.id);
  await prisma.auditLog.deleteMany({ where: { OR: [{ usuarioId: { in: ids } }, { entidadId: { in: ids } }] } });
  await prisma.usuario.deleteMany({ where: { id: { in: ids } } });
}

/**
 * «El único SUPER_ADMIN» solo es verdad si no hay otros en la base. `crm_test`
 * es compartida: si otra suite dejó uno vivo, estas pruebas pasarían o
 * fallarían por la razón equivocada. Mejor que lo digan.
 */
async function sinSuperAdminsAjenos() {
  const ajenos = await prisma.usuario.count({
    where: { rol: 'SUPER_ADMIN', activo: true, NOT: { email: { endsWith: DOMINIO } } },
  });
  if (ajenos) throw new Error(`crm_test tiene ${ajenos} SUPER_ADMIN de otra suite: la precondición «es el único» no se cumple`);
}

beforeAll(async () => {
  hash = await bcrypt.hash('prueba-usuarios', 4);
  await prisma.$connect();
});

beforeEach(async () => {
  await limpiar();
  await sinSuperAdminsAjenos();
});

afterAll(async () => {
  await limpiar();
  await prisma.$disconnect();
});

describe('UsuariosService · último SUPER_ADMIN', () => {
  it('no deja bajarle el rol al único SUPER_ADMIN activo', async () => {
    const unico = await alta('unico', 'SUPER_ADMIN');
    await expect(servicio.update(unico.id, { rol: 'AGENTE' })).rejects.toThrow(BadRequestException);
    expect((await prisma.usuario.findUniqueOrThrow({ where: { id: unico.id } })).rol).toBe('SUPER_ADMIN');
  });

  it('no deja desactivar al único SUPER_ADMIN activo', async () => {
    const unico = await alta('unico', 'SUPER_ADMIN');
    await expect(servicio.desactivar(unico.id)).rejects.toThrow(BadRequestException);
    expect((await prisma.usuario.findUniqueOrThrow({ where: { id: unico.id } })).activo).toBe(true);
  });

  it('sí deja bajarle el rol si queda otro SUPER_ADMIN activo', async () => {
    const uno = await alta('uno', 'SUPER_ADMIN');
    const otro = await alta('otro', 'SUPER_ADMIN');
    await servicio.update(uno.id, { rol: 'AGENTE' }, otro.id);
    expect((await prisma.usuario.findUniqueOrThrow({ where: { id: uno.id } })).rol).toBe('AGENTE');
  });

  it('un SUPER_ADMIN inactivo no cuenta como «otro» disponible', async () => {
    const uno = await alta('uno', 'SUPER_ADMIN');
    const dormido = await alta('dormido', 'SUPER_ADMIN', { activo: false });
    await expect(servicio.update(uno.id, { rol: 'AGENTE' }, dormido.id)).rejects.toThrow(BadRequestException);
  });

  it('bajarle el rol a un ADMIN normal no exige nada especial', async () => {
    const admin = await alta('admin', 'ADMIN');
    await servicio.update(admin.id, { rol: 'AGENTE' });
    expect((await prisma.usuario.findUniqueOrThrow({ where: { id: admin.id } })).rol).toBe('AGENTE');
  });
});

describe('UsuariosService · nadie se toca sus propios privilegios', () => {
  it('no puede cambiarse el rol a sí mismo, aunque queden otros SUPER_ADMIN', async () => {
    const uno = await alta('uno', 'SUPER_ADMIN');
    await alta('otro', 'SUPER_ADMIN');
    await expect(servicio.update(uno.id, { rol: 'AGENTE' }, uno.id)).rejects.toThrow(BadRequestException);
  });

  it('no puede desactivarse a sí mismo, ni por update() ni por desactivar()', async () => {
    const uno = await alta('uno', 'SUPER_ADMIN');
    await alta('otro', 'SUPER_ADMIN');
    await expect(servicio.update(uno.id, { activo: false }, uno.id)).rejects.toThrow(BadRequestException);
    await expect(servicio.desactivar(uno.id, uno.id)).rejects.toThrow(BadRequestException);
  });

  it('otro admin sí puede desactivarlo', async () => {
    const admin = await alta('admin', 'ADMIN');
    const jefe = await alta('jefe', 'SUPER_ADMIN');
    await servicio.desactivar(admin.id, jefe.id);
    expect((await prisma.usuario.findUniqueOrThrow({ where: { id: admin.id } })).activo).toBe(false);
  });

  it('cambiarse a sí mismo otro campo (no rol/activo) sí está permitido', async () => {
    const uno = await alta('uno', 'SUPER_ADMIN');
    await servicio.update(uno.id, { nombre: 'Nombre nuevo' }, uno.id);
    expect((await prisma.usuario.findUniqueOrThrow({ where: { id: uno.id } })).nombre).toBe('Nombre nuevo');
  });
});

describe('UsuariosService · código de empresa único', () => {
  it('rechaza un código que ya usa otra persona', async () => {
    await alta('con-codigo', 'AGENTE', { codigo: 'Pe100' });
    const otra = await alta('sin-codigo', 'AGENTE');
    await expect(servicio.update(otra.id, { codigo: 'Pe100' })).rejects.toThrow(ConflictException);
  });

  it('dejarle a alguien el código que ya tenía no choca contra sí mismo', async () => {
    const u = await alta('con-codigo', 'AGENTE', { codigo: 'Pe100' });
    await servicio.update(u.id, { codigo: 'Pe100' });
    expect((await prisma.usuario.findUniqueOrThrow({ where: { id: u.id } })).codigo).toBe('Pe100');
  });

  /* Varias cadenas vacías chocarían contra el índice único; Postgres permite
     tantos NULL como haga falta — por eso se normaliza a null, no a ''. */
  it('un código vacío o solo espacios se normaliza a null', async () => {
    const u = await alta('con-codigo', 'AGENTE', { codigo: 'Pe100' });
    await servicio.update(u.id, { codigo: '   ' });
    expect((await prisma.usuario.findUniqueOrThrow({ where: { id: u.id } })).codigo).toBeNull();
  });
});

describe('UsuariosService · create / findOne', () => {
  it('rechaza un email ya usado', async () => {
    await alta('repetido', 'AGENTE');
    await expect(
      servicio.create({ email: `repetido${DOMINIO}`, nombre: 'X', password: 'contrasena-larga', rol: 'AGENTE' }),
    ).rejects.toThrow(ConflictException);
  });

  it('un id que no existe da 404', async () => {
    await expect(servicio.findOne('no-existe')).rejects.toThrow(NotFoundException);
  });
});

describe('UsuariosService · silencios de línea', () => {
  /* Un admin ve todas las líneas por su rol: puede silenciar cualquiera sin
     tener acceso a ninguna. */
  it('un rol global puede nacer con una línea silenciada que no tiene asignada', async () => {
    const creado = await servicio.create({
      email: `nuevo-admin${DOMINIO}`, nombre: 'Nuevo', password: 'contrasena-larga', rol: 'ADMIN', lineasSilenciadas: [RECEPCION],
    });
    expect(creado.lineasSilenciadas).toEqual([RECEPCION]);
  });

  it('una agente solo silencia líneas que ve', async () => {
    await expect(servicio.create({
      email: `nueva${DOMINIO}`, nombre: 'Nueva', password: 'contrasena-larga', rol: 'AGENTE',
      lineaIds: [VENTAS], lineasSilenciadas: [RECEPCION],
    })).rejects.toThrow(BadRequestException);
    expect(await prisma.usuario.count({ where: { email: `nueva${DOMINIO}` } })).toBe(0);
  });

  it('la ficha devuelve el silencio como lista, no como la relación cruda', async () => {
    const u = await alta('con-silencio', 'AGENTE', { lineas: [VENTAS, RECEPCION] });
    await prisma.silencioLinea.create({ data: { usuarioId: u.id, lineaId: RECEPCION } });
    const ficha = await servicio.findOne(u.id);
    expect(ficha.lineasSilenciadas).toEqual([RECEPCION]);
    expect(ficha).not.toHaveProperty('silenciosLinea');
  });
});
