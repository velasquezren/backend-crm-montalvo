import { UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { AccesoMedicoAgendaService } from './acceso-medico-agenda.service';
import { AgendaMedicosCrmService } from './agenda-medicos-crm.service';

/*
 * El permiso se comprueba EN EL SERVICIO, no solo en el decorador del controlador:
 * `@Roles('ADMIN')` es el suelo, y un service que otro módulo llame mañana no pasa
 * por ese guard. La suite de integración prueba el HTTP; aquí, que el service se
 * defiende solo. (Probado rompiéndolo: sin `exigirAdmin`, la suite HTTP seguía en
 * verde porque el guard se adelantaba.)
 */
const usuario = (rol: UsuarioJwt['rol']): UsuarioJwt => ({ sub: 'u1', email: 'u@test', nombre: 'U', rol });

function montar() {
  const prisma = {
    accesoMedicoAgenda: { findUnique: jest.fn(), upsert: jest.fn(), delete: jest.fn() },
    usuario: { findUnique: jest.fn() },
    auditLog: { create: jest.fn() },
    $transaction: jest.fn(),
  };
  const medicos = { ficha: jest.fn() };
  return { servicio: new AccesoMedicoAgendaService(prisma as unknown as PrismaService, medicos as unknown as AgendaMedicosCrmService), prisma, medicos };
}

describe('AccesoMedicoAgendaService: quién puede decidir de quién es un número', () => {
  it.each(['RECEPCION', 'ASISTENTE', 'AGENTE'] as const)('%s no ve, asocia ni quita nada, y no se toca ni la base ni la agenda', async rol => {
    const { servicio, prisma, medicos } = montar();
    await expect(servicio.deMedico(7, usuario(rol))).rejects.toMatchObject({ status: 403 });
    await expect(servicio.autorizar(7, '+59170012345', usuario(rol))).rejects.toMatchObject({ status: 403 });
    await expect(servicio.revocar(7, usuario(rol))).rejects.toMatchObject({ status: 403 });
    expect(prisma.accesoMedicoAgenda.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(medicos.ficha).not.toHaveBeenCalled();
  });

  it('un teléfono que no es un teléfono no reconoce a nadie y ni siquiera consulta la base', async () => {
    const { servicio, prisma } = montar();
    for (const malo of ['', '   ', 'abc', '123']) expect(await servicio.porTelefono(malo)).toBeNull();
    expect(prisma.accesoMedicoAgenda.findUnique).not.toHaveBeenCalled();
  });

  it('el número se busca normalizado a E.164: «70012345» y «+591 700 12345» son el mismo', async () => {
    const { servicio, prisma } = montar();
    prisma.accesoMedicoAgenda.findUnique.mockResolvedValue({ agendaMedicoId: 7, nombreMedico: 'Dra. X' });
    expect(await servicio.porTelefono('70012345')).toEqual({ agendaMedicoId: 7, nombre: 'Dra. X' });
    expect(await servicio.porTelefono('+591 700 12345')).toEqual({ agendaMedicoId: 7, nombre: 'Dra. X' });
    expect(prisma.accesoMedicoAgenda.findUnique).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: { telefono: '+59170012345' } }));
    expect(prisma.accesoMedicoAgenda.findUnique).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: { telefono: '+59170012345' } }));
  });
});
