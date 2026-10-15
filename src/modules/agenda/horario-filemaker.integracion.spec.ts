import { INestApplication, Module, ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { PoolConnection } from 'mysql2/promise';
import { PrismaService } from '../../prisma/prisma.service';
import { DirectorioService } from '../directorio/directorio.service';
import { AgendaAdminClient } from './agenda-admin.client';
import * as escritura from './agenda-admin.sql';
import { AgendaMedicosCrmService } from './agenda-medicos-crm.service';
import { AgendaReservasService } from './agenda-reservas.service';
import { AgendaService } from './agenda.service';
import { HorarioFilemakerDto } from './dto/horario-filemaker.dto';
import { HorarioFilemakerController } from './horario-filemaker.controller';
import { HorarioFilemakerGuard } from './horario-filemaker.guard';
import { HorarioFilemakerService } from './horario-filemaker.service';
import { DIAS_AGENDA } from './horario-html';

// PostgreSQL real aislado; MySQL/Directorio son dobles: esta suite prueba el
// contrato HTTP, las revisiones y la recuperación entre dos bases distintas.
const prisma = new PrismaService(process.env.CRM_HORARIOS_TEST_DATABASE_URL ?? 'postgresql://crm_app@127.0.0.1:5433/crm_test');
const token = 'token-sintetico-horarios-filemaker-integracion-2026';
const config = new ConfigService({ FILEMAKER_HORARIOS_ACTIVO: 'on', FILEMAKER_HORARIOS_TOKEN: token });
const agenda = {
  consultar: jest.fn(async () => [7]),
  enTransaccion: jest.fn(async <T>(trabajo: (db: PoolConnection) => Promise<T>) => trabajo({} as PoolConnection)),
};
const directorio = { sincronizarConAgenda: jest.fn(async () => undefined) };
const consultas = { invalidarCatalogo: jest.fn() };
const medico = {
  id: 7, codigo: 'M07', nombre: 'Médico sintético', sigla: 'Dr.', especialidad: 'Consulta', telefono: null,
  estado: 'ACTIVO', precio: '100.00', precioPublico: null, bancoId: null, orden: 0, reservaEnLinea: true, casillasActivas: 0, fotoVersion: null,
};
const ficha = { medico, version: 'a'.repeat(16), casillas: [], grilla: { dias: DIAS_AGENDA, horas: [] } };
const dto = (): HorarioFilemakerDto => ({
  registroId: 'hm-test-7', medicoCodigo: 'M07', revision: 1, minutosConsulta: 30, estado: 'ACTIVO', sucursal: '',
  dias: DIAS_AGENDA.map(dia => ({ dia, mananaInicio: dia === 'Lunes' ? '12:00' : '', mananaUltima: dia === 'Lunes' ? '12:30' : '', tardeInicio: '', tardeUltima: '' })),
});

@Module({
  controllers: [HorarioFilemakerController],
  providers: [HorarioFilemakerService, HorarioFilemakerGuard,
    { provide: ConfigService, useValue: config }, { provide: PrismaService, useValue: prisma },
    { provide: AgendaAdminClient, useValue: agenda }, { provide: DirectorioService, useValue: directorio },
    { provide: AgendaService, useValue: consultas },
  ],
})
class ModuloPrueba {}

describe('FileMaker → horarios: HTTP y PostgreSQL real', () => {
  let app: INestApplication;
  let base: string;
  let servicio: HorarioFilemakerService;
  let guardar: jest.SpyInstance;
  beforeAll(async () => {
    app = await NestFactory.create(ModuloPrueba, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1'); base = await app.getUrl(); servicio = app.get(HorarioFilemakerService);
  });
  beforeEach(async () => {
    await prisma.horarioFilemaker.deleteMany();
    await prisma.auditLog.deleteMany({ where: { entidad: 'HorarioFilemaker' } });
    config.set('FILEMAKER_HORARIOS_ACTIVO', 'on');
    agenda.consultar.mockReset().mockResolvedValue([7]);
    agenda.enTransaccion.mockClear();
    directorio.sincronizarConAgenda.mockReset().mockResolvedValue(undefined);
    consultas.invalidarCatalogo.mockClear();
    jest.spyOn(escritura, 'fichaMedicoAgenda').mockResolvedValue(ficha);
    guardar = jest.spyOn(escritura, 'guardarHorarioAgenda').mockResolvedValue({ ok: true, valor: { encendidas: 0, apagadas: 0, creadas: 2, horarioHtml: '' } });
  });
  afterEach(async () => {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fallo_horario ON "AuditLog"');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fallo_horario()');
    jest.restoreAllMocks();
  });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });
  const post = (body: unknown, secreto: string | null = token) => fetch(`${base}/integraciones/filemaker/horarios`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(secreto ? { Authorization: `Bearer ${secreto}` } : {}) }, body: JSON.stringify(body),
  });

  it('exige credencial, contrato completo y bandera encendida antes de tocar datos', async () => {
    expect((await post(dto(), null)).status).toBe(401);
    expect((await post(dto(), 'token-equivocado-sintetico-2026-xxxx')).status).toBe(401);
    for (const cambio of [{ minutosConsulta: 15 }, { dias: [] }, { revision: 0 }, { medicoCodigo: '' }, { extra: true }]) expect((await post({ ...dto(), ...cambio })).status).toBe(400);
    config.set('FILEMAKER_HORARIOS_ACTIVO', 'off');
    expect((await post(dto())).status).toBe(503);
    expect(await prisma.horarioFilemaker.count()).toBe(0); expect(guardar).not.toHaveBeenCalled();
  });
  it('actualiza las consultas y devuelve éxito solo después de MySQL y la ficha web', async () => {
    const r = await post(dto()); expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ estado: 'SINCRONIZADO', registroId: 'hm-test-7', revision: 1, cupos: 2 });
    expect(guardar.mock.calls[0][3]).toEqual([{ dia: 'Lunes', hora: '12:00' }, { dia: 'Lunes', hora: '12:30' }]);
    expect(directorio.sincronizarConAgenda).toHaveBeenCalledWith(7, expect.objectContaining({ bloques: [{ diaSemana: 1, inicioMinuto: 720, finMinuto: 780 }] }));
    expect((await prisma.horarioFilemaker.findUniqueOrThrow({ where: { codigo: 'M07' } })).pendiente).toBe(false);
  });
  it('ocho reintentos simultáneos producen una recepción y una aplicación', async () => {
    const respuestas = await Promise.all(Array.from({ length: 8 }, () => post(dto())));
    expect(respuestas.map(r => r.status)).toEqual(Array(8).fill(200));
    expect(await prisma.horarioFilemaker.count()).toBe(1); expect(guardar).toHaveBeenCalledTimes(1);
    expect(await prisma.auditLog.count({ where: { entidad: 'HorarioFilemaker' } })).toBe(2);
  });
  it('una revisión antigua o una colisión de revisión no cambia el horario vigente', async () => {
    const nueva = dto(); nueva.revision = 2; nueva.dias[0].mananaUltima = '13:00';
    expect((await post(nueva)).status).toBe(200);
    expect((await post(dto())).status).toBe(409);
    expect((await post({ ...dto(), revision: 2 })).status).toBe(409);
    expect(guardar).toHaveBeenCalledTimes(1);
    expect((await prisma.horarioFilemaker.findUniqueOrThrow({ where: { codigo: 'M07' } })).revision).toBe(2);
  });
  it('un fallo de la agenda conserva el envío y el barrido lo recupera', async () => {
    agenda.enTransaccion.mockRejectedValueOnce(new ServiceUnavailableException());
    expect((await post(dto())).status).toBe(503);
    expect((await prisma.horarioFilemaker.findUniqueOrThrow({ where: { codigo: 'M07' } })).pendiente).toBe(true);
    await servicio.reintentarPendientes();
    expect((await prisma.horarioFilemaker.findUniqueOrThrow({ where: { codigo: 'M07' } })).pendiente).toBe(false);
  });
  it('si falla la ficha web, MySQL aplicado no se confunde con sincronización completa', async () => {
    directorio.sincronizarConAgenda.mockRejectedValueOnce(new Error('fallo sintético de web'));
    expect((await post(dto())).status).toBe(500);
    expect((await prisma.horarioFilemaker.findUniqueOrThrow({ where: { codigo: 'M07' } })).pendiente).toBe(true);
    expect((await post(dto())).status).toBe(200);
    expect(guardar).toHaveBeenCalledTimes(2);
  });
  it('un fallo de confirmación en PostgreSQL conserva la revisión recibida para reintentar', async () => {
    await prisma.$executeRawUnsafe(`CREATE FUNCTION test_fallo_horario() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fallo sintetico'; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER test_fallo_horario BEFORE INSERT ON "AuditLog" FOR EACH ROW WHEN (NEW.accion = 'HORARIO_FILEMAKER_SINCRONIZADO') EXECUTE FUNCTION test_fallo_horario()`);
    expect((await post(dto())).status).toBe(500);
    const fila = await prisma.horarioFilemaker.findUniqueOrThrow({ where: { codigo: 'M07' } });
    expect(fila.pendiente).toBe(true); expect(fila.revision).toBe(1);
    await prisma.$executeRawUnsafe('DROP TRIGGER test_fallo_horario ON "AuditLog"');
    expect((await post(dto())).status).toBe(200);
  });
  it('no combina registros de FileMaker ni médicos con códigos duplicados', async () => {
    expect((await post(dto())).status).toBe(200);
    expect((await post({ ...dto(), revision: 2, registroId: 'otro-registro' })).status).toBe(409);
    agenda.consultar.mockResolvedValueOnce([7, 8]); expect((await post(dto())).status).toBe(409);
    agenda.consultar.mockResolvedValueOnce([]); expect((await post(dto())).status).toBe(404);
    expect(guardar).toHaveBeenCalledTimes(1);
  });
  it('bloquea también la escritura directa del CRM mientras FileMaker es el origen', async () => {
    const crm = new AgendaMedicosCrmService(agenda as unknown as AgendaAdminClient, prisma, directorio as unknown as DirectorioService, {} as AgendaReservasService, servicio);
    await expect(crm.guardarHorario(7, { version: 'a'.repeat(16), activas: [] }, { sub: 'admin-test', email: 'admin@test', nombre: 'Admin', rol: 'ADMIN' })).rejects.toMatchObject({ status: 403 });
    expect(guardar).not.toHaveBeenCalled();
  });
});
