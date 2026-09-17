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
 * R2.2 — idempotencia del envío CON ADJUNTO, contra PostgreSQL de verdad.
 *
 * Escribiendo estas pruebas se descubrió que la propiedad NO se cumplía: la
 * suite de R2.1 comprueba el índice único contra Prisma directamente y nunca
 * pasa por `recuperarEnvioDuplicado`, que con el driver adapter no reconocía el
 * choque —`meta.target` no existe ahí— y devolvía `null`. El segundo POST
 * acababa en 500 en vez de devolver el mensaje ya enviado. Producción tampoco
 * lo delataba: el único envío con clave que había entrado nunca se reintentó.
 *
 * Por eso aquí se ejercita el SERVICE, no la tabla. Y se cubre lo que abre el
 * reintento de R2.2: que un segundo POST con la misma clave NO pueda cambiar el
 * adjunto de una intención ya persistida, y que no despache dos veces a Meta.
 *
 * Ese segundo caso importa más de lo que parece. Si el reintento pudiera mutar
 * la fila, un adjunto equivocado —la ecografía de otra paciente— se colaría
 * sobre un mensaje que ya salió, y el historial diría algo que nunca ocurrió.
 * La garantía no es el código de aquí: es el índice único de PostgreSQL, y por
 * eso esta prueba no puede ser un mock.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';
if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService(URL_TEST);

class GatewayEspia {
  readonly emitidos: string[] = [];
  emitirActividad(conversacionId: string): void {
    this.emitidos.push(conversacionId);
  }
  notificarEntrante(): void {}
}

class R2Espia {
  habilitado = true;
  async subir(): Promise<void> {}
  async urlFirmada(key: string): Promise<string | null> {
    return `https://r2.local/${key}`;
  }
  async eliminar(): Promise<void> {}
}

/** Cuenta los despachos reales a Meta: es el efecto externo que no se deshace. */
class DespachadorEspia {
  readonly despachos: Array<{ mensajeId: string; contenido: string; mediaKey?: string }> = [];
  async texto(
    destino: { mensajeId: string },
    contenido: string,
    mediaKey?: string,
  ): Promise<void> {
    this.despachos.push({ mensajeId: destino.mensajeId, contenido, mediaKey });
  }
}

const SUFIJO = `media-${Date.now()}`;
/** Hace únicos los datos de cada test dentro del archivo. */
let corrida = 0;
const CLAVE_A = `memoria/${SUFIJO}/imagen-A.jpg`;
const CLAVE_B = `memoria/${SUFIJO}/imagen-B.jpg`;

let service: ConversacionesService;
let despachador: DespachadorEspia;
let gateway: GatewayEspia;
let agenteId: string;
let conversacionId: string;
let lineaId: string;
let clienteId: string;

/** Deja que corran los `void enSegundoPlano(...)` del despacho. */
const dejarCorrerElDespacho = () => new Promise(resolve => setTimeout(resolve, 30));

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/* Orden por las FK reales: los mensajes cuelgan de la conversación, la
   conversación de cliente y línea, y los recursos del usuario. */
afterEach(async () => {
  await prisma.mensaje.deleteMany({ where: { conversacionId } });
  await prisma.conversacion.deleteMany({ where: { id: conversacionId } });
  await prisma.recursoMemoriaAgente.deleteMany({ where: { usuarioId: agenteId } });
  await prisma.auditLog.deleteMany({ where: { entidadId: clienteId } });
  await prisma.lead.deleteMany({ where: { clienteId } });
  await prisma.cliente.deleteMany({ where: { id: clienteId } });
  await prisma.lineaWhatsapp.deleteMany({ where: { id: lineaId } });
  await prisma.usuario.deleteMany({ where: { id: agenteId } });
});

/**
 * Esta suite NO vacía tablas: crea lo suyo y borra exactamente eso.
 *
 * Empezó haciendo `deleteMany()` sobre `LineaWhatsapp` y se llevó por delante
 * la línea `00000000-0000-4000-8000-000000000001`, que **la siembra una
 * migración** y de la que dependen otras cuatro suites de integración. La
 * primera corrida pasaba y todas las siguientes fallaban con
 * `Conversacion_lineaId_fkey` hasta recrear la base: un fixture compartido no
 * se puede barrer "por si acaso".
 */
beforeEach(async () => {
  gateway = new GatewayEspia();
  despachador = new DespachadorEspia();
  const r2 = new R2Espia();
  const config = new ConfigService({});
  const memoria = new MemoriaAgenteService(prisma, r2 as unknown as R2Service);

  service = new ConversacionesService(
    prisma,
    new ClientesService(prisma, new AuditService(prisma), new ServiciosService(prisma)),
    gateway as unknown as ConversacionesGateway,
    r2 as unknown as R2Service,
    new WhatsappCloudService(),
    despachador as unknown as DespachadorSalienteService,
    new LineasWhatsappService(prisma, config),
    memoria,
  );

  const agente = await prisma.usuario.create({
    data: {
      nombre: 'agente-r22', email: `agente-r22-${SUFIJO}-${++corrida}@test.local`,
      passwordHash: 'x', rol: 'AGENTE', activo: true,
    },
  });
  agenteId = agente.id;

  const linea = await prisma.lineaWhatsapp.create({
    data: {
      nombre: `Linea ${SUFIJO}-${corrida}`, tokenEnv: `TOK_${SUFIJO}_${corrida}`,
      telefono: `+59170${String(corrida).padStart(6, '0')}`, activa: true, comercial: true,
    },
  });
  lineaId = linea.id;

  const cliente = await prisma.cliente.create({
    data: { nombre: `Paciente ${SUFIJO}-${corrida}`, telefono: `+59160${String(corrida).padStart(6, '0')}` },
  });
  clienteId = cliente.id;

  const conversacion = await prisma.conversacion.create({ data: { clienteId, lineaId, agenteId } });
  conversacionId = conversacion.id;

  /* La ventana de 24 h exige un ENTRANTE reciente; sin él el envío se rechaza
     antes de llegar a lo que queremos probar. */
  await prisma.mensaje.create({
    data: {
      conversacionId, direccion: 'ENTRANTE', contenido: 'Hola, quiero información',
      createdAt: new Date(),
    },
  });

  /* Los dos archivos existen en la biblioteca del agente: `enviarMensaje`
     comprueba la propiedad antes de aceptar la clave. */
  for (const mediaKey of [CLAVE_A, CLAVE_B]) {
    await prisma.recursoMemoriaAgente.create({
      data: {
        usuarioId: agenteId, titulo: mediaKey, tipo: 'IMAGEN', categoria: 'GENERAL',
        mediaKey, mediaMime: 'image/jpeg', mediaNombre: 'imagen.jpg', pesoBytes: 1024,
      },
    });
  }
});

function enviar(clientMessageId: string, mediaKey: string, contenido = '') {
  return service.enviarMensaje(
    conversacionId, contenido, agenteId, undefined,
    { mediaKey, mediaMime: 'image/jpeg', mediaNombre: 'imagen.jpg' },
    clientMessageId,
  );
}

describe('R2.2 · idempotencia del envío con adjunto (PostgreSQL real)', () => {
  it('A · dos envíos CONCURRENTES con la misma clave y la misma media dejan una fila y un despacho', async () => {
    const clave = `${SUFIJO}-concurrente`;

    /* Sin await entre medias: compiten de verdad por el índice único. */
    const resultados = await Promise.all([enviar(clave, CLAVE_A), enviar(clave, CLAVE_A)]);
    await dejarCorrerElDespacho();

    const filas = await prisma.mensaje.findMany({ where: { clientMessageId: clave } });
    expect(filas).toHaveLength(1);
    expect(filas[0].mediaKey).toBe(CLAVE_A);
    expect(filas[0].tipo).toBe('IMAGEN');

    /* Las dos peticiones devuelven la MISMA fila a la agente. */
    expect(resultados[0].id).toBe(resultados[1].id);
    expect(resultados[0].id).toBe(filas[0].id);

    /* Y sobre todo: la paciente recibe UNA imagen, no dos. */
    expect(despachador.despachos).toHaveLength(1);
    expect(despachador.despachos[0].mediaKey).toBe(CLAVE_A);
  });

  it('B · un segundo envío con la misma clave y OTRA media conserva la original', async () => {
    const clave = `${SUFIJO}-mutacion`;

    const primero = await enviar(clave, CLAVE_A, 'Su ecografía');
    await dejarCorrerElDespacho();
    expect(despachador.despachos).toHaveLength(1);

    /* El reintento llega con otro adjunto: no puede reescribir la intención
       que ya salió. */
    const segundo = await enviar(clave, CLAVE_B, 'Otra cosa');
    await dejarCorrerElDespacho();

    expect(segundo.id).toBe(primero.id);
    expect(segundo.mediaKey).toBe(CLAVE_A);

    const enBase = await prisma.mensaje.findUnique({ where: { clientMessageId: clave } });
    expect(enBase?.mediaKey).toBe(CLAVE_A);
    expect(enBase?.contenido).toBe('Su ecografía');

    expect(await prisma.mensaje.count({ where: { clientMessageId: clave } })).toBe(1);
    /* NO se despacha por segunda vez: el camino del duplicado sale antes. */
    expect(despachador.despachos).toHaveLength(1);
  });

  it('C · un solo despacho lógico: el duplicado tampoco reemite por WebSocket', async () => {
    const clave = `${SUFIJO}-socket`;

    await enviar(clave, CLAVE_A);
    await dejarCorrerElDespacho();
    const emitidosTrasElPrimero = gateway.emitidos.length;

    await enviar(clave, CLAVE_A);
    await dejarCorrerElDespacho();

    expect(gateway.emitidos).toHaveLength(emitidosTrasElPrimero);
    expect(despachador.despachos).toHaveLength(1);
  });

  it('R2.1 · el duplicado de TEXTO también recupera la fila en vez de dar 500', async () => {
    /* Esta es la propiedad que R2.1 prometía y que ninguna prueba ejercitaba:
       la suite de R2.1 comprueba el índice único contra Prisma directamente y
       nunca pasa por `recuperarEnvioDuplicado`. Con el driver adapter, ese
       método no reconocía el choque —`meta.target` no existe— y el segundo POST
       terminaba en 500 en lugar de devolver el mensaje ya enviado. */
    const clave = `${SUFIJO}-texto`;

    const primero = await service.enviarMensaje(
      conversacionId, 'Buenos días', agenteId, undefined, undefined, clave,
    );
    await dejarCorrerElDespacho();

    const segundo = await service.enviarMensaje(
      conversacionId, 'Buenos días', agenteId, undefined, undefined, clave,
    );
    await dejarCorrerElDespacho();

    expect(segundo.id).toBe(primero.id);
    expect(await prisma.mensaje.count({ where: { clientMessageId: clave } })).toBe(1);
    expect(despachador.despachos).toHaveLength(1);
  });

  it('D · dos intenciones distintas con la MISMA media son dos mensajes', async () => {
    /* Mandar el mismo archivo a varias pacientes es el caso normal de Mi
       Memoria: la identidad lógica es `clientMessageId`, nunca `mediaKey`. */
    const uno = await enviar(`${SUFIJO}-uno`, CLAVE_A);
    const dos = await enviar(`${SUFIJO}-dos`, CLAVE_A);
    await dejarCorrerElDespacho();

    expect(uno.id).not.toBe(dos.id);
    expect(await prisma.mensaje.count({ where: { mediaKey: CLAVE_A } })).toBe(2);
    expect(despachador.despachos).toHaveLength(2);
  });
});
