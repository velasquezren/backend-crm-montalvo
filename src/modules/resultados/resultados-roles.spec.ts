import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { RolesGuard } from '../../common/guards/roles.guard';
import { Rol } from '../../prisma/prisma-client';
import { ClientesController } from '../clientes/clientes.controller';
import { ResultadosController } from './resultados.controller';

/**
 * Lo que dice el guard REAL sobre los métodos REALES de los controladores,
 * para la cuenta de la asistente.
 *
 * El fallo que esto fija: la cola de resultados corregía el teléfono y daba de
 * alta fichas llamando a `/clientes`, que no lleva `@Roles` y por tanto exige
 * AGENTE. La asistente —rango 0, justo la persona para la que existe la
 * cola— recibía 403 en las dos acciones. Ahora van por `/resultados`, cuyo
 * permiso de verdad (la capacidad + la línea) lo decide el service.
 *
 * Si alguien vuelve a mandar la pantalla a Clientes, o le pone rango de agente
 * a estas rutas, cae aquí.
 */
function contexto<T>(controlador: { prototype: T }, metodo: keyof T, rol: Rol): ExecutionContext {
  return {
    getHandler: () => controlador.prototype[metodo],
    getClass: () => controlador,
    switchToHttp: () => ({ getRequest: () => ({ user: { sub: 'u', rol } }) }),
  } as unknown as ExecutionContext;
}

const guard = new RolesGuard(new Reflector());

describe('la asistente y el guard de roles', () => {
  it.each(['corregirTelefono', 'crearFicha', 'vincularFicha', 'pendientes', 'enviar'] as const)(
    'pasa por /resultados → %s',
    metodo => {
      expect(guard.canActivate(contexto(ResultadosController, metodo, Rol.ASISTENTE))).toBe(true);
    },
  );

  /* Por qué existen las dos rutas de arriba: esta es la puerta que estaba
     usando la pantalla. Y debe seguir cerrada: abrirla le daría las 15.000
     fichas con sus datos comerciales. */
  it.each(['update', 'create'] as const)('sigue sin entrar a /clientes → %s', metodo => {
    expect(() => guard.canActivate(contexto(ClientesController, metodo, Rol.ASISTENTE))).toThrow(ForbiddenException);
  });
});
