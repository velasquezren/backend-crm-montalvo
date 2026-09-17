import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';

/* Solo se sustituye el envío. `generateVAPIDKeys` y `setVapidDetails` siguen
   siendo los de verdad, porque sin llaves válidas `PushService` se apaga y
   estas pruebas pasarían sin probar nada. El namespace del módulo está
   congelado, así que `jest.spyOn` sobre él no vale: hay que interceptarlo al
   cargarlo. */
jest.mock('web-push', () => {
  const real = jest.requireActual<typeof import('web-push')>('web-push');
  return { ...real, sendNotification: jest.fn() };
});

const enviarNotificacion = webpush.sendNotification as jest.MockedFunction<
  typeof webpush.sendNotification
>;

import { PrismaService } from '../../prisma/prisma.service';
import { LineasWhatsappService } from '../../modules/lineas-whatsapp/lineas-whatsapp.service';
import { PushService } from './push.service';

/**
 * F09 · la baja del push, contra PostgreSQL real.
 *
 * Lo que se prueba aquí es el reverso exacto de la reproducción que abrió F09:
 * en la clínica varias agentes comparten una tablet, y la suscripción de quien
 * salía seguía viva. La siguiente notificación llegaba a ese dispositivo con el
 * nombre de la paciente y los primeros 80 caracteres de su mensaje, a nombre de
 * una cuenta que ya había cerrado sesión.
 *
 * `webpush.sendNotification` va espiado: aquí no sale nada a la red, pero sí se
 * comprueba a QUÉ endpoints se habría mandado, que es el dato que importa.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';

if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService(URL_TEST);

const TABLET = 'https://fcm.googleapis.com/fcm/send/TABLET-COMPARTIDA';
const MOVIL_DE_B = 'https://fcm.googleapis.com/fcm/send/MOVIL-DE-B';

let push: PushService;
let lineas: LineasWhatsappService;
let enviados: string[];

async function crearUsuaria(nombre: string, activo = true) {
  const linea = await prisma.lineaWhatsapp.findFirstOrThrow({ where: { comercial: true } });
  return prisma.usuario.create({
    data: {
      nombre, email: `${nombre}@f09.test`, passwordHash: 'x', rol: 'AGENTE', activo,
      lineasWhatsapp: { create: { lineaId: linea.id } },
    },
  });
}

function suscripcion(endpoint: string) {
  return { endpoint, keys: { p256dh: 'clave-publica-ficticia', auth: 'clave-auth-ficticia' } };
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  jest.restoreAllMocks();
});

beforeEach(async () => {
  await prisma.pushSubscription.deleteMany();
  await prisma.mensaje.deleteMany();
  await prisma.conversacion.deleteMany();
  await prisma.cliente.deleteMany();
  await prisma.accesoLineaWhatsapp.deleteMany();
  await prisma.usuario.deleteMany();

  /* Llaves de verdad generadas al vuelo: sin ellas `habilitado` es false y
     `enviarAUsuario` devuelve antes de mirar nada — la prueba pasaría sin
     probar. */
  const vapid = webpush.generateVAPIDKeys();
  const config = new ConfigService({
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: 'mailto:pruebas@f09.test',
  });

  push = new PushService(prisma, config);
  push.onModuleInit();
  lineas = new LineasWhatsappService(prisma, config);

  enviados = [];
  enviarNotificacion.mockReset();
  enviarNotificacion.mockImplementation(async (sub: webpush.PushSubscription) => {
    enviados.push(sub.endpoint);
    return {} as webpush.SendResult;
  });
});

const AVISO = { titulo: 'WhatsApp: María Fernanda', mensaje: 'Hola, quería consultar por…' };

describe('F09 · /push/desuscribir', () => {
  it('Caso A · borra únicamente la suscripción de quien la pide', async () => {
    const a = await crearUsuaria('agente-a');
    await push.guardarSuscripcion(a.id, suscripcion(TABLET));

    const resultado = await push.eliminarSuscripcionPropia(a.id, TABLET);

    expect(resultado.ok).toBe(true);
    expect(await prisma.pushSubscription.count()).toBe(0);
  });

  it('Caso B · la suscripción de otra agente queda intacta', async () => {
    const a = await crearUsuaria('agente-a');
    const b = await crearUsuaria('agente-b');
    await push.guardarSuscripcion(a.id, suscripcion(TABLET));
    await push.guardarSuscripcion(b.id, suscripcion(MOVIL_DE_B));

    await push.eliminarSuscripcionPropia(a.id, TABLET);

    const quedan = await prisma.pushSubscription.findMany();
    expect(quedan.map(s => s.endpoint)).toEqual([MOVIL_DE_B]);
    expect(quedan[0].usuarioId).toBe(b.id);
  });

  it('A no puede borrar la suscripción de B aunque conozca su endpoint', async () => {
    const a = await crearUsuaria('agente-a');
    const b = await crearUsuaria('agente-b');
    await push.guardarSuscripcion(b.id, suscripcion(MOVIL_DE_B));

    /* El endpoint viaja al navegador de quien se suscribe: no es un secreto en
       el que apoyarse. El acotado por `usuarioId` es lo que protege. */
    const resultado = await push.eliminarSuscripcionPropia(a.id, MOVIL_DE_B);

    expect(resultado.ok).toBe(false);
    expect(await prisma.pushSubscription.count()).toBe(1);
  });

  it('llamarla dos veces es seguro: la segunda no borra nada ni revienta', async () => {
    const a = await crearUsuaria('agente-a');
    await push.guardarSuscripcion(a.id, suscripcion(TABLET));

    expect((await push.eliminarSuscripcionPropia(a.id, TABLET)).ok).toBe(true);
    expect((await push.eliminarSuscripcionPropia(a.id, TABLET)).ok).toBe(false);
    expect(await prisma.pushSubscription.count()).toBe(0);
  });
});

describe('F09 · Caso C · el reverso de la reproducción', () => {
  it('tras la baja de A, un mensaje entrante ya no alcanza la tablet', async () => {
    const a = await crearUsuaria('agente-a');
    await push.guardarSuscripcion(a.id, suscripcion(TABLET));

    const linea = await prisma.lineaWhatsapp.findFirstOrThrow({ where: { comercial: true } });
    const cliente = await prisma.cliente.create({
      data: { nombre: 'María Fernanda Gutiérrez', telefono: '+59171234567' },
    });
    const chat = await prisma.conversacion.create({
      data: { clienteId: cliente.id, lineaId: linea.id },
    });

    /* Antes de la baja: A es destinataria y el aviso llega a la tablet. Es el
       escenario que abrió F09, y tiene que seguir funcionando para que el
       reverso signifique algo. */
    expect(await lineas.destinatarios(chat.id)).toContain(a.id);
    await push.enviarAUsuario(a.id, AVISO);
    expect(enviados).toEqual([TABLET]);

    // A cierra sesión: eso es lo que ahora dispara la baja.
    await push.eliminarSuscripcionPropia(a.id, TABLET);
    enviados = [];

    /* A sigue siendo destinataria —cerrar sesión no la desactiva, y no debe—,
       pero ya no hay ningún dispositivo suyo al que mandar. */
    expect(await lineas.destinatarios(chat.id)).toContain(a.id);
    expect((await prisma.usuario.findUniqueOrThrow({ where: { id: a.id } })).activo).toBe(true);
    await push.enviarAUsuario(a.id, AVISO);
    expect(enviados).toEqual([]);
  });
});
describe('F09 · Caso H · enviarAUsuario y las cuentas desactivadas', () => {
  it('no manda nada al teléfono de una cuenta desactivada', async () => {
    const baja = await crearUsuaria('agente-de-baja', false);
    await push.guardarSuscripcion(baja.id, suscripcion(TABLET));

    await push.enviarAUsuario(baja.id, AVISO);

    /* Va en integración y no en unitaria a propósito: con un doble de Prisma
       solo se podría afirmar la FORMA del `where`, no que filtre de verdad. */
    expect(enviados).toEqual([]);
    expect(await prisma.pushSubscription.count()).toBe(1);
  });

  it('a una cuenta activa sí le llega', async () => {
    const activa = await crearUsuaria('agente-activa');
    await push.guardarSuscripcion(activa.id, suscripcion(TABLET));

    await push.enviarAUsuario(activa.id, AVISO);

    expect(enviados).toEqual([TABLET]);
  });
});
