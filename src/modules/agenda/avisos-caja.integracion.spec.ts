import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { WhatsappCloudService } from '../../common/whatsapp/whatsapp-cloud.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LineasWhatsappService } from '../lineas-whatsapp/lineas-whatsapp.service';
import { AgendaConsultaClient } from './agenda-consulta.client';
import { AvisosCajaService } from './avisos-caja.service';

const db = new PrismaService('postgresql://crm_app@127.0.0.1:5433/crm_test');
const admin: UsuarioJwt = { sub: randomUUID(), email: 'admin@caja.test', nombre: 'Admin sintético', rol: 'ADMIN' };
const agente: UsuarioJwt = { ...admin, sub: randomUUID(), rol: 'AGENTE' };
const reserva = { id: 61, fecha: '2026-11-02', hora: '15:00', medicoId: 1, medico: 'Médico sintético', especialidad: null, paciente: 'Paciente sintética',
  telefono: null, ci: '1234567', observaciones: null, estado: 'PAGADO', precio: '400.00', nit: null, razonSocial: null, tieneComprobante: true, registradaEl: null, registradaA: null };
let linea: string;
let filas: unknown[];
const whatsapp = {
  listarPlantillas: jest.fn(async (): Promise<unknown[] | null> => [{ name: 'montalvo_comprobante_caja', language: 'es', status: 'APPROVED' }]),
  enviar: jest.fn(async () => ({ estado: 'ENVIADO' as const, metaMsgId: 'wamid.sintetico' })),
};
const agenda = { habilitada: () => true, ejecutar: jest.fn(async () => filas) };
const lineas = { credenciales: () => ({ token: 'token-sintetico', phoneId: 'phone-sintetico', wabaId: 'waba-sintetica' }) };
const servicio = () => new AvisosCajaService(db, new ConfigService({ AVISO_CAJA_LINEA: linea }), agenda as unknown as AgendaConsultaClient,
  lineas as unknown as LineasWhatsappService, whatsapp as unknown as WhatsappCloudService);

beforeAll(async () => { await db.$connect(); });
afterAll(async () => { await db.$disconnect(); });
beforeEach(async () => {
  await db.numeroCaja.deleteMany();
  const sufijo = randomUUID();
  linea = (await db.lineaWhatsapp.create({ data: { nombre: 'Recepción sintética ' + sufijo, phoneNumberId: 'caja-' + sufijo, tokenEnv: 'TOKEN_SINTETICO_INEXISTENTE' } })).id;
  filas = [reserva];
  whatsapp.listarPlantillas.mockClear();
  whatsapp.enviar.mockClear();
});
afterEach(async () => {
  await db.numeroCaja.deleteMany();
  await db.lineaWhatsapp.deleteMany({ where: { id: linea } });
});

it('solo administración ve o cambia los números de caja', async () => {
  await expect(servicio().vista(agente)).rejects.toThrow('administración');
  await expect(servicio().agregar('Caja', '+59170000001', agente)).rejects.toThrow('administración');
  expect(await db.numeroCaja.count()).toBe(0);
});

it('agrega normalizando el número, rechaza repetidos e inválidos, y la bitácora solo guarda cómo termina', async () => {
  const s = servicio();
  const vista = await s.agregar('  Caja   central ', '70000001', admin);
  expect(vista.numeros).toEqual([expect.objectContaining({ nombre: 'Caja central', telefono: '+59170000001' })]);
  expect(vista.plantilla.estado).toBe('APROBADA');
  await expect(s.agregar('Otra', '+591 70000001', admin)).rejects.toThrow('ya recibe');
  await expect(s.agregar('Mal', '12', admin)).rejects.toThrow('no es válido');
  const id = vista.numeros[0].id;
  const bitacora = await db.auditLog.findFirstOrThrow({ where: { entidad: 'NumeroCaja', entidadId: id } });
  expect(JSON.stringify(bitacora.cambios)).not.toContain('70000001');
  expect((await s.quitar(id, admin)).numeros).toHaveLength(0);
  await db.auditLog.deleteMany({ where: { entidad: 'NumeroCaja', entidadId: id } });
});

it('caben hasta 10 números', async () => {
  const s = servicio();
  for (let i = 0; i < 10; i++) await s.agregar(`Caja ${i}`, `+5917000010${i}`, admin);
  await expect(s.agregar('Once', '+59170000199', admin)).rejects.toThrow('hasta 10');
  await db.auditLog.deleteMany({ where: { entidad: 'NumeroCaja' , usuarioId: admin.sub } });
});

it('con la plantilla aprobada, a cada número le sale la plantilla con los datos de la reserva', async () => {
  await db.numeroCaja.createMany({ data: [
    { nombre: 'Caja 1', telefono: '+59170000011', agregadoPorId: admin.sub },
    { nombre: 'Caja 2', telefono: '+59170000012', agregadoPorId: admin.sub },
  ] });
  expect(await servicio().avisar(61)).toBe(2);
  expect(whatsapp.enviar).toHaveBeenCalledTimes(2);
  expect(whatsapp.enviar).toHaveBeenCalledWith('+59170000011', {
    type: 'template',
    template: {
      name: 'montalvo_comprobante_caja', language: { code: 'es' },
      components: [{ type: 'body', parameters: ['Paciente sintética', '1234567', 'Médico sintético', 'lunes, 2 de noviembre, 15:00', 'Bs 400'].map(text => ({ type: 'text', text })) }],
    },
  }, undefined, expect.objectContaining({ phoneId: 'phone-sintetico' }));
});

it('sin números no le pregunta nada a Meta; con la plantilla sin aprobar no manda nada', async () => {
  expect(await servicio().avisar(61)).toBe(0);
  expect(whatsapp.listarPlantillas).not.toHaveBeenCalled();
  await db.numeroCaja.create({ data: { nombre: 'Caja', telefono: '+59170000021', agregadoPorId: admin.sub } });
  for (const lista of [[{ name: 'montalvo_comprobante_caja', language: 'es', status: 'PENDING' }], [], null]) {
    whatsapp.listarPlantillas.mockResolvedValueOnce(lista);
    expect(await servicio().avisar(61)).toBe(0);
  }
  expect(whatsapp.enviar).not.toHaveBeenCalled();
});

it('una reserva que no está en la agenda no avisa, y un rechazo de Meta no cuenta como enviado', async () => {
  await db.numeroCaja.create({ data: { nombre: 'Caja', telefono: '+59170000031', agregadoPorId: admin.sub } });
  filas = [];
  expect(await servicio().avisar(61)).toBe(0);
  filas = [reserva];
  whatsapp.enviar.mockResolvedValueOnce({ estado: 'NO_SALIO', motivo: 'rechazo sintético' } as never);
  expect(await servicio().avisar(61)).toBe(0);
});

it('el estado de la plantilla se recuerda un rato, y «refrescar» vuelve a preguntar', async () => {
  const s = servicio();
  await s.vista(admin);
  await s.vista(admin);
  expect(whatsapp.listarPlantillas).toHaveBeenCalledTimes(1);
  await s.vista(admin, { refrescar: true });
  expect(whatsapp.listarPlantillas).toHaveBeenCalledTimes(2);
});
