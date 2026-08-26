import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

import { AuthService } from './auth.service';

/**
 * `login`/`refresh` deciden si alguien entra al sistema. Son pruebas de la
 * REGLA (qué responde y con qué excepción), con dobles de `UsuariosService` y
 * `JwtService` — bcrypt es el real, así la prueba también confirma que
 * `login()` de verdad lo usa y no compara strings a mano.
 *
 * El caso que más importa fijar es `refresh()`: el código separa a propósito
 * "el token no vale" (401) de "la base no respondió al releer al usuario"
 * (debe subir el error tal cual, nunca convertirse en 401) — mezclar los dos
 * deslogueaba a todas las agentes a la vez ante un parpadeo transitorio de
 * Postgres, en vez de dejar que el fetch se reintentara.
 */

interface UsuarioFalso {
  id: string;
  email: string;
  nombre: string;
  rol: string;
  activo: boolean;
  passwordHash: string;
  foto: string | null;
}

const BASE: UsuarioFalso = {
  id: 'u1',
  email: 'ana@clinica.test',
  nombre: 'Ana',
  rol: 'AGENTE',
  activo: true,
  passwordHash: '',
  foto: null,
};

interface Firmado {
  payload: Record<string, unknown>;
  expiresIn?: string;
}

function montar(
  opciones: {
    usuario?: UsuarioFalso | null;
    errorAlReleer?: unknown;
  } = {},
) {
  const usuario = opciones.usuario === undefined ? BASE : opciones.usuario;

  const usuariosService = {
    findByEmailConPassword: async (email: string) =>
      usuario && usuario.email === email ? usuario : null,
    findOne: async (id: string) => {
      if (opciones.errorAlReleer) throw opciones.errorAlReleer;
      if (!usuario || usuario.id !== id) {
        throw new NotFoundException(`Usuario ${id} no encontrado`);
      }
      return usuario;
    },
  };

  const firmados: Firmado[] = [];
  let proximaVerificacion: (() => { sub: string; type?: string }) | null = null;

  const jwtService = {
    signAsync: async (payload: Record<string, unknown>, opts?: { expiresIn?: string }) => {
      firmados.push({ payload, expiresIn: opts?.expiresIn });
      return opts?.expiresIn ? 'refresh-token-firmado' : 'access-token-firmado';
    },
    verifyAsync: async () => {
      if (!proximaVerificacion) throw new Error('firma inválida o token vencido');
      return proximaVerificacion();
    },
  };

  const servicio = new AuthService(usuariosService as never, jwtService as never);

  return {
    servicio,
    firmados,
    fijarVerificacion: (fn: () => { sub: string; type?: string }) => {
      proximaVerificacion = fn;
    },
  };
}

async function usuarioConPassword(clave: string, extra: Partial<UsuarioFalso> = {}): Promise<UsuarioFalso> {
  return { ...BASE, ...extra, passwordHash: await bcrypt.hash(clave, 4) };
}

describe('AuthService · login', () => {
  it('un email que no existe da Unauthorized (nunca revela si el email existe)', async () => {
    const { servicio } = montar({ usuario: null });

    await expect(
      servicio.login({ email: 'nadie@x.com', password: 'x' } as never),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('usuario inactivo no entra aunque la contraseña sea correcta', async () => {
    const usuario = await usuarioConPassword('correcta', { activo: false });
    const { servicio } = montar({ usuario });

    await expect(
      servicio.login({ email: usuario.email, password: 'correcta' } as never),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('password incorrecta da Unauthorized, con el mismo tipo de error que "no existe"', async () => {
    const usuario = await usuarioConPassword('correcta');
    const { servicio } = montar({ usuario });

    await expect(
      servicio.login({ email: usuario.email, password: 'otra-cosa' } as never),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('éxito: firma access_token y refresh_token; el payload firmado nunca lleva la foto', async () => {
    const usuario = await usuarioConPassword('correcta', {
      foto: 'data:image/png;base64,ENORME',
    });
    const { servicio, firmados } = montar({ usuario });

    const resultado = await servicio.login({
      email: usuario.email,
      password: 'correcta',
    } as never);

    expect(resultado.access_token).toBe('access-token-firmado');
    expect(resultado.refresh_token).toBe('refresh-token-firmado');
    expect(resultado.usuario.foto).toBe('data:image/png;base64,ENORME'); // sí va en el cuerpo

    /* Ni el payload de access ni el de refresh llevan `foto`: es lo que hacía
       el token pesar ~2,7 MB y disparar 431 en cada petición autenticada. */
    for (const { payload } of firmados) {
      expect(payload.foto).toBeUndefined();
    }
  });

  it('el refresh_token se firma a 30 días y con type: "refresh"', async () => {
    const usuario = await usuarioConPassword('correcta');
    const { servicio, firmados } = montar({ usuario });

    await servicio.login({ email: usuario.email, password: 'correcta' } as never);

    const refresh = firmados.find(f => f.expiresIn === '30d');
    expect(refresh?.payload).toMatchObject({ sub: usuario.id, type: 'refresh' });
  });
});

describe('AuthService · refresh', () => {
  it('sin token, 401', async () => {
    const { servicio } = montar();

    await expect(servicio.refresh('')).rejects.toThrow(UnauthorizedException);
  });

  it('firma inválida o token vencido: 401, no un 500', async () => {
    const { servicio } = montar(); // sin fijarVerificacion -> verifyAsync lanza

    await expect(servicio.refresh('token-cualquiera')).rejects.toThrow(UnauthorizedException);
  });

  it('un access_token colado (sin type "refresh") no sirve para refrescar', async () => {
    const { servicio, fijarVerificacion } = montar();
    fijarVerificacion(() => ({ sub: BASE.id })); // sin `type`

    await expect(servicio.refresh('access-token-colado')).rejects.toThrow(UnauthorizedException);
  });

  it('usuario borrado desde el login: 401, no 500', async () => {
    const { servicio, fijarVerificacion } = montar({ usuario: null });
    fijarVerificacion(() => ({ sub: 'ya-no-existe', type: 'refresh' }));

    await expect(servicio.refresh('token-viejo')).rejects.toThrow(UnauthorizedException);
  });

  it('usuario desactivado: 401', async () => {
    const { servicio, fijarVerificacion } = montar({ usuario: { ...BASE, activo: false } });
    fijarVerificacion(() => ({ sub: BASE.id, type: 'refresh' }));

    await expect(servicio.refresh('token-valido')).rejects.toThrow(UnauthorizedException);
  });

  it('si la base falla al releer al usuario (no "no encontrado"), el error original sube tal cual', async () => {
    const caidaDeBase = new Error('Postgres no responde');
    const { servicio, fijarVerificacion } = montar({ errorAlReleer: caidaDeBase });
    fijarVerificacion(() => ({ sub: BASE.id, type: 'refresh' }));

    await expect(servicio.refresh('token-valido')).rejects.toBe(caidaDeBase);
  });

  it('éxito: devuelve un access_token nuevo y NO un refresh_token nuevo', async () => {
    const { servicio, fijarVerificacion } = montar();
    fijarVerificacion(() => ({ sub: BASE.id, type: 'refresh' }));

    const resultado = await servicio.refresh('token-valido');

    expect(resultado.access_token).toBe('access-token-firmado');
    expect(resultado).not.toHaveProperty('refresh_token');
  });
});

describe('AuthService · updatePerfil', () => {
  it('un agente no puede cambiarse el rol ni el estado activo desde su propio perfil', async () => {
    const cambios: Array<Record<string, unknown>> = [];
    const usuariosService = {
      update: async (_id: string, dto: Record<string, unknown>) => {
        cambios.push(dto);
        return { ...BASE, ...dto };
      },
    };
    const servicio = new AuthService(usuariosService as never, {} as never);

    await servicio.updatePerfil(BASE.id, {
      nombre: 'Ana Nueva',
      rol: 'SUPER_ADMIN',
      activo: false,
    } as never);

    expect(cambios[0]).toEqual({ nombre: 'Ana Nueva' });
  });
});
