import { BadRequestException } from '@nestjs/common';

import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TipoCambioService } from './tipo-cambio.service';

/**
 * Pruebas contra el Postgres de verdad (`crm_test` en el :5433 local).
 *
 * Cubre las tres reglas del módulo: (1) "vigente" es el más reciente con
 * fecha <= hoy, nunca uno futuro; (2) una corrección MANUAL siempre gana sobre
 * lo que traiga el espejo automático después; (3) sin ninguna fila todavía,
 * el respaldo fijo no se confunde con un valor real (`fuente: 'RESPALDO'`).
 *
 * `sincronizarAutomatico()` habla con un espejo público por HTTP — se mockea
 * `global.fetch` (red real de terceros, no Prisma) siguiendo el mismo patrón
 * que `whatsapp-cloud.service.spec.ts`.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';

if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService({ datasources: { db: { url: URL_TEST } } });

let service: TipoCambioService;
let usuarioId: string;
const fetchOriginal = global.fetch;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.tipoCambioDiario.deleteMany();
  await prisma.usuario.deleteMany();
  await prisma.$disconnect();
  global.fetch = fetchOriginal;
});

beforeEach(async () => {
  await prisma.auditLog.deleteMany();
  await prisma.tipoCambioDiario.deleteMany();
  await prisma.usuario.deleteMany();

  const usuario = await prisma.usuario.create({
    data: { nombre: 'Admin Prueba', email: `admin-tc-${Date.now()}@test.local`, passwordHash: 'x', rol: 'ADMIN' },
  });
  usuarioId = usuario.id;

  service = new TipoCambioService(prisma, new AuditService(prisma));
  global.fetch = fetchOriginal;
});

function respuestaEspejo(valor: number, fecha: string) {
  return { ok: true, json: async () => ({ tc_oficial: { valor, fecha } }) };
}

describe('TipoCambioService — vigente()', () => {
  it('sin ninguna fila devuelve el respaldo fijo, no un valor real', async () => {
    const resultado = await service.vigente();
    expect(resultado).toEqual({ tipoCambio: 6.97, fecha: null, fuente: 'RESPALDO' });
  });

  it('devuelve el más reciente con fecha <= hoy, ignorando uno futuro', async () => {
    await prisma.tipoCambioDiario.create({ data: { fecha: new Date('2026-08-20'), valor: 11.4, fuente: 'AUTOMATICO' } });
    await prisma.tipoCambioDiario.create({ data: { fecha: new Date('2026-08-24'), valor: 11.54, fuente: 'AUTOMATICO' } });
    /* Fecha futura respecto del reloj real: nunca debe ganarle a la de ayer. */
    await prisma.tipoCambioDiario.create({ data: { fecha: new Date('2099-01-01'), valor: 99, fuente: 'MANUAL' } });

    const resultado = await service.vigente();
    expect(resultado).toEqual({ tipoCambio: 11.54, fecha: '2026-08-24', fuente: 'AUTOMATICO' });
  });
});

describe('TipoCambioService — historial()', () => {
  it('acota al mes calendario pedido, ordenado ascendente', async () => {
    await prisma.tipoCambioDiario.createMany({
      data: [
        { fecha: new Date('2026-07-31'), valor: 11.3, fuente: 'AUTOMATICO' },
        { fecha: new Date('2026-08-05'), valor: 11.4, fuente: 'AUTOMATICO' },
        { fecha: new Date('2026-08-01'), valor: 11.35, fuente: 'AUTOMATICO' },
        { fecha: new Date('2026-09-01'), valor: 11.6, fuente: 'AUTOMATICO' },
      ],
    });

    const fechas = (await service.historial(2026, 8)).map(f => f.fecha.toISOString().slice(0, 10));
    expect(fechas).toEqual(['2026-08-01', '2026-08-05']);
  });
});

describe('TipoCambioService — corregirManual()', () => {
  it('crea la fila como MANUAL y deja rastro en AuditLog', async () => {
    const fila = await service.corregirManual('2026-08-25', 11.54, usuarioId);
    expect(fila.fuente).toBe('MANUAL');
    expect(Number(fila.valor)).toBe(11.54);
    expect(fila.actualizadoPorId).toBe(usuarioId);

    const auditoria = await prisma.auditLog.findFirst({ where: { entidad: 'TipoCambioDiario', entidadId: '2026-08-25' } });
    expect(auditoria).not.toBeNull();
    expect(auditoria?.accion).toBe('CORRECCION_MANUAL');
    expect(auditoria?.usuarioId).toBe(usuarioId);
  });

  it('sobreescribe un valor automático previo del mismo día', async () => {
    await prisma.tipoCambioDiario.create({ data: { fecha: new Date('2026-08-25'), valor: 11.5, fuente: 'AUTOMATICO' } });
    const fila = await service.corregirManual('2026-08-25', 11.6, usuarioId);
    expect(fila.fuente).toBe('MANUAL');
    expect(Number(fila.valor)).toBe(11.6);
  });

  it('rechaza una fecha con formato inválido antes de tocar la base', async () => {
    await expect(service.corregirManual('25-08-2026', 11.5, usuarioId)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('TipoCambioService — sincronizarAutomatico()', () => {
  it('guarda el valor del espejo cuando no hay nada para ese día', async () => {
    global.fetch = jest.fn().mockResolvedValue(respuestaEspejo(11.54, '2026-08-25')) as unknown as typeof fetch;

    const resultado = await service.sincronizarAutomatico();
    expect(resultado).toEqual({ actualizado: true, motivo: 'ok', fecha: '2026-08-25', valor: 11.54 });

    const fila = await prisma.tipoCambioDiario.findUnique({ where: { fecha: new Date('2026-08-25') } });
    expect(fila?.fuente).toBe('AUTOMATICO');
    expect(Number(fila?.valor)).toBe(11.54);
  });

  it('no pisa un valor ya corregido a mano ese mismo día', async () => {
    await service.corregirManual('2026-08-25', 11.6, usuarioId);
    global.fetch = jest.fn().mockResolvedValue(respuestaEspejo(11.54, '2026-08-25')) as unknown as typeof fetch;

    const resultado = await service.sincronizarAutomatico();
    expect(resultado).toEqual({ actualizado: false, motivo: 'ya_hay_valor_manual', fecha: '2026-08-25' });

    const fila = await prisma.tipoCambioDiario.findUnique({ where: { fecha: new Date('2026-08-25') } });
    expect(fila?.fuente).toBe('MANUAL');
    expect(Number(fila?.valor)).toBe(11.6);
  });

  it('no reescribe si el valor no cambió', async () => {
    global.fetch = jest.fn().mockResolvedValue(respuestaEspejo(11.54, '2026-08-25')) as unknown as typeof fetch;
    await service.sincronizarAutomatico();

    const resultado = await service.sincronizarAutomatico();
    expect(resultado).toEqual({ actualizado: false, motivo: 'sin_cambios', fecha: '2026-08-25', valor: 11.54 });
  });

  it('no lanza si el espejo no responde', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('sin red')) as unknown as typeof fetch;

    const resultado = await service.sincronizarAutomatico();
    expect(resultado).toEqual({ actualizado: false, motivo: 'fetch_fallido' });
  });

  it('no lanza y no guarda nada si la respuesta viene sin la forma esperada', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as unknown as typeof fetch;

    const resultado = await service.sincronizarAutomatico();
    expect(resultado).toEqual({ actualizado: false, motivo: 'respuesta_invalida' });
    expect(await prisma.tipoCambioDiario.count()).toBe(0);
  });
});
