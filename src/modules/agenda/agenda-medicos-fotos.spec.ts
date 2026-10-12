import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { DirectorioService } from '../directorio/directorio.service';
import { AgendaAdminClient } from './agenda-admin.client';
import { MedicoPorCodigo } from './agenda-admin.sql';
import { AgendaMedicosCrmService, fotoDelMedico } from './agenda-medicos-crm.service';
import { AgendaReservasService } from './agenda-reservas.service';

/*
 * La cara de cada médico en el CRM. La agenda (MySQL) y el directorio son
 * dobles: aquí se prueba qué foto gana, cómo se cruzan los códigos del
 * historial de servicios y qué pasa cuando algo no responde.
 */

const VERSION = 'a1b2c3d4e5f60718';
const ADMIN: UsuarioJwt = { sub: 'u-admin', email: 'a@x', nombre: 'Admin', rol: 'ADMIN' };
const ASISTENTE: UsuarioJwt = { sub: 'u-asis', email: 's@x', nombre: 'Asistente', rol: 'ASISTENTE' };

const medico = (id: number, codigo: string, estado = 'ACTIVO', fotoVersion: string | null = VERSION): MedicoPorCodigo =>
  ({ id, codigo, nombre: `Dr. Médico ${id}`, especialidad: 'Pediatría', estado, fotoVersion });

function armar(todos: MedicoPorCodigo[] = []) {
  const consultar = jest.fn(async () => todos);
  const directorio = {
    resumenDeAgenda: jest.fn(async () => new Map<number, { perfilId: string; publicado: boolean; fotoUrl: string | null }>()),
    fichaDeAgenda: jest.fn(async () => ({ id: 'perfil-1', fotoUrl: null })),
    subirFoto: jest.fn(async () => undefined),
    bytesDeFotoPublicaDeAgenda: jest.fn(async (): Promise<{ bytes: Buffer; tipo: string } | null> => null),
  };
  const reservas = { fotoVigente: jest.fn(async (): Promise<{ bytes: Buffer; tipo: string } | null> => null) };
  const servicio = new AgendaMedicosCrmService(
    { consultar } as unknown as AgendaAdminClient, {} as PrismaService,
    directorio as unknown as DirectorioService, reservas as unknown as AgendaReservasService,
  );
  return { servicio, consultar, directorio, reservas };
}

describe('qué foto muestra el CRM de un médico', () => {
  it('la de su ficha web gana; si no tiene, la de la agenda, solo de un médico activo', () => {
    expect(fotoDelMedico({ id: 7, estado: 'ACTIVO', fotoVersion: VERSION }, 'https://r2/firmada')).toEqual({ fotoUrl: 'https://r2/firmada', fotoOrigen: 'WEB' });
    expect(fotoDelMedico({ id: 7, estado: 'ACTIVO', fotoVersion: VERSION }, null)).toEqual({ fotoUrl: `/publico/agenda/fotos/7/${VERSION}`, fotoOrigen: 'AGENDA' });
    /* La URL pública de la agenda no sirve fotos de inactivos: no se promete una que dará 404. */
    expect(fotoDelMedico({ id: 7, estado: 'INACTIVO', fotoVersion: VERSION }, null)).toEqual({ fotoUrl: null, fotoOrigen: null });
    expect(fotoDelMedico({ id: 7, estado: 'ACTIVO', fotoVersion: null }, undefined)).toEqual({ fotoUrl: null, fotoOrigen: null });
  });
});

describe('médicos por código de FileMaker (el historial de servicios)', () => {
  it('cruza sin mayúsculas ni espacios, deja fuera lo que la agenda no tiene y pone la foto', async () => {
    const { servicio, directorio } = armar([medico(7, 'M07'), medico(9, 'm09', 'INACTIVO'), medico(11, 'M11')]);
    directorio.resumenDeAgenda.mockResolvedValueOnce(new Map([[11, { perfilId: 'p', publicado: true, fotoUrl: 'https://r2/web-11' }]]));
    const { datos } = await servicio.porCodigos([' m07 ', 'M09', 'M11', 'NO-EXISTE']);
    expect(datos).toEqual([
      { codigo: 'M07', id: 7, nombre: 'Dr. Médico 7', especialidad: 'Pediatría', activo: true, fotoUrl: `/publico/agenda/fotos/7/${VERSION}`, fotoOrigen: 'AGENDA' },
      { codigo: 'm09', id: 9, nombre: 'Dr. Médico 9', especialidad: 'Pediatría', activo: false, fotoUrl: null, fotoOrigen: null },
      { codigo: 'M11', id: 11, nombre: 'Dr. Médico 11', especialidad: 'Pediatría', activo: true, fotoUrl: 'https://r2/web-11', fotoOrigen: 'WEB' },
    ]);
    expect(directorio.resumenDeAgenda).toHaveBeenCalledWith([7, 9, 11]);
  });

  it('un código repetido en la agenda se queda con el médico activo', async () => {
    const { servicio } = armar([medico(3, 'M01'), medico(2, 'M01', 'INACTIVO')]);
    expect((await servicio.porCodigos(['M01'])).datos.map(m => m.id)).toEqual([3]);
  });

  it('lee la agenda una vez para varias pantallas, y nada si no hay códigos', async () => {
    const { servicio, consultar } = armar([medico(7, 'M07')]);
    expect(await servicio.porCodigos([' ', ''])).toEqual({ datos: [] });
    expect(consultar).not.toHaveBeenCalled();
    await servicio.porCodigos(['M07']);
    await servicio.porCodigos(['M07', 'M08']);
    expect(consultar).toHaveBeenCalledTimes(1);
  });

  it('si la agenda no responde, llega vacío y la pantalla sigue con las iniciales', async () => {
    const { servicio, consultar } = armar();
    consultar.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    expect(await servicio.porCodigos(['M07'])).toEqual({ datos: [] });
  });
});

describe('usar la foto de la agenda en la ficha web', () => {
  it('la sube a la ficha como una subida más, con el tipo que trae', async () => {
    const { servicio, reservas, directorio } = armar();
    jest.spyOn(servicio, 'ficha').mockResolvedValue({} as Awaited<ReturnType<AgendaMedicosCrmService['ficha']>>);
    const bytes = Buffer.from('jpeg');
    reservas.fotoVigente.mockResolvedValueOnce({ bytes, tipo: 'image/jpeg' });
    await servicio.usarFotoDeAgenda(7, ADMIN);
    expect(directorio.subirFoto).toHaveBeenCalledWith('perfil-1', { originalname: 'agenda-7.jpg', mimetype: 'image/jpeg', size: 4, buffer: bytes }, 'u-admin');
  });

  it('sin foto en la agenda es 404, y quien no edita la agenda no puede', async () => {
    const { servicio, directorio } = armar();
    await expect(servicio.usarFotoDeAgenda(7, ADMIN)).rejects.toBeInstanceOf(NotFoundException);
    await expect(servicio.usarFotoDeAgenda(7, ASISTENTE)).rejects.toBeInstanceOf(ForbiddenException);
    expect(directorio.subirFoto).not.toHaveBeenCalled();
  });
});

describe('la foto que va en la imagen del horario', () => {
  it('la publicada de la ficha web primero, si no la de la agenda; un fallo es «sin foto»', async () => {
    const { servicio, directorio, reservas } = armar();
    const web = { bytes: Buffer.from('web'), tipo: 'image/png' };
    const agenda = { bytes: Buffer.from('agenda'), tipo: 'image/jpeg' };
    directorio.bytesDeFotoPublicaDeAgenda.mockResolvedValueOnce(web);
    expect(await servicio.fotoParaImagen(7)).toBe(web);
    expect(reservas.fotoVigente).not.toHaveBeenCalled();

    reservas.fotoVigente.mockResolvedValueOnce(agenda);
    expect(await servicio.fotoParaImagen(7)).toBe(agenda);

    directorio.bytesDeFotoPublicaDeAgenda.mockRejectedValueOnce(new Error('R2 caído'));
    expect(await servicio.fotoParaImagen(7)).toBeNull();
  });
});
