import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { UsuariosService } from '../usuarios/usuarios.service';
import { LoginDto } from './dto/login.dto';
import { UpdatePerfilDto } from './dto/update-perfil.dto';
import { AccesoAutenticado, CredencialJwt, esCredencial } from './credencial';

const USUARIO_SESION = { id: true, nombre: true, email: true, rol: true, activo: true, versionSesion: true } as const;

/** Credenciales, sesiones revocables y perfil propio. La contraseña se valida vía Usuarios. */
@Injectable()
export class AuthService {
  constructor(
    private readonly usuariosService: UsuariosService,
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async login(dto: LoginDto) {
    const usuario = await this.usuariosService.findByEmailConPassword(dto.email);
    if (!usuario || !usuario.activo || !await bcrypt.compare(dto.password, usuario.passwordHash)) {
      throw new UnauthorizedException('Credenciales inválidas');
    }
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 30 * 24 * 60 * 60;
    // Retención acotada para quien vuelve a entrar, sin añadir un job.
    await this.prisma.sesionUsuario.deleteMany({ where: { usuarioId: usuario.id, expiraEn: { lte: new Date() } } });
    const sesion = await this.prisma.sesionUsuario.create({ data: { usuarioId: usuario.id, expiraEn: new Date(exp * 1000) } });
    const identidad = { sub: usuario.id, email: usuario.email, nombre: usuario.nombre, rol: usuario.rol };
    const comun = { sub: usuario.id, sid: sesion.id, versionSesion: usuario.versionSesion };
    return {
      access_token: await this.jwtService.signAsync({ ...identidad, ...comun, type: 'access' }),
      refresh_token: await this.jwtService.signAsync({ ...comun, type: 'refresh', iat }, { expiresIn: '30d' }),
      rememberMe: dto.rememberMe ?? true,
      usuario: { ...identidad, foto: usuario.foto },
    };
  }

  private async verificarToken(token: string, tipo: CredencialJwt['type'], ignorarExpiracion = false): Promise<CredencialJwt> {
    if (!token) throw new UnauthorizedException('Token no provisto');
    let payload: unknown;
    try {
      payload = await this.jwtService.verifyAsync(token, { algorithms: ['HS256'], ignoreExpiration: ignorarExpiracion });
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
    if (!esCredencial(payload, tipo)) throw new UnauthorizedException('Credencial de tipo o estructura inválidos');
    return payload;
  }

  private async validarSesion(c: CredencialJwt, incluirFoto = false) {
    // Los fallos de PostgreSQL quedan fuera del catch de credenciales: son 5xx.
    const sesion = await this.prisma.sesionUsuario.findUnique({
      where: { id: c.sid }, include: { usuario: { select: { ...USUARIO_SESION, foto: incluirFoto } } },
    });
    if (!sesion || sesion.usuarioId !== c.sub || sesion.expiraEn.getTime() <= Date.now() ||
        !sesion.usuario.activo || sesion.usuario.versionSesion !== c.versionSesion ||
        (c.type === 'access' && sesion.usuario.rol !== c.rol)) {
      throw new UnauthorizedException('Sesión inválida o revocada');
    }
    return { ...sesion.usuario, expiraEn: sesion.expiraEn };
  }

  /** Única validación de acceso para HTTP y el handshake de Socket.IO. */
  async validarAcceso(token: string): Promise<AccesoAutenticado> {
    const c = await this.verificarToken(token, 'access');
    const u = await this.validarSesion(c);
    return { sub: u.id, email: u.email, nombre: u.nombre, rol: u.rol, sid: c.sid,
      exp: Math.min(c.exp, Math.floor(u.expiraEn.getTime() / 1000)), versionSesion: c.versionSesion };
  }

  async refresh(refreshToken: string, accessToken?: string) {
    const c = await this.verificarToken(refreshToken, 'refresh');
    if (accessToken) {
      const acceso = await this.verificarToken(accessToken, 'access', true);
      if (acceso.sid !== c.sid || acceso.sub !== c.sub || acceso.versionSesion !== c.versionSesion) {
        throw new UnauthorizedException('Las credenciales pertenecen a sesiones distintas');
      }
    }
    const u = await this.validarSesion(c, true);
    const identidad = { sub: u.id, email: u.email, nombre: u.nombre, rol: u.rol };
    return {
      access_token: await this.jwtService.signAsync({ ...identidad, sid: c.sid, versionSesion: c.versionSesion, type: 'access' }),
      usuario: { ...identidad, foto: u.foto },
    };
  }

  /** Revoca el bearer si está presente. Devuelve si su cookie también debe borrarse. */
  async logout(token: string, tipo: CredencialJwt['type'], cookieToken?: string): Promise<boolean> {
    let c: CredencialJwt;
    try { c = await this.verificarToken(token, tipo, true); }
    catch (error) {
      if (error instanceof UnauthorizedException) return tipo === 'refresh' || !cookieToken;
      throw error;
    }
    let borrarCookie = true;
    if (tipo === 'access' && cookieToken) {
      try {
        const cookie = await this.verificarToken(cookieToken, 'refresh', true);
        borrarCookie = cookie.sid === c.sid && cookie.sub === c.sub;
      } catch (error) {
        if (!(error instanceof UnauthorizedException)) throw error;
      }
    }
    await this.prisma.sesionUsuario.deleteMany({ where: { id: c.sid, usuarioId: c.sub } });
    return borrarCookie;
  }

  /** Una consulta por difusión, aunque haya varias pestañas o usuarios conectados. */
  async accesosVigentes(accesos: AccesoAutenticado[]): Promise<Set<AccesoAutenticado>> {
    if (!accesos.length) return new Set();
    const sesiones = await this.prisma.sesionUsuario.findMany({
      where: { id: { in: accesos.map(a => a.sid) }, expiraEn: { gt: new Date() }, usuario: { activo: true } },
      select: { id: true, usuarioId: true, usuario: { select: { rol: true, versionSesion: true } } },
    });
    const porId = new Map(sesiones.map(s => [s.id, s]));
    return new Set(accesos.filter(a => {
      const s = porId.get(a.sid);
      return s && a.sub === s.usuarioId && a.exp * 1000 > Date.now() &&
        a.rol === s.usuario.rol && a.versionSesion === s.usuario.versionSesion;
    }));
  }

  async getPerfil(id: string) {
    return this.usuariosService.findOne(id);
  }

  async updatePerfil(id: string, dto: UpdatePerfilDto) {
    // Lista cerrada también para llamadas internas que no pasen por ValidationPipe.
    const { nombre, email, password, foto } = dto;
    return this.usuariosService.update(id, { nombre, email, password, foto });
  }
}
