import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuditService } from '../../common/audit/audit.service';
import { R2Service } from '../../common/storage/r2.service';
import { WhatsappCloudService } from '../../common/whatsapp/whatsapp-cloud.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { LineasWhatsappService } from '../lineas-whatsapp/lineas-whatsapp.service';
import { MemoriaAgenteService } from '../memoria-agente/memoria-agente.service';
import { ServiciosService } from '../servicios/servicios.service';
import { ConversacionesGateway } from './conversaciones.gateway';
import { ConversacionesService } from './conversaciones.service';
import { DespachadorSalienteService } from './despachador-saliente.service';

/**
 * La clave de idempotencia NO puede cruzar de una conversación a otra.
 *
 * `clientMessageId` es único en toda la tabla, no por conversación, así que el
 * P2002 rebota igual venga del chat que venga. La recuperación hacía
 * `findUnique({ where: { clientMessageId } })` y devolvía esa fila sin mirar a
 * quién pertenecía: un POST al chat de una paciente con una clave ya usada en
 * el de otra respondía con el mensaje de la primera —su texto y su
 * `conversacionId`— y el mensaje que se quería mandar no salía nunca, en
 * silencio.
 *
 * Son dos daños distintos y los dos importan: contenido de una paciente
 * cruzando a la operación de otra, y un envío tragado que la agente ve como
 * hecho. Por eso la respuesta correcta no es "devuelve la fila" ni "crea otra
 * con la misma clave" —el índice único lo impide—, sino un 409 que declara el
 * conflicto sin contar nada del chat ajeno.
 *
 * Se prueba contra PostgreSQL real porque la propiedad depende del índice
 * único resolviendo el INSERT, no de un `if` que un mock pueda simular.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';
if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService(URL_TEST);

/** Cuenta los avisos de socket: un duplicado no puede repintar nada. */
class GatewayEspia {
  readonly emitidos: string[] = [];
  emitirActividad(conversacionId: string): void {
    this.emitidos.push(conversacionId);
  }
  notificarEntrante(): void {}
}

class R2Espia {
  habilitado = false;
  async subir(): Promise<void> {}
  async urlFirmada(key: string): Promise<string | null> {
    return `https://r2.local/${key}`;
  }
  async eliminar(): Promise<void> {}
}

/** Cuenta los despachos reales a Meta: es el efecto externo que no se deshace. */
class DespachadorEspia {
  readonly despachos: Array<{ mensajeId: string; contenido: string }> = [];
  async texto(destino: { mensajeId: string }, contenido: string): Promise<void> {
    this.despachos.push({ mensajeId: destino.mensajeId, contenido });
  }
}

const SUFIJO = `aislamiento-${Date.now()}`;
const TEXTO_A = 'ecografía de la paciente A, información reservada';
const TEXTO_B = 'texto que la agente quería mandarle a la paciente B';

let service: ConversacionesService;
let despachador: DespachadorEspia;
let gateway: GatewayEspia;
let corrida = 0;
let agenteId: string;
let lineaId: string;
let clienteAId: string;
let clienteBId: string;
let conversacionAId: string;
let conversacionBId: string;

/** Deja que corran los `void enSegundoPlano(...)` del despacho. */
const dejarCorrerElDespacho = () => new Promise(resolve => setTimeout(resolve, 30));

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/* Esta suite crea lo suyo y borra exactamente eso, por id: `crm_test` es
   compartido y la línea que siembra una migración sostiene otras cuatro. */
afterEach(async () => {
  const conversaciones = [conversacionAId, conversacionBId];
  const clientes = [clienteAId, clienteBId];
  await prisma.mensaje.deleteMany({ where: { conversacionId: { in: conversaciones } } });
  await prisma.conversacion.deleteMany({ where: { id: { in: conversaciones } } });
  await prisma.auditLog.deleteMany({ where: { entidadId: { in: clientes } } });
  await prisma.lead.deleteMany({ where: { clienteId: { in: clientes } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clientes } } });
  await prisma.lineaWhatsapp.deleteMany({ where: { id: lineaId } });
  await prisma.usuario.deleteMany({ where: { id: agenteId } });
});

beforeEach(async () => {
  corrida += 1;
  gateway = new GatewayEspia();
  despachador = new DespachadorEspia();
  const r2 = new R2Espia();

  service = new ConversacionesService(
    prisma,
    new ClientesService(prisma, new AuditService(prisma), new ServiciosService(prisma)),
    gateway as unknown as ConversacionesGateway,
    r2 as unknown as R2Service,
    new WhatsappCloudService(),
    despachador as unknown as DespachadorSalienteService,
    new LineasWhatsappService(prisma, new ConfigService({})),
    new MemoriaAgenteService(prisma, r2 as unknown as R2Service),
  );

  const agente = await prisma.usuario.create({
    data: {
      nombre: 'agente-aislamiento',
      email: `${SUFIJO}-${corrida}@test.local`,
      passwordHash: 'x',
      rol: 'AGENTE',
      activo: true,
    },
  });
  agenteId = agente.id;

  /* Misma línea y misma agente en los dos chats: lo que separa a las pacientes
     tiene que ser la conversación, no que el request venga de otro sitio. */
  const linea = await prisma.lineaWhatsapp.create({
    data: {
      nombre: `Linea ${SUFIJO}-${corrida}`,
      tokenEnv: `TOK_${SUFIJO}_${corrida}`,
      telefono: `+59171${String(corrida).padStart(6, '0')}`,
      activa: true,
      comercial: true,
    },
  });
  lineaId = linea.id;

  const clienteA = await prisma.cliente.create({
    data: { nombre: `Paciente A ${SUFIJO}-${corrida}`, telefono: `+59162${String(corrida).padStart(6, '0')}` },
  });
  const clienteB = await prisma.cliente.create({
    data: { nombre: `Paciente B ${SUFIJO}-${corrida}`, telefono: `+59163${String(corrida).padStart(6, '0')}` },
  });
  clienteAId = clienteA.id;
  clienteBId = clienteB.id;

  const conversacionA = await prisma.conversacion.create({
    data: { clienteId: clienteAId, lineaId, agenteId },
  });
  const conversacionB = await prisma.conversacion.create({
    data: { clienteId: clienteBId, lineaId, agenteId },
  });
  conversacionAId = conversacionA.id;
  conversacionBId = conversacionB.id;

  /* La ventana de 24 h exige un ENTRANTE reciente en cada chat; sin él el
     envío se rechaza antes de llegar a lo que se quiere probar. */
  for (const conversacionId of [conversacionAId, conversacionBId]) {
    await prisma.mensaje.create({
      data: { conversacionId, direccion: 'ENTRANTE', contenido: 'Hola', createdAt: new Date() },
    });
  }
});

function enviar(conversacionId: string, contenido: string, clientMessageId: string) {
  return service.enviarMensaje(conversacionId, contenido, agenteId, undefined, undefined, clientMessageId);
}

describe('aislamiento de clientMessageId entre conversaciones (PostgreSQL real)', () => {
  it('1 · misma clave y MISMA conversación: recupera la fila original, no crea otra', async () => {
    const clave = `${SUFIJO}-${corrida}-misma`;

    const primero = await enviar(conversacionAId, TEXTO_A, clave);
    const segundo = await enviar(conversacionAId, 'reintento del mismo envío', clave);
    await dejarCorrerElDespacho();

    expect(segundo.id).toBe(primero.id);
    expect(segundo.contenido).toBe(TEXTO_A);
    expect(await prisma.mensaje.count({ where: { clientMessageId: clave } })).toBe(1);
    /* El reintento no vuelve a salir hacia la paciente ni a repintar el hilo. */
    expect(despachador.despachos).toHaveLength(1);
    expect(gateway.emitidos).toEqual([conversacionAId]);
  });

  it('2 · misma clave y OTRA conversación: 409, no la fila ajena', async () => {
    const clave = `${SUFIJO}-${corrida}-cruzada`;
    await enviar(conversacionAId, TEXTO_A, clave);

    const error = await enviar(conversacionBId, TEXTO_B, clave).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    /* 409 y no 500: el cliente tiene que poder distinguir "esta clave ya no
       sirve" de "el servidor se rompió", que es lo que devolvía antes de R2.1
       y lo que llevaba a la agente a reescribir el mensaje a mano. */
    expect((error as ConflictException).getStatus()).toBe(409);
  });

  it('3 · el 409 no filtra nada del chat original', async () => {
    const clave = `${SUFIJO}-${corrida}-sin-fuga`;
    const original = await enviar(conversacionAId, TEXTO_A, clave);

    const error = await enviar(conversacionBId, TEXTO_B, clave).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);

    /* Todo lo que viaja al cliente: el mensaje y el cuerpo de la respuesta. */
    const serializado = JSON.stringify((error as ConflictException).getResponse());
    for (const secreto of [TEXTO_A, original.id, conversacionAId, clienteAId]) {
      expect(serializado).not.toContain(secreto);
    }
  });

  it('4 · el intento cruzado no crea una segunda fila', async () => {
    const clave = `${SUFIJO}-${corrida}-una-fila`;
    await enviar(conversacionAId, TEXTO_A, clave);

    await enviar(conversacionBId, TEXTO_B, clave).catch(() => undefined);

    expect(await prisma.mensaje.count({ where: { clientMessageId: clave } })).toBe(1);
    /* Y el chat de B no se queda con un mensaje saliente huérfano. */
    expect(
      await prisma.mensaje.count({ where: { conversacionId: conversacionBId, direccion: 'SALIENTE' } }),
    ).toBe(0);
  });

  it('5 · el intento cruzado no despacha nada a Meta', async () => {
    const clave = `${SUFIJO}-${corrida}-un-despacho`;
    const original = await enviar(conversacionAId, TEXTO_A, clave);

    await enviar(conversacionBId, TEXTO_B, clave).catch(() => undefined);
    await dejarCorrerElDespacho();

    expect(despachador.despachos).toHaveLength(1);
    expect(despachador.despachos[0]).toMatchObject({ mensajeId: original.id, contenido: TEXTO_A });
  });

  it('6 · el intento cruzado no emite un segundo aviso por WebSocket', async () => {
    const clave = `${SUFIJO}-${corrida}-un-socket`;
    await enviar(conversacionAId, TEXTO_A, clave);

    await enviar(conversacionBId, TEXTO_B, clave).catch(() => undefined);
    await dejarCorrerElDespacho();

    /* Ni uno del chat ajeno ni uno del propio: no pasó nada que pintar. */
    expect(gateway.emitidos).toEqual([conversacionAId]);
  });
});
