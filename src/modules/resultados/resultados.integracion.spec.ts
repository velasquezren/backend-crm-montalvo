import { ConflictException, NotFoundException } from '@nestjs/common';
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
 * Solo se stubea `ConversacionesService.enviarPlantillaDelSistema`, que es la frontera
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
const plantillasEnviadas: Array<{ conversacionId: string; boton?: string; plantilla: string; imagenCabecera?: string }> = [];
let fallarEnvio = false;
let renovaciones = 0;

const LINEA = '11111111-1111-4111-8111-111111111111';
const INFORME = '22222222-2222-4222-8222-222222222222';
const ACCESO = '33333333-3333-4333-8333-333333333333';

const conversacionesStub = {
  async enviarPlantillaDelSistema(
    conversacionId: string,
    dto: { plantilla: string; boton?: string; imagenCabecera?: string; contenido: string },
  ) {
    if (fallarEnvio) throw new Error('Meta no disponible');
    plantillasEnviadas.push({ conversacionId, boton: dto.boton, plantilla: dto.plantilla, ...(dto.imagenCabecera ? { imagenCabecera: dto.imagenCabecera } : {}) });
    const mensaje = await prisma.mensaje.create({
      data: { conversacionId, direccion: 'SALIENTE', contenido: dto.contenido, estadoEnvio: 'ENVIADO' },
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
    /* Renovar: como el portal real, extiende el mismo acceso 30 días. */
    const renovar = url.pathname.match(/informes\/([^/]+)\/acceso\/renovar$/);
    if (req.method === 'POST' && renovar) {
      const informe = informesDelPortal.find(i => i.informeId === renovar[1]);
      if (!informe) { res.writeHead(404).end('{}'); return; }
      renovaciones += 1;
      Object.assign(informe, { accesoVigente: true, accesoExpiraEn: new Date(Date.now() + 30 * 86400_000).toISOString() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accesoId: informe.accesoId, expiraEn: informe.accesoExpiraEn }));
      return;
    }
    /* Los filtros, como el portal real (probados de verdad en su propia suite):
       aquí solo hace falta que se comporten igual. */
    const q = url.searchParams;
    const buscar = q.get('buscar')?.toLowerCase();
    const coincide = (i: Record<string, unknown>) => {
      const p = i.paciente as { nombre: string; pac: string | null; ci: string | null };
      return !buscar || [p.nombre, p.pac, p.ci].some(v => v?.toLowerCase().includes(buscar));
    };
    const vigenteSinAbrir = (i: Record<string, unknown>) => i.accesoVigente === true && !i.abiertoEn;
    if (url.pathname.endsWith('/informes/panorama')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        totales: {
          todos: informesDelPortal.length,
          abiertos: informesDelPortal.filter(i => i.abiertoEn).length,
          vencidosSinAbrir: informesDelPortal.filter(i => !i.accesoVigente && !i.abiertoEn).length,
        },
        vigentesSinAbrir: informesDelPortal.filter(vigenteSinAbrir).map(i => i.informeId),
        truncado: false,
        ...(buscar ? { coinciden: informesDelPortal.filter(i => vigenteSinAbrir(i) && coincide(i)).map(i => i.informeId) } : {}),
      }));
      return;
    }
    const ids = q.get('ids')?.split(',');
    const datos = informesDelPortal
      .filter(i => !q.get('informeId') || i.informeId === q.get('informeId'))
      .filter(i => !ids || ids.includes(i.informeId as string))
      .filter(i => q.get('abierto') === null || Boolean(i.abiertoEn) === (q.get('abierto') === 'true'))
      .filter(i => q.get('vigente') === null || i.accesoVigente === (q.get('vigente') === 'true'))
      .filter(coincide);
    if (ids) datos.sort((a, b) => ids.indexOf(a.informeId as string) - ids.indexOf(b.informeId as string));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ datos, total: datos.length }));
  });
  await new Promise<void>(listo => portalHttp.listen(0, '127.0.0.1', listo));
  const puerto = (portalHttp.address() as AddressInfo).port;
  Object.assign(process.env, {
    PORTAL_RESULTADOS_URL: `http://127.0.0.1:${puerto}`,
    PORTAL_RESULTADOS_TOKEN: 'token-de-prueba-integracion',
    RESULTADOS_LINEA_ID: LINEA,
    RESULTADOS_PLANTILLA: 'montalvo_informe_disponible',
  });
});

afterAll(async () => {
  await new Promise<void>(listo => portalHttp.close(() => listo()));
  await prisma.$disconnect();
});

beforeEach(async () => {
  plantillasEnviadas.length = 0;
  fallarEnvio = false;
  renovaciones = 0;
  /* Limpieza ACOTADA a las filas propias. Un `deleteMany()` a secas sobre
     líneas o usuarios se lleva por delante la línea comercial inicial y deja
     al resto de la suite sin claves foráneas — pasó, y tumbó seis specs. */
  await prisma.avisoResultado.deleteMany();
  await prisma.mensaje.deleteMany({ where: { conversacion: { lineaId: LINEA } } });
  await prisma.conversacion.deleteMany({ where: { lineaId: LINEA } });
  await prisma.accesoLineaWhatsapp.deleteMany({ where: { lineaId: LINEA } });
  await prisma.lineaWhatsapp.deleteMany({ where: { id: LINEA } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ entidad: 'AvisoResultado' }, { usuarioId: 'a0000000-0000-4000-8000-000000000001' }] } });
  /* Por PAC y por teléfono: otra suite puede haber dejado una ficha con el
     mismo número de prueba y el índice único de `telefono` rebotaría. */
  await prisma.cliente.deleteMany({
    where: { OR: [{ pac: { in: ['PAC33009', 'PAC99999'] } }, { telefono: { in: ['+59170000001', '+59170000091', '+59170000092', '+59170000093', '+59170000094'] } }] },
  });
  await prisma.usuario.deleteMany({ where: { email: { in: ['asistente@test.local', 'agente@test.local', 'recepcion@test.local'] } } });

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
      informeId: INFORME, paciente: { nombre: 'Paciente Vinculado', pac: 'PAC33009', ci: null }, estudio: 'Ecografía abdominal',
      fechaEstudio: '2026-09-20', publicadoEn: '2026-09-21T10:00:00.000Z',
      accesoId: ACCESO, accesoVigente: true,
      accesoExpiraEn: new Date(Date.now() + 20 * 86400_000).toISOString(), abiertoEn: null,
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

  /* El caso real de producción: la línea de resultados es la de Recepción, y
     un agente de ventas y la recepcionista también la atienden. Tener la
     línea no basta; el rol tiene que ser el que entrega. */
  it('tener acceso a la línea no basta: ni un agente ni recepción entregan aunque la atiendan', async () => {
    await prisma.usuario.create({
      data: { id: 'a0000000-0000-4000-8000-000000000003', nombre: 'Recepción', email: 'recepcion@test.local', passwordHash: 'x', rol: 'RECEPCION' },
    });
    await prisma.accesoLineaWhatsapp.createMany({
      data: [
        { usuarioId: 'a0000000-0000-4000-8000-000000000002', lineaId: LINEA },
        { usuarioId: 'a0000000-0000-4000-8000-000000000003', lineaId: LINEA },
      ],
    });
    const recepcion = { sub: 'a0000000-0000-4000-8000-000000000003', rol: 'RECEPCION' } as never;
    for (const quien of [agente, recepcion]) {
      await expect(service.pendientes({}, quien)).rejects.toThrow(/no encontrada/i);
      await expect(service.enviar(INFORME, quien)).rejects.toThrow(/no encontrada/i);
    }
    expect(plantillasEnviadas).toHaveLength(0);
    expect(await prisma.avisoResultado.count()).toBe(0);
  });

  it('administración entrega sin necesitar la línea', async () => {
    const admin = { sub: 'a0000000-0000-4000-8000-000000000001', rol: 'ADMIN' } as never;
    await expect(service.pendientes({}, admin)).resolves.toMatchObject({ total: 1 });
  });

  it('la cola cruza el PAC con la ficha del CRM y marca lo ya avisado', async () => {
    const cola = await service.pendientes({}, asistente);
    expect(cola.total).toBe(1);
    expect(cola.datos[0].paciente?.nombre).toBe('Paciente Vinculado');
    expect(cola.datos[0].aviso).toBeNull();

    await service.enviar(INFORME, asistente);

    /* Avisado: sale de «por avisar» y pasa a «esperando lectura», con su aviso. */
    const porAvisar = await service.pendientes({}, asistente);
    expect(porAvisar.total).toBe(0);
    expect(porAvisar.contadores).toMatchObject({ POR_AVISAR: 0, ESPERANDO: 1 });
    const esperando = await service.pendientes({ estado: 'ESPERANDO' }, asistente);
    expect(esperando.datos[0].aviso?.estadoMensaje).toBe('ENVIADO');
  });

  it('envía el ID de acceso como variable del botón, nunca el código', async () => {
    await service.enviar(INFORME, asistente);
    expect(plantillasEnviadas).toEqual([
      { conversacionId: expect.any(String), boton: ACCESO, plantilla: 'montalvo_informe_disponible' },
    ]);
    const aviso = await prisma.avisoResultado.findUniqueOrThrow({ where: { informeId: INFORME } });
    expect(aviso.mensajeId).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { accion: 'RESULTADO_ENVIADO' } })).toBe(1);
  });

  it('con una plantilla de cabecera de imagen configurada, el envío lleva la imagen', async () => {
    process.env.RESULTADOS_PLANTILLA_IMAGEN = 'https://resultados.example/resultados/imagen-aviso';
    try {
      await service.enviar(INFORME, asistente);
      expect(plantillasEnviadas[0]).toMatchObject({ boton: ACCESO, imagenCabecera: 'https://resultados.example/resultados/imagen-aviso' });
    } finally {
      delete process.env.RESULTADOS_PLANTILLA_IMAGEN;
    }
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

  /* El caso real: Meta rechaza DESPUÉS de que `enviar` respondió, por el
     despacho en segundo plano. El `catch` de `enviar` nunca lo ve. */
  it('si Meta rechaza en diferido, el informe se puede volver a enviar; si es incierto, no', async () => {
    const { mensajeId } = await service.enviar(INFORME, asistente);

    await prisma.mensaje.update({ where: { id: mensajeId }, data: { estadoEnvio: 'INCIERTO' } });
    await expect(service.enviar(INFORME, asistente)).rejects.toThrow(/ya se le envió/);

    await prisma.mensaje.update({ where: { id: mensajeId }, data: { estadoEnvio: 'FALLIDO' } });
    const cola = await service.pendientes({}, asistente);
    expect(cola.datos[0].aviso?.estadoMensaje).toBe('FALLIDO');

    await expect(service.enviar(INFORME, asistente)).resolves.toMatchObject({ enviado: true });
    expect(plantillasEnviadas).toHaveLength(2);
    expect(await prisma.avisoResultado.count()).toBe(1);
  });

  it('no manda a una puerta cerrada: acceso vencido o revocado se rechaza', async () => {
    informesDelPortal[0].accesoVigente = false;
    await expect(service.enviar(INFORME, asistente)).rejects.toThrow(/venció/i);
    expect(await prisma.avisoResultado.count()).toBe(0);
  });

  it('la cola dice si el paciente ya abrió su informe, y lo saca de «por avisar»', async () => {
    informesDelPortal[0].abiertoEn = '2026-09-22T15:00:00.000Z';
    expect((await service.pendientes({}, asistente)).total).toBe(0);
    const abiertos = await service.pendientes({ estado: 'ABIERTOS' }, asistente);
    expect(abiertos.datos[0].abiertoEn).toBe('2026-09-22T15:00:00.000Z');
    expect(abiertos.contadores.ABIERTOS).toBe(1);
  });

  /* El enlace venció después de avisar: se extiende y se vuelve a avisar,
     sin que el aviso anterior bloquee el nuevo. */
  it('renovar y enviar: extiende el enlace vencido y avisa otra vez', async () => {
    await service.enviar(INFORME, asistente);
    /* El aviso se mandó antes de que venciera el enlace. */
    await prisma.avisoResultado.updateMany({ data: { enviadoEn: new Date(Date.now() - 40 * 86400_000) } });
    Object.assign(informesDelPortal[0], { accesoVigente: false, accesoExpiraEn: new Date(Date.now() - 86400_000).toISOString() });

    await expect(service.enviar(INFORME, asistente)).rejects.toThrow(/Renovar y enviar/);
    await expect(service.renovarYEnviar(INFORME, asistente)).resolves.toMatchObject({ enviado: true });
    expect(renovaciones).toBe(1);
    expect(plantillasEnviadas).toHaveLength(2);
    expect(await prisma.avisoResultado.count()).toBe(1);
  });

  it('renovar y enviar no hace nada si el enlace sigue activo', async () => {
    await expect(service.renovarYEnviar(INFORME, asistente)).rejects.toThrow(/sigue activo/);
    expect(renovaciones).toBe(0);
    expect(plantillasEnviadas).toHaveLength(0);
  });

  it('dos «renovar y enviar» simultáneos mandan UN solo WhatsApp', async () => {
    Object.assign(informesDelPortal[0], { accesoVigente: false, accesoExpiraEn: new Date(Date.now() - 86400_000).toISOString() });
    await Promise.allSettled([service.renovarYEnviar(INFORME, asistente), service.renovarYEnviar(INFORME, asistente)]);
    expect(plantillasEnviadas).toHaveLength(1);
    expect(await prisma.avisoResultado.count()).toBe(1);
  });

  it('solo quien entrega resultados puede renovar y enviar', async () => {
    Object.assign(informesDelPortal[0], { accesoVigente: false, accesoExpiraEn: new Date(Date.now() - 86400_000).toISOString() });
    await expect(service.renovarYEnviar(INFORME, agente)).rejects.toThrow(/no encontrada/i);
    expect(renovaciones).toBe(0);
  });

  it('un paciente sin ficha en el CRM se señala, no se inventa', async () => {
    informesDelPortal[0].paciente = { nombre: 'Nadie', pac: 'PAC99999', ci: null };
    const cola = await service.pendientes({}, asistente);
    expect(cola.datos[0]).toMatchObject({ paciente: null, vinculo: null, sinFicha: 'SIN_COINCIDENCIA' });
    await expect(service.enviar(INFORME, asistente)).rejects.toThrow(/no tiene ficha/);
    expect(plantillasEnviadas).toHaveLength(0);
  });

  /* Los pacientes del portal registrados solo con CI: el CI del CRM está
     escrito a mano, con guiones y en minúsculas, y se compara canónico. */
  it('sin PAC, reconoce por CI único aunque esté escrito distinto, y lo dice', async () => {
    await prisma.cliente.create({ data: { nombre: 'Paciente por CI', telefono: '+59170000091', ci: '4.567.890-lp' } });
    informesDelPortal[0].paciente = { nombre: 'Paciente Por Ci', pac: null, ci: '4567890 LP' };
    const cola = await service.pendientes({}, asistente);
    expect(cola.datos[0]).toMatchObject({ vinculo: 'CI', sinFicha: null, paciente: { nombre: 'Paciente por CI', telefono: '+59170000091' } });
    expect(cola.datos[0].pacientePortal.nombre).toBe('Paciente Por Ci');
    await expect(service.enviar(INFORME, asistente)).resolves.toMatchObject({ enviado: true });
  });

  /* Elegir una de dos fichas con el mismo CI es avisar quizá a otra persona
     de que alguien tiene un resultado. No se elige: se señala. */
  it('un CI repetido en el CRM no se vincula a ninguna de las dos fichas', async () => {
    await prisma.cliente.createMany({
      data: [
        { nombre: 'Homónima A', telefono: '+59170000092', ci: '7777777' },
        { nombre: 'Homónima B', telefono: '+59170000093', ci: '7777-777' },
      ],
    });
    informesDelPortal[0].paciente = { nombre: 'Homónima', pac: null, ci: '7777777' };
    const cola = await service.pendientes({}, asistente);
    expect(cola.datos[0]).toMatchObject({ paciente: null, sinFicha: 'CI_REPETIDO' });
    await expect(service.enviar(INFORME, asistente)).rejects.toThrow(/más de una ficha/);
    expect(plantillasEnviadas).toHaveLength(0);
  });

  it('el PAC manda sobre el CI cuando los dos cruzan con fichas distintas', async () => {
    await prisma.cliente.create({ data: { nombre: 'Otra persona', telefono: '+59170000094', ci: '1234567' } });
    informesDelPortal[0].paciente = { nombre: 'Paciente Vinculado', pac: 'pac-33009', ci: '1234567' };
    const cola = await service.pendientes({}, asistente);
    expect(cola.datos[0]).toMatchObject({ vinculo: 'PAC', paciente: { nombre: 'Paciente Vinculado' } });
  });
});

/* El enlace que queda escrito en el chat es el del paciente, no otro: es por
   donde el equipo vuelve al informe desde el historial. */
describe('el enlace del informe', () => {
  it('el mensaje del chat guarda el enlace del paciente', async () => {
    const antes = process.env.PORTAL_RESULTADOS_PUBLICO;
    process.env.PORTAL_RESULTADOS_PUBLICO = 'https://portal.prueba/resultados';
    try {
      const cola = await service.pendientes({}, asistente);
      const fila = cola.datos[0];

      await service.enviar(fila.informeId, asistente);
      const mensaje = await prisma.mensaje.findFirstOrThrow({ orderBy: { createdAt: 'desc' }, select: { contenido: true } });
      expect(mensaje.contenido).toContain(`https://portal.prueba/resultados/${ACCESO}`);
    } finally {
      if (antes === undefined) delete process.env.PORTAL_RESULTADOS_PUBLICO; else process.env.PORTAL_RESULTADOS_PUBLICO = antes;
    }
  });
});

/**
 * La asistente corrige el teléfono o da de alta la ficha DESDE EL INFORME.
 *
 * Antes la pantalla llamaba a `/clientes`, que exige rango de agente: la
 * asistente —justo la persona para la que existe esta cola— recibía 403 al
 * pulsar «Cambiar» o «Crear ficha», y nadie lo vio porque la cuenta todavía no
 * se había usado. Abrirle Clientes le daría las 15.000 fichas; por eso actúa
 * sobre el informe y el servidor decide qué ficha es.
 */
describe('la asistente corrige la ficha desde el informe', () => {
  it('cambia el teléfono de la ficha que el informe reconoce, y queda auditado', async () => {
    const hecho = await service.corregirTelefono(INFORME, '+59170000091', asistente);
    const ficha = await prisma.cliente.findUniqueOrThrow({ where: { pac: 'PAC33009' } });
    expect(hecho).toEqual({ clienteId: ficha.id, telefono: '+59170000091' });
    expect(ficha.telefono).toBe('+59170000091');
    expect(await prisma.auditLog.count({ where: { entidad: 'Cliente', entidadId: ficha.id, usuarioId: 'a0000000-0000-4000-8000-000000000001' } })).toBe(1);
  });

  it('quien no entrega resultados no toca fichas por esta vía', async () => {
    await expect(service.corregirTelefono(INFORME, '+59170000091', agente)).rejects.toThrow(NotFoundException);
    await expect(service.crearFicha(INFORME, '+59170000091', agente)).rejects.toThrow(NotFoundException);
    expect((await prisma.cliente.findUniqueOrThrow({ where: { pac: 'PAC33009' } })).telefono).toBe('+59170000001');
  });

  /* Ella no ve Clientes: el 409 dice que el número está en uso, no de quién. */
  it('un teléfono que ya es de otra ficha se explica sin nombrar a nadie', async () => {
    await prisma.cliente.create({ data: { nombre: 'Otra Paciente', telefono: '+59170000092' } });
    await expect(service.corregirTelefono(INFORME, '+59170000092', asistente)).rejects.toMatchObject({
      status: 409,
      response: { message: 'Ya existe un paciente con el teléfono +59170000092.', campo: 'telefono' },
    });
  });

  it('da de alta con el nombre y el PAC del PORTAL, y la cola la reconoce', async () => {
    informesDelPortal[0].paciente = { nombre: 'Carla Arauz', pac: 'PAC99999', ci: null };
    const { clienteId } = await service.crearFicha(INFORME, '+59170000093', asistente);
    expect(await prisma.cliente.findUniqueOrThrow({ where: { id: clienteId } })).toMatchObject({
      nombre: 'Carla Arauz', pac: 'PAC99999', telefono: '+59170000093', agenteId: null,
    });
    const cola = await service.pendientes({}, asistente);
    expect(cola.datos[0]).toMatchObject({ vinculo: 'PAC', paciente: { id: clienteId } });

    /* Dos clics, o alguien que la creó mientras tanto: no se duplica. */
    await expect(service.crearFicha(INFORME, '+59170000094', asistente)).rejects.toThrow(ConflictException);
  });

  it('corregir el teléfono de un informe sin ficha lo dice, no inventa una', async () => {
    informesDelPortal[0].paciente = { nombre: 'Nadie', pac: 'PAC99999', ci: null };
    await expect(service.corregirTelefono(INFORME, '+59170000091', asistente)).rejects.toThrow(/no tiene ficha/);
  });
});

/**
 * La paciente escribió por WhatsApp ANTES de ir a la clínica: tiene ficha con
 * su número pero sin PAC. Su informe llega de FileMaker con PAC, queda «sin
 * vincular», y crearle ficha rebotaba contra su propio número. Lo correcto es
 * VINCULAR —ponerle el PAC a la ficha que ya existe—, y nunca solo: madre e
 * hija con el mismo WhatsApp es lo corriente.
 */
describe('vincular el informe a la ficha que ya tiene ese número', () => {
  beforeEach(() => {
    informesDelPortal[0].paciente = { nombre: 'Carla Arauz', pac: 'PAC99999', ci: '4455667' };
  });

  it('con una ficha provisional sin PAC, pregunta en vez de duplicar; al vincular recibe PAC, CI y nombre', async () => {
    const provisional = await prisma.cliente.create({ data: { nombre: 'WhatsApp +59170000093', telefono: '+59170000093' } });

    await expect(service.crearFicha(INFORME, '+59170000093', asistente)).rejects.toMatchObject({
      status: 409,
      /* Sin nombre que mostrar: el provisional no identifica a nadie. */
      response: { campo: 'telefono', vinculable: { nombre: null } },
    });
    expect(await prisma.cliente.count({ where: { telefono: '+59170000093' } })).toBe(1);

    expect(await service.vincularFicha(INFORME, '+59170000093', asistente)).toEqual({ clienteId: provisional.id });
    expect(await prisma.cliente.findUniqueOrThrow({ where: { id: provisional.id } })).toMatchObject({
      nombre: 'Carla Arauz', pac: 'PAC99999', ci: '4455667', telefono: '+59170000093',
    });
    /* Y desde ahora la cola la reconoce sola, también en los próximos informes. */
    expect((await service.pendientes({}, asistente)).datos[0]).toMatchObject({ vinculo: 'PAC', paciente: { id: provisional.id } });
    expect(await prisma.auditLog.count({ where: { entidadId: provisional.id, accion: 'FICHA_VINCULADA_DESDE_RESULTADOS' } })).toBe(1);
  });

  it('muestra el nombre de una ficha real para decidir, y al vincular lo respeta', async () => {
    const ficha = await prisma.cliente.create({ data: { nombre: 'Carla A. (la escribió una agente)', telefono: '+59170000093' } });

    await expect(service.crearFicha(INFORME, '+59170000093', asistente)).rejects.toMatchObject({
      response: { vinculable: { nombre: 'Carla A. (la escribió una agente)' } },
    });
    await service.vincularFicha(INFORME, '+59170000093', asistente);
    expect(await prisma.cliente.findUniqueOrThrow({ where: { id: ficha.id } })).toMatchObject({
      nombre: 'Carla A. (la escribió una agente)', pac: 'PAC99999',
    });
  });

  /* El número ya es de alguien con su propio PAC: casi siempre un familiar. */
  it('un número de otra persona, con otro PAC, no se ofrece ni se deja vincular', async () => {
    await expect(service.crearFicha(INFORME, '+59170000001', asistente)).rejects.toMatchObject({
      status: 409,
      response: { campo: 'telefono', message: expect.stringContaining('familiar') },
    });
    await expect(service.vincularFicha(INFORME, '+59170000001', asistente)).rejects.toThrow(ConflictException);
    expect((await prisma.cliente.findUniqueOrThrow({ where: { telefono: '+59170000001' } })).pac).toBe('PAC33009');
  });

  it('una ficha sin PAC pero con OTRO CI tampoco es ella', async () => {
    await prisma.cliente.create({ data: { nombre: 'Madre', telefono: '+59170000093', ci: '1112223' } });
    await expect(service.vincularFicha(INFORME, '+59170000093', asistente)).rejects.toThrow(ConflictException);
    expect((await prisma.cliente.findUniqueOrThrow({ where: { telefono: '+59170000093' } })).pac).toBeNull();
  });

  it('quien no entrega resultados no vincula', async () => {
    await prisma.cliente.create({ data: { nombre: 'WhatsApp +59170000093', telefono: '+59170000093' } });
    await expect(service.vincularFicha(INFORME, '+59170000093', agente)).rejects.toThrow(NotFoundException);
  });
});

/**
 * Las pestañas de la cola. «Por avisar» y «esperando lectura» dependen de si
 * se avisó —que solo sabe el CRM—, así que se paginan sobre el conjunto de
 * trabajo ENTERO que da el portal; filtrar una página ya cortada diría «no hay
 * más» con informes en la siguiente.
 */
describe('la cola por pestañas', () => {
  const ID = (n: number) => `44444444-4444-4444-8444-00000000000${n}`;
  const informe = (n: number, extra: Record<string, unknown> = {}) => ({
    ...informesDelPortal[0], informeId: ID(n), accesoId: `55555555-5555-4555-8555-00000000000${n}`, ...extra,
  });

  async function avisar(n: number, estadoEnvio: 'ENVIADO' | 'FALLIDO') {
    const ficha = await prisma.cliente.findUniqueOrThrow({ where: { pac: 'PAC33009' } });
    const chat = await prisma.conversacion.upsert({
      where: { clienteId_lineaId: { clienteId: ficha.id, lineaId: LINEA } },
      create: { clienteId: ficha.id, lineaId: LINEA },
      update: {},
    });
    const mensaje = await prisma.mensaje.create({ data: { conversacionId: chat.id, direccion: 'SALIENTE', contenido: 'aviso', estadoEnvio } });
    await prisma.avisoResultado.create({
      data: { informeId: ID(n), clienteId: ficha.id, enviadoPorId: 'a0000000-0000-4000-8000-000000000001', mensajeId: mensaje.id },
    });
    return chat.id;
  }

  beforeEach(async () => {
    informesDelPortal = [
      informe(1),                                                  // por avisar
      informe(2),                                                  // aviso FALLIDO → vuelve a por avisar
      informe(3),                                                  // avisado → esperando lectura
      informe(4, { accesoVigente: false }),                        // venció sin abrirse
      informe(5, { abiertoEn: '2026-09-29T10:00:00.000Z' }),      // abierto
    ];
    await avisar(2, 'FALLIDO');
    await avisar(3, 'ENVIADO');
  });

  it('cada informe cae en la pestaña de lo que hay que hacer, y los contadores lo dicen', async () => {
    const cola = await service.pendientes({}, asistente);
    expect(cola.contadores).toEqual({ POR_AVISAR: 2, ESPERANDO: 1, VENCIDOS: 1, ABIERTOS: 1, TODOS: 5 });
    /* Un aviso FALLIDO no es un aviso: el paciente no recibió nada. */
    expect(cola.datos.map(f => f.informeId)).toEqual([ID(1), ID(2)]);
    expect((await service.pendientes({ estado: 'ESPERANDO' }, asistente)).datos.map(f => f.informeId)).toEqual([ID(3)]);
    expect((await service.pendientes({ estado: 'VENCIDOS' }, asistente)).datos.map(f => f.informeId)).toEqual([ID(4)]);
    expect((await service.pendientes({ estado: 'ABIERTOS' }, asistente)).datos.map(f => f.informeId)).toEqual([ID(5)]);
    expect((await service.pendientes({ estado: 'TODOS' }, asistente)).total).toBe(5);
  });

  /* La razón de todo el diseño: la página se corta DESPUÉS de filtrar. */
  it('pagina sobre la lista filtrada: la segunda página existe y el total es el de la pestaña', async () => {
    const primera = await service.pendientes({ limite: 1 }, asistente);
    const segunda = await service.pendientes({ limite: 1, pagina: 2 }, asistente);
    expect([primera.total, primera.totalPaginas]).toEqual([2, 2]);
    expect(primera.datos.map(f => f.informeId)).toEqual([ID(1)]);
    expect(segunda.datos.map(f => f.informeId)).toEqual([ID(2)]);
  });

  it('la búsqueda filtra la pestaña pero no mueve los contadores', async () => {
    informesDelPortal[1] = informe(2, { paciente: { nombre: 'Rocío Roca', pac: 'PAC33009', ci: null } });
    const buscado = await service.pendientes({ busqueda: 'rocío' }, asistente);
    expect(buscado.datos.map(f => f.informeId)).toEqual([ID(2)]);
    expect(buscado.total).toBe(1);
    expect(buscado.contadores.POR_AVISAR).toBe(2);
  });

  /* «Ir al chat» abre el de la línea de resultados, donde está el aviso. */
  it('cada fila trae su chat de la línea de resultados, o null si todavía no hay', async () => {
    const chat = (await prisma.conversacion.findFirstOrThrow({ where: { lineaId: LINEA } })).id;
    const esperando = await service.pendientes({ estado: 'ESPERANDO' }, asistente);
    expect(esperando.datos[0].conversacionId).toBe(chat);

    await prisma.avisoResultado.deleteMany();
    await prisma.mensaje.deleteMany({ where: { conversacion: { lineaId: LINEA } } });
    await prisma.conversacion.deleteMany({ where: { lineaId: LINEA } });
    expect((await service.pendientes({}, asistente)).datos[0].conversacionId).toBeNull();
  });
});
