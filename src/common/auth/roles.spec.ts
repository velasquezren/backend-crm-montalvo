import { Rol } from '../../prisma/prisma-client';

import {
  puedeEntregarResultados,
  RANGO_ROL,
  ROLES_OPERATIVOS,
  alcanceAgente,
  cubreRol,
  esRolOperativo,
  tieneAlcanceGlobal,
} from './roles';

describe('jerarquía de roles', () => {
  /**
   * La red contra el bug que motivó este archivo: al añadir SUPER_ADMIN una
   * tabla de rangos quedó desincronizada del enum y un super admin terminó
   * viendo solo SUS registros. Si alguien añade un rol a schema.prisma y no lo
   * clasifica aquí, esto falla antes de llegar a producción.
   */
  it('todo rol del enum tiene rango asignado', () => {
    for (const rol of Object.values(Rol)) {
      expect(RANGO_ROL[rol]).toBeDefined();
      expect(typeof RANGO_ROL[rol]).toBe('number');
    }
  });

  it('ASISTENTE opera al mismo nivel que RECEPCION, no por encima', () => {
    expect(RANGO_ROL[Rol.ASISTENTE]).toBe(RANGO_ROL[Rol.RECEPCION]);
    expect(RANGO_ROL[Rol.ASISTENTE]).toBeLessThan(RANGO_ROL[Rol.AGENTE]);
    // El rango 0 es el suelo: @Roles('RECEPCION') no restringe, admite a todos.
    expect(cubreRol(Rol.AGENTE, Rol.RECEPCION)).toBe(true);
    expect(cubreRol(Rol.ASISTENTE, Rol.AGENTE)).toBe(false);
  });

  it('ASISTENTE no tiene alcance global ni ve más allá de lo suyo', () => {
    expect(tieneAlcanceGlobal(Rol.ASISTENTE)).toBe(false);
    expect(alcanceAgente({ sub: 'u-1', rol: Rol.ASISTENTE } as never)).toBe('u-1');
    expect(alcanceAgente({ sub: 'u-2', rol: Rol.ADMIN } as never)).toBeUndefined();
  });

  it('son operativos exactamente los roles sin alcance comercial', () => {
    expect(esRolOperativo(Rol.RECEPCION)).toBe(true);
    expect(esRolOperativo(Rol.ASISTENTE)).toBe(true);
    for (const rol of [Rol.AGENTE, Rol.ADMIN, Rol.SUPER_ADMIN]) {
      expect(esRolOperativo(rol)).toBe(false);
    }
    // Ningún rol operativo puede tener alcance global: sería una contradicción.
    for (const rol of ROLES_OPERATIVOS) expect(tieneAlcanceGlobal(rol)).toBe(false);
  });
});

/* La tabla entera, a propósito: añadir un rol obliga a decidir aquí si
   entrega resultados médicos, en vez de heredarlo por rango sin pensarlo. */
describe('quién entrega resultados médicos', () => {
  it.each([
    [Rol.RECEPCION, false],
    [Rol.ASISTENTE, true],
    [Rol.AGENTE, false],
    [Rol.ADMIN, true],
    [Rol.SUPER_ADMIN, true],
  ])('%s → %s', (rol, entrega) => {
    expect(puedeEntregarResultados(rol)).toBe(entrega);
  });

  it('cubre todos los roles del esquema', () => {
    expect(Object.keys(RANGO_ROL).sort()).toEqual([Rol.ADMIN, Rol.AGENTE, Rol.ASISTENTE, Rol.RECEPCION, Rol.SUPER_ADMIN].sort());
  });
});
