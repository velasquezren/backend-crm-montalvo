import { ConfigService } from '@nestjs/config';

import { AuditService } from '../../common/audit/audit.service';
import type { R2Service } from '../../common/storage/r2.service';
import { WhatsappCloudService } from '../../common/whatsapp/whatsapp-cloud.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AudienciasService } from './audiencias.service';
import { categoriasDePrueba } from '../clientes/categorias.de-prueba';
import { ClientesService } from '../clientes/clientes.service';
import { ConversacionesGateway } from '../conversaciones/conversaciones.gateway';
import { EnvioPlantillasService } from '../conversaciones/envio-plantillas.service';
import { DespachadorSalienteService } from '../conversaciones/despachador-saliente.service';
import { LineasWhatsappService } from '../lineas-whatsapp/lineas-whatsapp.service';
import { ServiciosService } from '../servicios/servicios.service';
import { TipoCambioService } from '../tipo-cambio/tipo-cambio.service';
import { CampanasEnvioService, claveDeEnvio } from './campanas-envio.service';
import { CampanasService } from './campanas.service';
import { CrearCampanaDto } from './dto/crear-campana.dto';

/**
 * Campañas contra PostgreSQL real, con Meta simulado en la frontera
 * (`WhatsappCloudService`): lo que se prueba es a quién se le manda, en qué
 * orden, qué NO se toca del chat, que nadie reciba dos veces y qué se cuenta.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';
if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService(URL_TEST);
const LINEA = '00000000-0000-4000-8000-0000000c0001';
/** 10:00 en La Paz: dentro del horario de envío. */
const AHORA = new Date('2026-10-01T14:00:00.000Z');
/** 22:00 en La Paz: fuera. */
const DE_NOCHE = new Date('2026-10-02T02:00:00.000Z');
const hace = (dias: number) => new Date(AHORA.getTime() - dias * 24 * 60 * 60 * 1000);

const PLANTILLAS = [
  { name: 'promo_octubre', status: 'APPROVED', category: 'MARKETING', language: 'es', components: [{ type: 'BODY', text: 'Hola {{1}}, {{2}}' }] },
  { name: 'recordatorio', status: 'APPROVED', category: 'UTILITY', language: 'es', components: [{ type: 'BODY', text: 'Tu cita es mañana' }] },
];

class GatewayMudo {
  emitirActividad(): void {}
  notificarEntrante(): void {}
}

let campanas: CampanasService;
let envio: CampanasEnvioService;
let whatsapp: WhatsappCloudService;
let envios: string[];
let duenoId: string;
let periodoId: string;
let n = 0;

async function limpiar() {
  await prisma.auditLog.deleteMany();
  await prisma.campana.deleteMany();
  await prisma.mensaje.deleteMany();
  await prisma.conversacion.deleteMany();
  await prisma.venta.deleteMany();
  await prisma.ventaImportada.deleteMany();
  await prisma.periodoComision.deleteMany();
  await prisma.cliente.deleteMany();
  await prisma.usuario.deleteMany();
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await limpiar();
  await prisma.lineaWhatsapp.deleteMany({ where: { id: LINEA } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await limpiar();
  await prisma.lineaWhatsapp.upsert({
    where: { id: LINEA },
    create: { id: LINEA, nombre: 'Ventas campañas', comercial: true, activa: true, phoneNumberId: '9101', wabaId: 'waba-9101', tokenEnv: 'TOKEN_PRUEBA_CAMPANAS' },
    update: { activa: true, phoneNumberId: '9101', tokenEnv: 'TOKEN_PRUEBA_CAMPANAS' },
  });
  duenoId = (await prisma.usuario.create({ data: { nombre: 'Dueño', email: 'dueno@test.local', passwordHash: 'x', rol: 'SUPER_ADMIN' } })).id;
  periodoId = (await prisma.periodoComision.create({ data: { anio: 2026, mes: 9, tipoCambio: 6.97 } })).id;

  const config = new ConfigService({ TOKEN_PRUEBA_CAMPANAS: 'token' });
  const gateway = new GatewayMudo() as unknown as ConversacionesGateway;
  const r2 = {} as R2Service;
  const audit = new AuditService(prisma);
  const tipoCambio = new TipoCambioService(prisma, audit);
  const clientes = new ClientesService(prisma, audit, new ServiciosService(prisma), categoriasDePrueba(prisma));
  whatsapp = new WhatsappCloudService();
  envios = [];
  jest.spyOn(whatsapp, 'listarPlantillas').mockResolvedValue(PLANTILLAS);
  jest.spyOn(whatsapp, 'enviar').mockImplementation(async telefono => {
    envios.push(telefono);
    return { estado: 'ENVIADO' as const, metaMsgId: `wamid.c${envios.length}` };
  });
  const lineas = new LineasWhatsappService(prisma, config);
  const despachador = new DespachadorSalienteService(prisma, gateway, r2, whatsapp, lineas);
  const plantillas = new EnvioPlantillasService(prisma, clientes, gateway, whatsapp, despachador, lineas);
  campanas = new CampanasService(prisma, audit, new AudienciasService(prisma, tipoCambio), plantillas, tipoCambio);
  envio = new CampanasEnvioService(prisma, plantillas);
  jest.spyOn(envio['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(envio['logger'], 'error').mockImplementation(() => undefined);
});

/** Una paciente Gold con su gasto en FileMaker. */
async function paciente(nombre: string, gasto: number, extra: { baja?: boolean } = {}) {
  n += 1;
  const pac = `CAMP${n}`;
  const cliente = await prisma.cliente.create({
    data: { nombre, telefono: `+5917${String(n).padStart(7, '0')}`, pac, categoria: 'GOLD', bajaPromocionesEn: extra.baja ? hace(1) : null },
  });
  await prisma.ventaImportada.create({
    data: {
      periodoId, pac, precio: gasto, fecha: hace(20), detalle: 'Servicio', paciente: nombre,
      canal: 'PROPIO', ingresoNeto: 0, unidadNegocio: 'VARIOS', clasif: 'CONSULTA', tipo: 'A',
    },
  });
  return cliente;
}

function datosCampana(elegiblesVistas: number, extra: Partial<CrearCampanaDto> = {}): CrearCampanaDto {
  return {
    nombre: 'Octubre Gold',
    lineaId: LINEA,
    plantilla: 'promo_octubre',
    idioma: 'es',
    variables: [{ tipo: 'NOMBRE', respaldo: 'hola' }, { tipo: 'TEXTO', texto: 'tienes 20 % en ecografías' }],
    filtro: { categorias: ['GOLD'], diasSinCampana: 30, soloConversaron: false },
    tarifaUsd: 0.055,
    elegiblesVistas,
    ...extra,
  } as CrearCampanaDto;
}

describe('crear una campaña', () => {
  it('congela la audiencia de más a menos gasto, y rechaza si cambió', async () => {
    const ana = await paciente('ana pérez', 4_000);
    const beto = await paciente('Beto Rojas', 9_000);
    await expect(campanas.crear(datosCampana(3), duenoId, AHORA)).rejects.toMatchObject({ status: 409 });

    const creada = await campanas.crear(datosCampana(2), duenoId, AHORA);
    expect(creada).toMatchObject({ estado: 'ENVIANDO', metricas: { total: 2, pendientes: 2 } });
    const orden = await prisma.campanaDestinatario.findMany({ orderBy: { orden: 'asc' }, select: { clienteId: true } });
    expect(orden.map(d => d.clienteId)).toEqual([beto.id, ana.id]);
  });

  it('solo plantillas de Marketing, y con fecha futura queda programada', async () => {
    await paciente('Ana', 4_000);
    await expect(
      campanas.crear(datosCampana(1, { plantilla: 'recordatorio', variables: [] }), duenoId, AHORA),
    ).rejects.toMatchObject({ status: 400 });
    const manana = new Date(AHORA.getTime() + 24 * 60 * 60 * 1000).toISOString();
    expect(await campanas.crear(datosCampana(1, { programadaPara: manana }), duenoId, AHORA)).toMatchObject({ estado: 'PROGRAMADA' });
  });
});

describe('el envío', () => {
  it('dos workers no se roban una reserva viva mientras Meta responde', async () => {
    await paciente('Ana', 4_000);
    await campanas.crear(datosCampana(1), duenoId, AHORA);
    let avisar!: () => void;
    let liberar!: () => void;
    const inicio = new Promise<void>(resolve => { avisar = resolve; });
    const respuesta = new Promise<void>(resolve => { liberar = resolve; });
    jest.spyOn(whatsapp, 'enviar').mockImplementationOnce(async telefono => {
      envios.push(telefono);
      avisar();
      await respuesta;
      return { estado: 'ENVIADO', metaMsgId: 'wamid.concurrente' };
    });
    const primero = envio.procesar(AHORA);
    try {
      await inicio;
      const segundo = new CampanasEnvioService(prisma, campanas['plantillas']);
      expect(await segundo.procesar(AHORA)).toBe(0);
      expect(envios).toHaveLength(1);
    } finally {
      liberar();
      await primero;
    }
    expect(await prisma.campanaDestinatario.findFirstOrThrow()).toMatchObject({ estado: 'ENVIADO' });
  });

  it('cancelar durante una validación fallida no deja pendientes ni cambia CANCELADA a PAUSADA', async () => {
    await paciente('Ana', 4_000);
    const creada = await campanas.crear(datosCampana(1), duenoId, AHORA);
    let avisar!: () => void;
    let liberar!: () => void;
    const inicio = new Promise<void>(resolve => { avisar = resolve; });
    const respuesta = new Promise<void>(resolve => { liberar = resolve; });
    campanas['plantillas']['cachePlantillas'].invalidar();
    jest.spyOn(whatsapp, 'listarPlantillas').mockImplementationOnce(async () => {
      avisar();
      await respuesta;
      return [];
    });
    const vuelta = envio.procesar(AHORA);
    try {
      await inicio;
      await campanas.cancelar(creada.id, duenoId);
    } finally {
      liberar();
      await vuelta;
    }
    expect(await prisma.campana.findUniqueOrThrow({ where: { id: creada.id } })).toMatchObject({ estado: 'CANCELADA' });
    expect(await prisma.campanaDestinatario.findFirstOrThrow()).toMatchObject({ estado: 'OMITIDO' });
    expect(envios).toHaveLength(0);
  });

  it('el cupo limita también las omisiones: no recorre toda una campaña en una vuelta', async () => {
    await Promise.all(Array.from({ length: 21 }, (_, i) => paciente(`Paciente ${i}`, 4_000)));
    await campanas.crear(datosCampana(21), duenoId, AHORA);
    await prisma.cliente.updateMany({ data: { bajaPromocionesEn: AHORA } });
    expect(await envio.procesar(AHORA)).toBe(0);
    expect(await prisma.campanaDestinatario.count({ where: { estado: 'PENDIENTE' } })).toBe(1);
    expect(await prisma.campanaDestinatario.count({ where: { estado: 'OMITIDO' } })).toBe(20);
    await envio.procesar(AHORA);
    expect(await prisma.campana.findFirstOrThrow()).toMatchObject({ estado: 'TERMINADA' });
  });

  it('recupera una reserva interrumpida en la siguiente vuelta, sin reiniciar el backend', async () => {
    await paciente('Ana', 4_000);
    await campanas.crear(datosCampana(1), duenoId, AHORA);
    await prisma.campanaDestinatario.updateMany({ data: { estado: 'ENVIANDO' } });

    expect(await envio.procesar(AHORA)).toBe(1);
    expect(envios).toHaveLength(1);
    expect(await prisma.campanaDestinatario.findFirstOrThrow()).toMatchObject({ estado: 'ENVIADO' });
  });

  it('si falla enlazar el mensaje ya enviado, lo recupera sin otro WhatsApp ni falso fallo', async () => {
    await paciente('Ana', 4_000);
    await campanas.crear(datosCampana(1), duenoId, AHORA);
    // Fallar la confirmación REAL de PostgreSQL, después del despacho a Meta.
    await prisma.$executeRawUnsafe(`CREATE FUNCTION crm_test_fallo_enlace() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.estado = 'ENVIADO' THEN RAISE EXCEPTION 'Fallo transitorio al enlazar'; END IF; RETURN NEW; END $$`);
    try {
      await prisma.$executeRawUnsafe(`CREATE TRIGGER crm_test_fallo_enlace BEFORE UPDATE ON "CampanaDestinatario"
        FOR EACH ROW EXECUTE FUNCTION crm_test_fallo_enlace()`);
      await envio.procesar(AHORA);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS crm_test_fallo_enlace ON "CampanaDestinatario"');
      await prisma.$executeRawUnsafe('DROP FUNCTION crm_test_fallo_enlace()');
    }
    expect(await prisma.campanaDestinatario.findFirstOrThrow()).toMatchObject({ estado: 'ENVIANDO' });
    expect(await envio.procesar(AHORA)).toBe(1);
    expect(envios).toHaveLength(1);
    expect(await prisma.campanaDestinatario.findFirstOrThrow()).toMatchObject({ estado: 'ENVIADO', mensajeId: expect.any(String) });
  });

  it('un fallo al comprobar otra campaña no deja la reserva bloqueada ni impide las siguientes', async () => {
    await paciente('Ana', 4_000);
    await paciente('Beto', 9_000);
    await campanas.crear(datosCampana(2), duenoId, AHORA);
    const fallo = jest.spyOn(prisma.mensaje, 'findFirst').mockRejectedValueOnce(new Error('Base temporalmente indisponible'));

    expect(await envio.procesar(AHORA)).toBe(1);
    fallo.mockRestore();
    expect(await envio.procesar(AHORA)).toBe(1);
    expect(envios).toHaveLength(2);
  });

  it('recuperar el enlace de un envío anterior no lo omite por una baja posterior', async () => {
    const ana = await paciente('Ana', 4_000);
    await campanas.crear(datosCampana(1), duenoId, AHORA);
    const destino = await prisma.campanaDestinatario.findFirstOrThrow();
    const { mensajeId } = await campanas['plantillas'].enviarPlantillaDeCampana({
      clienteId: ana.id, lineaId: LINEA, plantilla: 'promo_octubre', idioma: 'es',
      parametros: ['Ana', 'x'], clientMessageId: claveDeEnvio(destino.id),
    });
    await prisma.cliente.update({ where: { id: ana.id }, data: { bajaPromocionesEn: AHORA } });
    await prisma.campanaDestinatario.update({ where: { id: destino.id }, data: { estado: 'ENVIANDO' } });

    // De noche solo se concilia un envío existente; no se despacha otro.
    expect(await envio.procesar(DE_NOCHE)).toBe(1);
    expect(await prisma.campanaDestinatario.findFirstOrThrow()).toMatchObject({ estado: 'ENVIADO', mensajeId });
    expect(envios).toHaveLength(1);
  });

  it('espera al horario, manda en orden y personaliza; no toca el chat', async () => {
    const ana = await paciente('ana pérez', 4_000);
    const beto = await paciente('Beto Rojas', 9_000);
    /* Ana ya tenía un chat abierto, esperando respuesta y sin agente. */
    const chatAna = await prisma.conversacion.create({
      data: { clienteId: ana.id, lineaId: LINEA, esperandoRespuesta: true, updatedAt: hace(2) },
    });
    await campanas.crear(datosCampana(2), duenoId, AHORA);

    expect(await envio.procesar(DE_NOCHE)).toBe(0);
    expect(envios).toEqual([]);

    expect(await envio.procesar(AHORA)).toBe(2);
    expect(envios).toEqual([beto.telefono, ana.telefono]);

    const mensajeAna = await prisma.mensaje.findFirstOrThrow({ where: { conversacionId: chatAna.id } });
    expect(mensajeAna).toMatchObject({ contenido: 'Hola Ana, tienes 20 % en ecografías', automatico: true, plantillaCategoria: 'MARKETING' });
    /* El chat de Ana: sigue esperando a una persona, sin dueño, en su sitio. */
    expect(await prisma.conversacion.findUniqueOrThrow({ where: { id: chatAna.id } })).toMatchObject({
      esperandoRespuesta: true, agenteId: null, cerradaEn: null, updatedAt: hace(2),
    });
    /* Beto no tenía chat: nace cerrado, y ninguna paciente queda asignada. */
    expect(await prisma.conversacion.findFirstOrThrow({ where: { clienteId: beto.id } })).toMatchObject({ cerradaEn: expect.any(Date) });
    expect(await prisma.cliente.count({ where: { agenteId: { not: null } } })).toBe(0);

    /* Sin nadie pendiente, termina; y una vuelta más no le manda a nadie otra vez. */
    expect(await prisma.campana.findFirstOrThrow()).toMatchObject({ estado: 'TERMINADA' });
    expect(await envio.procesar(AHORA)).toBe(0);
    expect(envios).toHaveLength(2);
  });

  it('omite a quien pidió la baja o recibió otra campaña después de crearla', async () => {
    const ana = await paciente('Ana', 4_000);
    const beto = await paciente('Beto', 9_000);
    await campanas.crear(datosCampana(2), duenoId, AHORA);
    await prisma.cliente.update({ where: { id: ana.id }, data: { bajaPromocionesEn: AHORA } });
    const chat = await prisma.conversacion.create({ data: { clienteId: beto.id, lineaId: LINEA } });
    await prisma.mensaje.create({ data: { conversacionId: chat.id, direccion: 'SALIENTE', contenido: 'otra', plantillaCategoria: 'MARKETING', createdAt: hace(3) } });

    expect(await envio.procesar(AHORA)).toBe(0);
    const destinos = await prisma.campanaDestinatario.findMany({ orderBy: { orden: 'asc' }, select: { estado: true, motivo: true } });
    expect(destinos).toEqual([
      { estado: 'OMITIDO', motivo: expect.stringContaining('Recibió otra campaña') },
      { estado: 'OMITIDO', motivo: 'Pidió no recibir promociones' },
    ]);
  });

  it('si la plantilla deja de estar aprobada, se pausa con el motivo y nadie se pierde', async () => {
    await paciente('Ana', 4_000);
    const creada = await campanas.crear(datosCampana(1), duenoId, AHORA);
    jest.spyOn(whatsapp, 'listarPlantillas').mockResolvedValue([]);
    campanas['plantillas']['cachePlantillas'].invalidar();

    await envio.procesar(AHORA);
    const pausada = await campanas.detalle(creada.id);
    expect(pausada).toMatchObject({ estado: 'PAUSADA', motivoPausa: expect.stringContaining('no está aprobada'), metricas: { pendientes: 1 } });
  });

  it('el mismo destinatario nunca recibe dos mensajes', async () => {
    const ana = await paciente('Ana', 4_000);
    await campanas.crear(datosCampana(1), duenoId, AHORA);
    const destino = await prisma.campanaDestinatario.findFirstOrThrow();
    const pedido = {
      clienteId: ana.id, lineaId: LINEA, plantilla: 'promo_octubre', idioma: 'es',
      parametros: ['Ana', 'x'], clientMessageId: claveDeEnvio(destino.id),
    };
    const uno = await campanas['plantillas'].enviarPlantillaDeCampana(pedido);
    /* Se cayó entre guardar y marcar: la fila vuelve a la cola y se reintenta. */
    expect(await envio.procesar(AHORA)).toBe(1);
    expect((await prisma.campanaDestinatario.findFirstOrThrow()).mensajeId).toBe(uno.mensajeId);
    expect(envios).toHaveLength(1);
  });
});

describe('controlarla', () => {
  it('pausar, reanudar y cancelar respetan el estado', async () => {
    await paciente('Ana', 4_000);
    await paciente('Beto', 9_000);
    const { id } = await campanas.crear(datosCampana(2), duenoId, AHORA);

    expect(await campanas.pausar(id, duenoId)).toMatchObject({ estado: 'PAUSADA' });
    expect(await envio.procesar(AHORA)).toBe(0);
    await expect(campanas.pausar(id, duenoId)).rejects.toMatchObject({ status: 409 });
    expect(await campanas.reanudar(id, duenoId, AHORA)).toMatchObject({ estado: 'ENVIANDO' });
    expect(await campanas.cancelar(id, duenoId)).toMatchObject({ estado: 'CANCELADA', metricas: { omitidos: 2, pendientes: 0 } });
    await expect(campanas.reanudar(id, duenoId)).rejects.toMatchObject({ status: 409 });
    expect(envios).toEqual([]);
  });
});

describe('medirla', () => {
  it('cuenta entregados, leídos, respuestas, bajas, compras y costo', async () => {
    const ana = await paciente('Ana', 4_000);
    const beto = await paciente('Beto', 9_000);
    const { id } = await campanas.crear(datosCampana(2), duenoId, AHORA);
    await envio.procesar(AHORA);

    const [deBeto, deAna] = await prisma.campanaDestinatario.findMany({ orderBy: { orden: 'asc' }, include: { mensaje: true } });
    const enviado = deBeto.enviadoEn!;
    await prisma.mensaje.update({ where: { id: deBeto.mensajeId! }, data: { estadoEnvio: 'LEIDO', entregadoEn: enviado, leidoEn: enviado } });
    await prisma.mensaje.update({ where: { id: deAna.mensajeId! }, data: { estadoEnvio: 'ENTREGADO', entregadoEn: enviado } });
    await prisma.mensaje.create({
      data: { conversacionId: deBeto.mensaje!.conversacionId, direccion: 'ENTRANTE', contenido: '¡Quiero!', createdAt: new Date(enviado.getTime() + 60_000) },
    });
    await prisma.ventaImportada.create({
      data: {
        periodoId, pac: beto.pac, precio: 350, fecha: new Date(enviado.getTime() + 2 * 24 * 60 * 60 * 1000), detalle: 'Ecografía', paciente: 'Beto',
        canal: 'PROPIO', ingresoNeto: 0, unidadNegocio: 'VARIOS', clasif: 'CONSULTA', tipo: 'A',
      },
    });
    await prisma.cliente.update({ where: { id: ana.id }, data: { bajaPromocionesEn: new Date(enviado.getTime() + 3_600_000) } });

    expect((await campanas.detalle(id)).metricas).toEqual({
      total: 2, pendientes: 0, enviados: 2, omitidos: 0, fallidos: 0,
      entregados: 2, leidos: 1, rechazadosMeta: 0, limiteMeta: 0,
      respondieron: 1, bajas: 1, compraron: 1, ingresoUsd: 350, costoEstimadoUsd: 0.11,
    });
  });
});
