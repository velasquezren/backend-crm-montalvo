import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { PrismaService } from '../../prisma/prisma.service';
import { QueryKpisDto } from './dto/query-kpis.dto';
import { KpisService, rangosDe } from './kpis.service';

/**
 * Contra PostgreSQL real (`crm_test` en el :5433 local). El embudo es SQL a
 * mano —«el primer mensaje humano POSTERIOR al lead»—, y eso solo lo puede
 * comprobar Postgres: el doble de Prisma que había aquí no ejecutaba nada.
 *
 * Los datos viven en marzo de 2030 para no cruzarse con lo que crean las
 * demás suites en la misma base, que siempre usan la fecha actual.
 *
 * `npm run test:integracion`.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';
if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService(URL_TEST);
const PREFIJO = '+5917999';
const AGENTE = 'b0000000-0000-4000-8000-00000000000a';
const OTRA_AGENTE = 'b0000000-0000-4000-8000-00000000000b';

/* 31 de marzo de 2030 a las 22:00 en La Paz: ya es 1 de abril en UTC. */
const AHORA = new Date('2030-04-01T02:00:00.000Z');
const en = (iso: string) => new Date(iso);

let n = 0;
async function paciente() {
  n += 1;
  return prisma.cliente.create({ data: { nombre: `Paciente KPI ${n}`, telefono: `${PREFIJO}${String(n).padStart(4, '0')}` } });
}

/** Un lead con, opcionalmente, mensajes de la clínica en su conversación. */
async function lead(
  datos: { origen: 'WHATSAPP_DIRECTO' | 'FACEBOOK_LEAD_AD' | 'IMPORTACION'; creado: string; estado?: 'CONVERTIDO'; agenteId?: string },
  salientes: Array<{ en: string; automatico?: boolean }> = [],
) {
  const cliente = await paciente();
  await prisma.lead.create({
    data: { clienteId: cliente.id, origen: datos.origen, estado: datos.estado, agenteId: datos.agenteId, createdAt: en(datos.creado) },
  });
  if (salientes.length) {
    const conversacion = await prisma.conversacion.create({ data: { clienteId: cliente.id } });
    for (const s of salientes) {
      await prisma.mensaje.create({
        data: { conversacionId: conversacion.id, direccion: 'SALIENTE', contenido: 'x', automatico: s.automatico ?? false, createdAt: en(s.en) },
      });
    }
  }
  return cliente;
}

async function limpiar() {
  await prisma.venta.deleteMany({ where: { cliente: { telefono: { startsWith: PREFIJO } } } });
  await prisma.cliente.deleteMany({ where: { telefono: { startsWith: PREFIJO } } });
  await prisma.usuario.deleteMany({ where: { id: { in: [AGENTE, OTRA_AGENTE] } } });
}

beforeAll(async () => {
  await prisma.$connect();
  await limpiar();
  await prisma.usuario.createMany({
    data: [
      { id: AGENTE, nombre: 'Agente KPI', email: 'kpi-a@test.local', passwordHash: 'x', rol: 'AGENTE' },
      { id: OTRA_AGENTE, nombre: 'Otra KPI', email: 'kpi-b@test.local', passwordHash: 'x', rol: 'AGENTE' },
    ],
  });

  /* Respondido por una persona a los 30 min. */
  await lead({ origen: 'WHATSAPP_DIRECTO', creado: '2030-03-10T14:00:00Z', agenteId: AGENTE }, [{ en: '2030-03-10T14:30:00Z' }]);
  /* Solo el acuse automático: NO es atención. */
  await lead({ origen: 'FACEBOOK_LEAD_AD', creado: '2030-03-11T14:00:00Z' }, [{ en: '2030-03-11T14:01:00Z', automatico: true }]);
  /* El único mensaje es ANTERIOR al lead: tampoco cuenta. */
  await lead({ origen: 'FACEBOOK_LEAD_AD', creado: '2030-03-12T14:00:00Z' }, [{ en: '2030-03-05T14:00:00Z' }]);
  /* Respondido a las tres horas y con venta. Creado el 1 de marzo a las 22:00 de La Paz. */
  const conVenta = await lead(
    { origen: 'FACEBOOK_LEAD_AD', creado: '2030-03-02T02:00:00Z', estado: 'CONVERTIDO' },
    [{ en: '2030-03-02T05:00:00Z' }],
  );
  /* De otra agente: fuera del alcance de AGENTE. */
  await lead({ origen: 'WHATSAPP_DIRECTO', creado: '2030-03-20T14:00:00Z', agenteId: OTRA_AGENTE });
  /* El histórico importado nunca entra en el embudo. */
  await lead({ origen: 'IMPORTACION', creado: '2030-03-15T14:00:00Z' });
  /* 1 de abril a las 00:30 en La Paz: fuera de marzo aunque en UTC falten horas. */
  await lead({ origen: 'WHATSAPP_DIRECTO', creado: '2030-04-01T04:30:00Z' });

  await prisma.venta.createMany({
    data: [
      { clienteId: conVenta.id, agenteId: AGENTE, producto: 'Ecografía', monto: 300, estado: 'GANADA', createdAt: en('2030-03-05T15:00:00Z') },
      { clienteId: conVenta.id, agenteId: AGENTE, producto: 'Consulta', monto: 100, estado: 'GANADA', createdAt: en('2030-02-10T15:00:00Z') },
    ],
  });
});

afterAll(async () => {
  await limpiar();
  await prisma.$disconnect();
});

describe('KPIs · el embudo se mide sobre los mensajes', () => {
  it('respondido = mensaje humano posterior al lead; el acuse y los mensajes previos no cuentan', async () => {
    const r = await new KpisService(prisma).resumen('MES', undefined, AHORA);
    expect(r.embudo).toMatchObject({ captados: 5, respondidos: 2, respondidosEnUnaHora: 1, convertidos: 1 });
    /* Mediana de 30 y 180 minutos. */
    expect(r.embudo.medianaRespuestaMinutos).toBe(105);
  });

  it('por canal, ordenado por volumen, sin el histórico importado', async () => {
    const r = await new KpisService(prisma).resumen('MES', undefined, AHORA);
    expect(r.canales.map(c => [c.origen, c.captados, c.respondidos])).toEqual([
      ['FACEBOOK_LEAD_AD', 3, 1],
      ['WHATSAPP_DIRECTO', 2, 1],
    ]);
  });

  it('una agente ve lo suyo y el pool, no lo de otra agente', async () => {
    const r = await new KpisService(prisma).resumen('MES', AGENTE, AHORA);
    expect(r.embudo.captados).toBe(4);
    expect(r.ventas.cantidad).toBe(1);
  });

  /* La clave de caché lleva el agente: sin ella, durante 15 s el resumen de
     una agente se servía a otra. */
  it('la caché no cruza el resumen de una agente con el global', async () => {
    const servicio = new KpisService(prisma);
    const deAgente = await servicio.resumen('MES', AGENTE, AHORA);
    const global = await servicio.resumen('MES', undefined, AHORA);
    expect([deAgente.embudo.captados, global.embudo.captados]).toEqual([4, 5]);
  });

  it('la serie parte los días en La Paz y rellena los días sin leads', async () => {
    const r = await new KpisService(prisma).resumen('MES', undefined, AHORA);
    expect(r.serie).toHaveLength(31);
    expect(r.serie[0]).toEqual({ fecha: '2030-03-01', captados: 1, respondidos: 1 });
    expect(r.serie[1]).toEqual({ fecha: '2030-03-02', captados: 0, respondidos: 0 });
    expect(r.serie.reduce((s, d) => s + d.captados, 0)).toBe(5);
  });

  it('compara las ventas con el mismo tramo del mes anterior', async () => {
    const r = await new KpisService(prisma).resumen('MES', undefined, AHORA);
    expect(r.ventas).toMatchObject({ total: 300, cantidad: 1, ticketPromedio: 300, anterior: { total: 100, cantidad: 1 } });
  });
});

describe('KPIs · periodos', () => {
  it('«este mes» se compara con el mes anterior hasta el mismo punto, no completo', () => {
    const diez = new Date('2030-03-10T16:00:00.000Z'); // 10 de marzo, 12:00 en La Paz
    const { actual, anterior } = rangosDe('MES', diez);
    expect(actual.desde.toISOString()).toBe('2030-03-01T04:00:00.000Z');
    expect(anterior.desde.toISOString()).toBe('2030-02-01T04:00:00.000Z');
    expect(anterior.hasta.toISOString()).toBe('2030-02-10T16:00:00.000Z');
  });

  it('el mes anterior es completo y se compara con el previo completo', () => {
    const { actual, anterior } = rangosDe('MES_ANTERIOR', AHORA);
    expect([actual.desde, actual.hasta, anterior.desde].map(d => d.toISOString())).toEqual([
      '2030-02-01T04:00:00.000Z',
      '2030-03-01T04:00:00.000Z',
      '2030-01-01T04:00:00.000Z',
    ]);
  });

  it('un periodo desconocido es un 400, no un 500', async () => {
    const errores = await validate(plainToInstance(QueryKpisDto, { periodo: 'SIEMPRE' }));
    expect(errores).toHaveLength(1);
  });
});
