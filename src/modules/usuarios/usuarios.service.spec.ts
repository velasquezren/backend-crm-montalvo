import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import { UsuariosService } from './usuarios.service';

/**
 * Lo que protege este service, en dos frentes:
 *
 *  1. Que nunca se quede el sistema sin ningún SUPER_ADMIN activo — es el
 *     único rol que puede gestionar agentes o volver a crear otro super
 *     admin, así que perderlo es quedar bloqueado para siempre.
 *  2. Que nadie se toque sus propios privilegios (rol, estado activo) desde
 *     su propio perfil, aunque sea SUPER_ADMIN.
 *
 * Dobles de Prisma, no de bcrypt.
 */

interface UsuarioFalso {
  id: string;
  email: string;
  rol: string;
  activo: boolean;
  codigo: string | null;
}

function montar(usuarios: UsuarioFalso[] = [
  { id: 'u1', email: 'admin@x.com', rol: 'SUPER_ADMIN', activo: true, codigo: null },
]) {
  const actualizaciones: Array<{ id: string; data: Record<string, unknown> }> = [];

  const prisma = {
    usuario: {
      findUnique: async ({
        where,
      }: {
        where: { id?: string; email?: string; codigo?: string };
      }) => {
        if (where.id !== undefined) return usuarios.find(u => u.id === where.id) ?? null;
        if (where.email !== undefined) return usuarios.find(u => u.email === where.email) ?? null;
        if (where.codigo !== undefined) return usuarios.find(u => u.codigo === where.codigo) ?? null;
        return null;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        actualizaciones.push({ id: where.id, data });
        const usuario = usuarios.find(u => u.id === where.id);
        return { ...usuario, ...data };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'nuevo', ...data }),
      count: async ({
        where,
      }: {
        where: { rol?: string; activo?: boolean; id?: { not: string } };
      }) =>
        usuarios.filter(
          u =>
            (where.rol === undefined || u.rol === where.rol) &&
            (where.activo === undefined || u.activo === where.activo) &&
            (!where.id?.not || u.id !== where.id.not),
        ).length,
    },
  };

  const servicio = new UsuariosService(prisma as never);
  return { servicio, actualizaciones };
}

describe('UsuariosService · último SUPER_ADMIN', () => {
  it('no deja bajarle el rol al único SUPER_ADMIN activo', async () => {
    const { servicio } = montar();

    await expect(servicio.update('u1', { rol: 'AGENTE' } as never)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('no deja desactivar al único SUPER_ADMIN activo', async () => {
    const { servicio } = montar();

    await expect(servicio.desactivar('u1')).rejects.toThrow(BadRequestException);
  });

  it('sí deja bajarle el rol si queda otro SUPER_ADMIN activo', async () => {
    const { servicio, actualizaciones } = montar([
      { id: 'u1', email: 'a@x.com', rol: 'SUPER_ADMIN', activo: true, codigo: null },
      { id: 'u2', email: 'b@x.com', rol: 'SUPER_ADMIN', activo: true, codigo: null },
    ]);

    await servicio.update('u1', { rol: 'AGENTE' } as never, 'u2');

    expect(actualizaciones[0]).toMatchObject({ id: 'u1', data: { rol: 'AGENTE' } });
  });

  it('un SUPER_ADMIN inactivo no cuenta como "otro" disponible', async () => {
    const { servicio } = montar([
      { id: 'u1', email: 'a@x.com', rol: 'SUPER_ADMIN', activo: true, codigo: null },
      { id: 'u2', email: 'b@x.com', rol: 'SUPER_ADMIN', activo: false, codigo: null },
    ]);

    await expect(
      servicio.update('u1', { rol: 'AGENTE' } as never, 'u2'),
    ).rejects.toThrow(BadRequestException);
  });

  it('bajarle el rol a un ADMIN normal no exige nada especial', async () => {
    const { servicio, actualizaciones } = montar([
      { id: 'u1', email: 'a@x.com', rol: 'ADMIN', activo: true, codigo: null },
    ]);

    await servicio.update('u1', { rol: 'AGENTE' } as never);

    expect(actualizaciones).toHaveLength(1);
  });
});

describe('UsuariosService · nadie se toca sus propios privilegios', () => {
  it('no puede cambiarse el rol a sí mismo, aunque queden otros SUPER_ADMIN', async () => {
    const { servicio } = montar([
      { id: 'u1', email: 'a@x.com', rol: 'SUPER_ADMIN', activo: true, codigo: null },
      { id: 'u2', email: 'b@x.com', rol: 'SUPER_ADMIN', activo: true, codigo: null },
    ]);

    await expect(
      servicio.update('u1', { rol: 'AGENTE' } as never, 'u1'),
    ).rejects.toThrow(BadRequestException);
  });

  it('no puede desactivarse a sí mismo vía update()', async () => {
    const { servicio } = montar();

    await expect(servicio.update('u1', { activo: false } as never, 'u1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('no puede desactivarse a sí mismo vía desactivar()', async () => {
    const { servicio } = montar();

    await expect(servicio.desactivar('u1', 'u1')).rejects.toThrow(BadRequestException);
  });

  it('otro admin sí puede desactivarlo', async () => {
    const { servicio, actualizaciones } = montar([
      { id: 'u1', email: 'a@x.com', rol: 'ADMIN', activo: true, codigo: null },
      { id: 'u2', email: 'b@x.com', rol: 'SUPER_ADMIN', activo: true, codigo: null },
    ]);

    await servicio.desactivar('u1', 'u2');

    expect(actualizaciones[0]).toMatchObject({ id: 'u1', data: { activo: false } });
  });

  it('cambiarse a sí mismo otro campo (no rol/activo) sí está permitido', async () => {
    const { servicio, actualizaciones } = montar();

    await servicio.update('u1', { nombre: 'Nombre nuevo' } as never, 'u1');

    expect(actualizaciones).toHaveLength(1);
  });
});

describe('UsuariosService · código de empresa único', () => {
  it('rechaza un código que ya usa otra persona', async () => {
    const { servicio } = montar([
      { id: 'u1', email: 'a@x.com', rol: 'AGENTE', activo: true, codigo: 'Pe100' },
      { id: 'u2', email: 'b@x.com', rol: 'AGENTE', activo: true, codigo: null },
    ]);

    await expect(servicio.update('u2', { codigo: 'Pe100' } as never)).rejects.toThrow(
      ConflictException,
    );
  });

  it('dejarle a alguien el código que ya tenía no choca contra sí mismo', async () => {
    const { servicio, actualizaciones } = montar([
      { id: 'u1', email: 'a@x.com', rol: 'AGENTE', activo: true, codigo: 'Pe100' },
    ]);

    await servicio.update('u1', { codigo: 'Pe100' } as never);

    expect(actualizaciones[0]).toMatchObject({ data: { codigo: 'Pe100' } });
  });

  /* Varias cadenas vacías chocarían contra el índice único; Postgres permite
     tantos NULL como haga falta — por eso se normaliza a null, no a ''. */
  it('un código vacío o solo espacios se normaliza a null', async () => {
    const { servicio, actualizaciones } = montar([
      { id: 'u1', email: 'a@x.com', rol: 'AGENTE', activo: true, codigo: 'Pe100' },
    ]);

    await servicio.update('u1', { codigo: '   ' } as never);

    expect(actualizaciones[0]).toMatchObject({ data: { codigo: null } });
  });
});

describe('UsuariosService · create / findOne', () => {
  it('rechaza un email ya usado', async () => {
    const { servicio } = montar();

    await expect(
      servicio.create({
        email: 'admin@x.com',
        nombre: 'X',
        password: 'x',
        rol: 'AGENTE',
      } as never),
    ).rejects.toThrow(ConflictException);
  });

  it('un id que no existe da 404', async () => {
    const { servicio } = montar();

    await expect(servicio.findOne('no-existe')).rejects.toThrow(NotFoundException);
  });
});
