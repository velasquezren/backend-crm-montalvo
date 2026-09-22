import { ConfigService } from '@nestjs/config';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { ServiciosService } from '../servicios/servicios.service';
import { ConversacionesService } from '../conversaciones/conversaciones.service';
import { LineasWhatsappService } from '../lineas-whatsapp/lineas-whatsapp.service';
import { PortalResultadosClient } from './portal-resultados.client';
import { ResultadosService } from './resultados.service';

/**
 * Contra PostgreSQL real (`crm_test` en el :5433 local) y contra un portal de
 * resultados real levantado en loopback — no un mock de `fetch`: lo que se
 * quiere comprobar es el cruce por PAC, la reserva contra el doble envío y el
 * permiso por línea, y eso lo decide Postgres.
 *
 * Solo se stubea `ConversacionesService.enviarPlantilla`, que es la frontera
 * con Meta; que el botón llegue bien al payload lo fija
 * `componentes-plantilla.spec.ts`.
 *
 * `npm run test:integracion`.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';
if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService(URL_TEST);
let service: ResultadosService;
let portalHttp: Server;
let informesDelPortal: Array<Record<string, unknown>> = [];
const plantillasEnviadas: Array<{ conversacionId: string; boton?: string; plantilla: string }> = [];
let fallarEnvio = false;

const LINEA = '11111111-1111-4111-8111-111111111111';
const INFORME = '22222222-2222-4222-8222-222222222222';
const ACCESO = '33333333-3333-4333-8333-333333333333';

const conversacionesStub = {
  async enviarPlantilla(
    conversacionId: string,
    dto: { plantilla: string; boton?: string },
  ) {
    if (fallarEnvio) throw new Error('Meta no disponible');
    plantillasEnviadas.push({ conversacionId, boton: dto.boton, plantilla: dto.plantilla });
    const mensaje = await prisma.mensaje.create({
      data: { conversacionId, direccion: 'SALIENTE', contenido: 'aviso', estadoEnvio: 'ENVIADO' },
    });
    return mensaje;
  },
} as unknown as ConversacionesService;

beforeAll(async () => {
  await prisma.$connect();
  portalHttp = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (req.headers.authorization !== 'Bearer token-de-prueba-integracion') {
      res.writeHead(401).end('{}');
      return;
    }
    const pedido = url.searchParams.get('informeId');
    const datos = pedido ? informesDelPortal.filter(i => i.informeId === pedido) : informesDelPortal;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ datos, total: datos.length }));
  });
  await new Promise<void>(listo => portalHttp.listen(0, '127.0.0.1', listo));
  const puerto = (portalHttp.address() as AddressInfo).port;
  Object.assign(process.env, {
    PORTAL_RESULTADOS_URL: `http://127.0.0.1:${puerto}`,
    PORTAL_RESULTADOS_TOKEN: 'token-de-prueba-integracion',
    RESULTADOS_LINEA_ID: LINEA,
    RESULTADOS_PLANTILLA: 'montalvo_resultado_disponible',
  });
});

afterAll(async () => {
  await new Promise<void>(listo => portalHttp.close(() => listo()));
  await prisma.$disconnect();
});

beforeEach(async () => {
  plantillasEnviadas.length = 0;
  fallarEnvio = false;
  /* Limpieza ACOTADA a las filas propias. Un `deleteMany()` a secas sobre
     líneas o usuarios se lleva por delante la línea comercial inicial y deja
     al resto de la suite sin claves foráneas — pasó, y tumbó seis specs. */
  await prisma.avisoResultado.deleteMany();
  await prisma.mensaje.deleteMany({ where: { conversacion: { lineaId: LINEA } } });
  await prisma.conversacion.deleteMany({ where: { lineaId: LINEA } });
  await prisma.accesoLineaWhatsapp.deleteMany({ where: { lineaId: LINEA } });
  await prisma.lineaWhatsapp.deleteMany({ where: { id: LINEA } });
  await prisma.auditLog.deleteMany({ where: { entidad: 'AvisoResultado' } });
  await prisma.cliente.deleteMany({ where: { pac: { in: ['PAC33009', 'PAC99999'] } } });
  await prisma.usuario.deleteMany({ where: { email: { in: ['asistente@test.local', 'agente@test.local'] } } });

  await prisma.lineaWhatsapp.create({
    data: { id: LINEA, nombre: 'Resultados', tokenEnv: 'TOKEN_X', activa: true, comercial: false },
  });
  await prisma.usuario.createMany({
    data: [
      { id: 'a0000000-0000-4000-8000-000000000001', nombre: 'Asistente', email: 'asistente@test.local', passwordHash: 'x', rol: 'ASISTENTE' },
      { id: 'a0000000-0000-4000-8000-000000000002', nombre: 'Agente', email: 'agente@test.local', passwordHash: 'x', rol: 'AGENTE' },
    ],
  });
  /* Solo el asistente tiene la línea: el permiso es la membresía, no el rango. */
  await prisma.accesoLineaWhatsapp.create({
    data: { usuarioId: 'a0000000-0000-4000-8000-000000000001', lineaId: LINEA },
  });
  await prisma.cliente.create({
    data: { nombre: 'Paciente Vinculado', telefono: '+59170000001', pac: 'PAC33009' },
  });

  informesDelPortal = [
    {
      informeId: INFORME, referenciaCrm: 'PAC33009', estudio: 'Ecografía abdominal',
      fechaEstudio: '2026-09-20', publicadoEn: '2026-09-21T10:00:00.000Z',
      accesoId: ACCESO, accesoVigente: true,
    },
  ];

  const audit = new AuditService(prisma);
  const clientes = new ClientesService(prisma, audit, new ServiciosService(prisma) as ServiciosService);
  const lineas = new LineasWhatsappService(prisma, new ConfigService());
  service = new ResultadosService(prisma, new PortalResultadosClient(), clientes, conversacionesStub, lineas, audit);
});

const asistente = { sub: 'a0000000-0000-4000-8000-000000000001', rol: 'ASISTENTE' } as never;
const agente = { sub: 'a0000000-0000-4000-8000-000000000002', rol: 'AGENTE' } as never;

describe('entrega de resultados contra Postgres real', () => {
  it('el permiso es la línea, no el rango: un agente de ventas no entrega informes', async () => {
    await expect(service.pendientes({}, agente)).rejects.toThrow(/no encontrada/i);
    await expect(service.enviar(INFORME, agente)).rejects.toThrow(/no encontrada/i);
    expect(plantillasEnviadas).toHaveLength(0);
  });

  it('la cola cruza el PAC con la ficha del CRM y marca lo ya avisado', async () => {
    const cola = await service.pendientes({}, asistente);
    expect(cola.total).toBe(1);
    expect(cola.datos[0].paciente?.nombre).toBe('Paciente Vinculado');
    expect(cola.datos[0].aviso).toBeNull();

    await service.enviar(INFORME, asistente);

    const despues = await service.pendientes({}, asistente);
    expect(despues.datos[0].aviso).not.toBeNull();
    expect(despues.datos[0].aviso?.estadoMensaje).toBe('ENVIADO');
  });

  it('envía el ID de acceso como variable del botón, nunca el código', async () => {
    await service.enviar(INFORME, asistente);
    expect(plantillasEnviadas).toEqual([
      { conversacionId: expect.any(String), boton: ACCESO, plantilla: 'montalvo_resultado_disponible' },
    ]);
    const aviso = await prisma.avisoResultado.findUniqueOrThrow({ where: { informeId: INFORME } });
    expect(aviso.mensajeId).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { accion: 'RESULTADO_ENVIADO' } })).toBe(1);
  });

  /* La razón de reservar ANTES de enviar: dos clics no pueden costar dos WhatsApp. */
  it('dos envíos simultáneos del mismo informe mandan UN solo mensaje', async () => {
    const resultados = await Promise.allSettled([
      service.enviar(INFORME, asistente),
      service.enviar(INFORME, asistente),
    ]);
    expect(resultados.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(resultados.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(plantillasEnviadas).toHaveLength(1);
    expect(await prisma.avisoResultado.count()).toBe(1);
  });

  it('si el envío falla, la reserva se libera y el informe vuelve a la cola', async () => {
    fallarEnvio = true;
    await expect(service.enviar(INFORME, asistente)).rejects.toThrow(/Meta no disponible/);
    expect(await prisma.avisoResultado.count()).toBe(0);

    fallarEnvio = false;
    await expect(service.enviar(INFORME, asistente)).resolves.toMatchObject({ enviado: true });
  });

  it('no manda a una puerta cerrada: acceso vencido o revocado se rechaza', async () => {
    informesDelPortal[0].accesoVigente = false;
    await expect(service.enviar(INFORME, asistente)).rejects.toThrow(/vencido o revocado/i);
    expect(await prisma.avisoResultado.count()).toBe(0);
  });

  it('un paciente sin ficha en el CRM se señala, no se inventa', async () => {
    informesDelPortal[0].referenciaCrm = 'PAC99999';
    const cola = await service.pendientes({}, asistente);
    expect(cola.datos[0].paciente).toBeNull();
    await expect(service.enviar(INFORME, asistente)).rejects.toThrow(/PAC99999/);
  });
});
