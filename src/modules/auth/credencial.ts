import { Rol } from '../../prisma/prisma-client';
import { UsuarioJwt } from '../../common/decorators/current-user.decorator';

export interface CredencialJwt {
  sub: string;
  sid: string;
  versionSesion: number;
  exp: number;
  type: 'access' | 'refresh';
  rol?: Rol;
  email?: string;
  nombre?: string;
}

export interface AccesoAutenticado extends UsuarioJwt {
  sid: string;
  versionSesion: number;
  exp: number;
}

export function esCredencial(valor: unknown, tipo: CredencialJwt['type']): valor is CredencialJwt {
  if (!valor || typeof valor !== 'object') return false;
  const p = valor as Record<string, unknown>;
  const texto = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  return p.type === tipo && texto(p.sub) && texto(p.sid) &&
    Number.isSafeInteger(p.versionSesion) && Number(p.versionSesion) >= 0 &&
    Number.isSafeInteger(p.exp) && Number(p.exp) > 0 &&
    (tipo === 'refresh' || (texto(p.email) && texto(p.nombre) && Object.values(Rol).includes(p.rol as Rol)));
}
