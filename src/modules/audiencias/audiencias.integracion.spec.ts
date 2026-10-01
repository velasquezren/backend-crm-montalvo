import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TipoCambioService } from '../tipo-cambio/tipo-cambio.service';
import { AudienciasService } from './audiencias.service';

/**
 * Audiencias contra PostgreSQL real: lo que se prueba es el SQL que decide
 * quién queda fuera y por qué, y que el embudo sume exactamente el total.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';
if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService(URL_TEST);
const service = new AudienciasService(prisma, new TipoCambioService(prisma, new AuditService(prisma)));

const AHORA = new Date('2026-09-30T12:00:00.000Z');
const hace = (dias: number) => new Date(AHORA.getTime() - dias * 24 * 60 * 60 * 1000);

let periodoId: string;
let n = 0;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.mensaje.deleteMany();
  await prisma.conversacion.deleteMany();
  await prisma.ventaImportada.deleteMany();
  await prisma.periodoComision.deleteMany();
  await prisma.cliente.deleteMany();
  periodoId = (await prisma.periodoComision.create({ data: { anio: 2026, mes: 8, tipoCambio: 6.97 } })).id;
});

/** Una paciente Gold (o la categoría que se pida), con su gasto en FileMaker. */
async function paciente(opciones: { telefono?: string; gasto?: number; categoria?: 'GOLD' | 'SILVER' | 'PROSPECTO'; baja?: boolean } = {}) {
  n += 1;
  const pac = `PAC${n}`;
  const cliente = await prisma.cliente.create({
    data: {
      nombre: `Paciente ${String(n).padStart(3, '0')}`,
      telefono: opciones.telefono ?? `+5917${String(n).padStart(7, '0')}`,
      pac,
      categoria: opciones.categoria ?? 'GOLD',
      bajaPromocionesEn: opciones.baja ? hace(5) : null,
    },
  });
  await prisma.ventaImportada.create({
    data: {
      periodoId, pac, precio: opciones.gasto ?? 4_000, fecha: hace(40), detalle: 'Servicio', paciente: 'x',
      canal: 'PROPIO', ingresoNeto: 0, unidadNegocio: 'VARIOS', clasif: 'CONSULTA', tipo: 'A',
    },
  });
  return cliente;
}

async function mensaje(
  clienteId: string,
  datos: { direccion: 'ENTRANTE' | 'SALIENTE'; dias: number; plantillaCategoria?: string; leido?: boolean },
) {
  const conversacion =
    (await prisma.conversacion.findFirst({ where: { clienteId } })) ?? (await prisma.conversacion.create({ data: { clienteId } }));
  await prisma.mensaje.create({
    data: {
      conversacionId: conversacion.id,
      direccion: datos.direccion,
      contenido: 'x',
      createdAt: hace(datos.dias),
      plantillaCategoria: datos.plantillaCategoria ?? null,
      leidoEn: datos.leido ? hace(datos.dias) : null,
    },
  });
}

describe('audiencia de una campaña', () => {
  it('deja fuera a cada una por su primer motivo, y el embudo suma el total', async () => {
    const conBaja = await paciente({ baja: true });
    await paciente({ telefono: '+59122334455' }); // fijo de La Paz: sin WhatsApp
    await paciente({ telefono: '+13055550100' }); // EE. UU.: Meta no entrega marketing
    const campana = await paciente();
    await mensaje(campana.id, { direccion: 'SALIENTE', dias: 10, plantillaCategoria: 'MARKETING' });
    const nuncaEscribio = await paciente({ gasto: 9_000 });
    const conversa = await paciente({ gasto: 5_000 });
    await mensaje(conversa.id, { direccion: 'ENTRANTE', dias: 60 });
    await mensaje(conversa.id, { direccion: 'SALIENTE', dias: 59, leido: true });
    await paciente({ categoria: 'PROSPECTO' }); // fuera de Gold y Silver
    /* Una baja con todo lo demás en contra cuenta UNA vez, como baja. */
    await mensaje(conBaja.id, { direccion: 'SALIENTE', dias: 3, plantillaCategoria: 'MARKETING' });

    const r = await service.segmentar({}, AHORA);
    expect(r.resumen).toEqual({
      enCategorias: 6,
      excluidas: { BAJA_PROMOCIONES: 1, SIN_CELULAR: 2, CAMPANA_RECIENTE: 1, SIN_CONVERSAR: 0 },
      elegibles: 2,
      elegiblesPorCategoria: { GOLD: 2, SILVER: 0, BRONZE: 0, PROSPECTO: 0 },
      elegiblesQueConversaron: 1,
    });
    /* Primero quien más gastó; el total que se pagina es el de elegibles. */
    expect(r.total).toBe(2);
    expect(r.datos.map(p => p.id)).toEqual([nuncaEscribio.id, conversa.id]);
    expect(r.datos[0]).toMatchObject({ gastoRecienteUsd: 9_000, converso: false, leyoUltimo: null });
    /* La fecha sale de un JSON: no puede correrse de zona. */
    expect(r.datos[0].ultimaCompra).toEqual(hace(40));
    expect(r.datos[1]).toMatchObject({ gastoRecienteUsd: 5_000, converso: true, leyoUltimo: true });
  });

  it('«solo quienes conversaron» y el plazo sin campaña cambian el embudo', async () => {
    const campana = await paciente();
    await mensaje(campana.id, { direccion: 'SALIENTE', dias: 10, plantillaCategoria: 'MARKETING' });
    await mensaje(campana.id, { direccion: 'ENTRANTE', dias: 9 });
    await paciente();

    const estricta = await service.segmentar({ soloConversaron: true }, AHORA);
    expect(estricta.resumen.excluidas).toMatchObject({ CAMPANA_RECIENTE: 1, SIN_CONVERSAR: 1 });
    expect(estricta.resumen.elegibles).toBe(0);

    /* Con 7 días, una campaña de hace 10 ya no la deja fuera. */
    const semanal = await service.segmentar({ soloConversaron: true, diasSinCampana: 7 }, AHORA);
    expect(semanal.datos.map(p => p.id)).toEqual([campana.id]);
  });

  it('una plantilla de Utilidad (citas, resultados) no es campaña', async () => {
    const conAviso = await paciente();
    await mensaje(conAviso.id, { direccion: 'SALIENTE', dias: 2, plantillaCategoria: 'UTILITY' });
    expect((await service.segmentar({}, AHORA)).resumen.elegibles).toBe(1);
  });

  it('pagina sobre las elegibles', async () => {
    for (let i = 0; i < 3; i++) await paciente({ gasto: 4_000 + i });
    const pagina2 = await service.segmentar({ limite: 2, pagina: 2 }, AHORA);
    expect(pagina2).toMatchObject({ total: 3, totalPaginas: 2, pagina: 2 });
    expect(pagina2.datos.map(p => p.gastoRecienteUsd)).toEqual([4_000]);
  });
});
