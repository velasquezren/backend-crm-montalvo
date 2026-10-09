import { PrismaService } from '../../prisma/prisma.service';

import { reclamarReenvio } from './reenvio-manual';
import { ReintentoSalienteService } from './reintento-saliente.service';

/**
 * «Reenviar» contra PostgreSQL de verdad. Lo que importa —que la paciente reciba
 * el mensaje UNA vez— no lo decide el código sino el `UPDATE … WHERE` bajo
 * concurrencia: dos toques a la vez, o el toque y el barrido de reintentos.
 * Con un prisma simulado esa garantía no se puede probar.
 *
 * Se ejecutan con `npm run test:integracion`; `npm test` las salta a propósito.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';
if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService(URL_TEST);
const TELEFONO = '+59170009901';
const USUARIO = 'usuario-reenvio-sintetico';

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await limpiar();
  await prisma.$disconnect();
});

async function limpiar() {
  await prisma.auditLog.deleteMany({ where: { usuarioId: USUARIO } });
  await prisma.cliente.deleteMany({ where: { telefono: TELEFONO } });
}

beforeEach(limpiar);

/** Un saliente que Meta rechazó por facturación, con su id del intento viejo. */
async function rechazadoPorFacturacion() {
  const cliente = await prisma.cliente.create({ data: { nombre: 'Paciente sintética', telefono: TELEFONO } });
  const conversacion = await prisma.conversacion.create({ data: { clienteId: cliente.id } });
  await prisma.mensaje.create({ data: { conversacionId: conversacion.id, direccion: 'ENTRANTE', contenido: 'hola' } });
  return prisma.mensaje.create({
    data: {
      conversacionId: conversacion.id, direccion: 'SALIENTE', contenido: 'Buenos días, ¿en qué la ayudo?',
      estadoEnvio: 'FALLIDO', codigoErrorEnvio: 131042, whatsappMsgId: `wamid.viejo.${Date.now()}`,
    },
  });
}

describe('reclamarReenvio contra PostgreSQL', () => {
  it('deja la fila «sin confirmar», sin el id del intento viejo, y con constancia de quién la reenvió', async () => {
    const m = await rechazadoPorFacturacion();

    expect(await reclamarReenvio(prisma, m, USUARIO)).toBe(true);

    const despues = await prisma.mensaje.findUniqueOrThrow({ where: { id: m.id } });
    expect(despues).toMatchObject({ estadoEnvio: 'INCIERTO', whatsappMsgId: null, codigoErrorEnvio: null, intentosEnvio: 0, proximoIntento: null });
    const constancia = await prisma.auditLog.findMany({ where: { entidadId: m.id, accion: 'MENSAJE_REENVIADO' } });
    expect(constancia).toHaveLength(1);
    expect(constancia[0]).toMatchObject({ usuarioId: USUARIO, cambios: { conversacionId: m.conversacionId, codigoErrorEnvio: 131042 } });
  });

  it('dos toques simultáneos: exactamente uno reenvía, y queda una sola constancia', async () => {
    const m = await rechazadoPorFacturacion();

    const ganadas = await Promise.all([reclamarReenvio(prisma, m, USUARIO), reclamarReenvio(prisma, m, USUARIO)]);

    expect(ganadas.filter(Boolean)).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { entidadId: m.id, accion: 'MENSAJE_REENVIADO' } })).toBe(1);
  });

  /**
   * El barrido de reintentos reclama SIN cambiar el estado (sigue FALLIDO) e
   * incrementa `intentosEnvio`. Si el reenvío solo mirara el estado, los dos
   * despacharían. Lo impide la versión: el reenvío exige el `intentosEnvio` leído.
   */
  it('si el barrido de reintentos se la llevó primero, el reenvío no manda nada', async () => {
    const m = await prisma.mensaje.update({
      where: { id: (await rechazadoPorFacturacion()).id },
      data: { codigoErrorEnvio: null, proximoIntento: new Date(Date.now() - 1000) },
    });
    const barrido = new ReintentoSalienteService(prisma, {} as never);

    expect(await barrido.reclamar(m.id, m.intentosEnvio + 1, new Date())).toBe(true);
    expect(await reclamarReenvio(prisma, m, USUARIO)).toBe(false);

    expect((await prisma.mensaje.findUniqueOrThrow({ where: { id: m.id } })).estadoEnvio).toBe('FALLIDO');
    expect(await prisma.auditLog.count({ where: { entidadId: m.id } })).toBe(0);
  });

  it('no reclama un mensaje que ya no está FALLIDO', async () => {
    const m = await rechazadoPorFacturacion();
    await prisma.mensaje.update({ where: { id: m.id }, data: { estadoEnvio: 'ENTREGADO' } });

    expect(await reclamarReenvio(prisma, m, USUARIO)).toBe(false);
  });
});
