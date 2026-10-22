import { DespachadorSalienteService } from './despachador-saliente.service';
import { WhatsappCloudService } from '../../common/whatsapp/whatsapp-cloud.service';
import { LineasWhatsappService } from '../lineas-whatsapp/lineas-whatsapp.service';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { R2Service } from '../../common/storage/r2.service';
import { AgendaReservasService } from '../agenda/agenda-reservas.service';
import { ConversacionesGateway } from './conversaciones.gateway';
import { ConstanciaReservaService } from './constancia-reserva.service';
import { ComprobantesReservaChatService, leerImagenAcotada } from './comprobantes-reserva-chat.service';
import { comprobanteAmbiguo, marcarComprobanteDeReserva, registrarReservaDeChat } from './reservas-chat';
import { BYTES_MAXIMOS_IMAGEN } from '../../common/storage/imagen-publica';
import { AsistenteLineasService } from '../asistente/asistente-lineas.service';
import { DatosComprobante, LectorComprobantes } from '../asistente/modelo.port';
import { TEXTO_NO_ES_COMPROBANTE } from './comprobante-reserva';

const db = new PrismaService('postgresql://crm_app@127.0.0.1:5433/crm_test');
const telefono = '+59170009988';
let linea: string, apagada: string, chat: string, otroChat: string, cliente: string;
let codigo = 1000000;
const agenda = { registrarPagoDesdeChat: jest.fn<Promise<'REGISTRADO' | 'YA_NO_PENDIENTE'>, [number,Buffer]>() };
const gateway = { emitirActividad: jest.fn() };
const r2 = { leer: jest.fn(async () => ({ cuerpo: new Blob([Uint8Array.from([1,2,3])]).stream(), bytes: 3 })) };
const constancia = { enviar: jest.fn(async () => true) };
/* La lectura con IA: apagada por defecto (el camino de siempre); cada prueba de lectura la enciende. */
const lineasIA = { leeComprobantes: jest.fn(async () => false) };
const lector = { nombre: 'lector-sintetico', leer: jest.fn<Promise<{ datos: DatosComprobante; uso: never }>, [unknown]>() };
const despachador = { texto: jest.fn(async () => undefined) };
const worker = () => new ComprobantesReservaChatService(db, r2 as unknown as R2Service, agenda as unknown as AgendaReservasService, gateway as unknown as ConversacionesGateway, constancia as unknown as ConstanciaReservaService,
  lineasIA as unknown as AsistenteLineasService, lector as unknown as LectorComprobantes, despachador as unknown as DespachadorSalienteService);
/** Ahora, como lo escribe un comprobante boliviano: «2026-10-22T15:10». */
const ahoraEnLaPaz = () => new Date().toLocaleString('sv-SE', { timeZone: 'America/La_Paz' }).slice(0, 16).replace(' ', 'T');
const leido = (cambios: Partial<DatosComprobante> = {}): { datos: DatosComprobante; uso: never } => ({ uso: undefined as never, datos: {
  esComprobante: true, monto: 400.25, moneda: 'Bs', fechaHora: ahoraEnLaPaz(), referencia: 'OP-' + randomUUID().slice(0, 8),
  banco: 'Banco sintético', destinatario: null, ordenante: null, ...cambios } });
const cierre = (reserva = ++codigo) => ({ telefono: telefono.slice(1), reserva, montoCentavos:40025, qrClave:'agenda/qr/7-0123456789abcdef.png' });

beforeAll(async () => { await db.$connect(); });
afterAll(async () => { await db.$disconnect(); });
beforeEach(async () => {
  process.env['WHATSAPP_INTERACCIONES'] = 'on';
  const sufijo=randomUUID();
  linea=(await db.lineaWhatsapp.create({data:{nombre:'Prueba reserva chat '+sufijo,phoneNumberId:'reserva-'+sufijo,tokenEnv:'TOKEN_SINTETICO_INEXISTENTE',comercial:false}})).id;
  apagada=(await db.lineaWhatsapp.create({data:{nombre:'Prueba apagada '+sufijo,phoneNumberId:'apagada-'+sufijo,tokenEnv:'TOKEN_SINTETICO_INEXISTENTE',comercial:false}})).id;
  process.env['WHATSAPP_INTERACCIONES_LINEAS']=linea;
  cliente=(await db.cliente.create({data:{nombre:'Paciente sintético de reserva',telefono}})).id;
  chat=(await db.conversacion.create({data:{clienteId:cliente,lineaId:linea}})).id;
  otroChat=(await db.conversacion.create({data:{clienteId:cliente,lineaId:apagada}})).id;
  agenda.registrarPagoDesdeChat.mockReset().mockResolvedValue('REGISTRADO');
  gateway.emitirActividad.mockClear();
  r2.leer.mockClear();
  constancia.enviar.mockClear();
  lineasIA.leeComprobantes.mockReset().mockResolvedValue(false);
  lector.leer.mockReset();
  despachador.texto.mockClear();
});
afterEach(async () => {
  await db.conversacion.deleteMany({where:{id:{in:[chat,otroChat]}}});
  await db.cliente.deleteMany({where:{id:cliente}});
  await db.lineaWhatsapp.deleteMany({where:{id:{in:[linea,apagada]}}});
});

async function pendiente() {
  const datos=cierre();
  const pago=await db.$transaction(tx=>registrarReservaDeChat(tx,chat,datos));
  expect(pago).not.toBeNull();
  await db.mensaje.update({where:{id:pago!.mensajeId},data:{estadoEnvio:'ENVIADO',whatsappMsgId:'meta-'+randomUUID()}});
  const mensaje=await db.mensaje.create({data:{conversacionId:chat,direccion:'ENTRANTE',tipo:'IMAGEN',contenido:'Comprobante sintético',mediaKey:'sintetico/comprobante.png',mediaMime:'image/png'}});
  expect(await db.$transaction(tx=>marcarComprobanteDeReserva(tx,chat,mensaje.id))).toBe(true);
  return {datos,mensaje,pago:pago!,fila:await db.reservaChat.findUniqueOrThrow({where:{reservaAgenda:datos.reserva}})};
}

it('reserva e intención del QR son atómicas; rollback no deja cobro huérfano', async () => {
  const datos=cierre();
  await expect(db.$transaction(async tx=>{await registrarReservaDeChat(tx,chat,datos);throw new Error('fallo-sintetico');})).rejects.toThrow('fallo-sintetico');
  expect(await db.reservaChat.count({where:{reservaAgenda:datos.reserva}})).toBe(0);
  expect(await db.mensaje.count({where:{conversacionId:chat}})).toBe(0);
});
it('cierres duplicados y simultáneos guardan un solo QR con clientMessageId recuperable', async () => {
  const datos=cierre();
  const resultados=await Promise.all([db.$transaction(tx=>registrarReservaDeChat(tx,chat,datos)),db.$transaction(tx=>registrarReservaDeChat(tx,chat,datos))]);
  expect(resultados.filter(Boolean)).toHaveLength(1);
  const mensajes=await db.mensaje.findMany({where:{conversacionId:chat}});
  expect(mensajes).toHaveLength(1);
  expect(mensajes[0]).toMatchObject({estadoEnvio:'FALLIDO',clientMessageId:expect.any(String),proximoIntento:expect.any(Date),mediaKey:datos.qrClave});
});
it('la línea apagada y el teléfono incorrecto no crean cobros', async () => {
  expect(await db.$transaction(tx=>registrarReservaDeChat(tx,otroChat,cierre()))).toBeNull();
  expect(await db.$transaction(tx=>registrarReservaDeChat(tx,chat,{...cierre(),telefono:'59170001122'}))).toBeNull();
  expect(await db.reservaChat.count({where:{conversacionId:{in:[chat,otroChat]}}})).toBe(0);
});
it('una imagen ajena, tardía o anterior al envío del QR no se aplica automáticamente', async () => {
  const datos=cierre();
  const pago=await db.$transaction(tx=>registrarReservaDeChat(tx,chat,datos));
  const ajeno=await db.mensaje.create({data:{conversacionId:otroChat,direccion:'ENTRANTE',contenido:'ajeno'}});
  expect(await db.$transaction(tx=>marcarComprobanteDeReserva(tx,chat,ajeno.id))).toBe(false);
  const propio=await db.mensaje.create({data:{conversacionId:chat,direccion:'ENTRANTE',contenido:'propio'}});
  expect(await db.$transaction(tx=>marcarComprobanteDeReserva(tx,chat,propio.id))).toBe(false);
  await db.mensaje.update({where:{id:pago!.mensajeId},data:{estadoEnvio:'ENVIADO',whatsappMsgId:'meta-'+randomUUID()}});
  expect(await db.$transaction(tx=>marcarComprobanteDeReserva(tx,chat,ajeno.id))).toBe(false);
  expect(await db.$transaction(tx=>marcarComprobanteDeReserva(tx,chat,propio.id,new Date(Date.now()+73*3600000)))).toBe(false);
});
it('dos reservas abiertas no hacen adivinar cuál se está pagando', async () => {
  await db.$transaction(tx=>registrarReservaDeChat(tx,chat,cierre()));
  await db.$transaction(tx=>registrarReservaDeChat(tx,chat,cierre()));
  expect(await db.$transaction(tx=>comprobanteAmbiguo(tx,chat))).toBe(true);
});
it('dos fotos simultáneas solo asocian un comprobante', async () => {
  const datos=cierre();
  const pago=await db.$transaction(tx=>registrarReservaDeChat(tx,chat,datos));
  await db.mensaje.update({where:{id:pago!.mensajeId},data:{estadoEnvio:'ENVIADO',whatsappMsgId:'meta-'+randomUUID()}});
  const fotos=await Promise.all([1,2].map(i=>db.mensaje.create({data:{conversacionId:chat,direccion:'ENTRANTE',contenido:'foto '+i,tipo:'IMAGEN'}})));
  const r=await Promise.all(fotos.map(f=>db.$transaction(tx=>marcarComprobanteDeReserva(tx,chat,f.id))));
  expect(r.filter(Boolean)).toHaveLength(1);
});
it('dos procesos reclaman una sola transferencia a MySQL y notifican realtime', async () => {
  const {fila}=await pendiente();
  await Promise.all([worker().procesar(),worker().procesar()]);
  expect(agenda.registrarPagoDesdeChat).toHaveBeenCalledTimes(1);
  expect((await db.reservaChat.findUniqueOrThrow({where:{id:fila.id}})).estado).toBe('PAGO_REGISTRADO');
  expect(gateway.emitirActividad).toHaveBeenCalledWith(chat);
  /* La constancia, una vez: la pide solo la pasada que registró. */
  expect(constancia.enviar).toHaveBeenCalledTimes(1);
  expect(constancia.enviar).toHaveBeenCalledWith(fila.reservaAgenda, expect.any(Date));
});
it('un comprobante que va a revisión o que la agenda no registró no manda constancia', async () => {
  const {fila}=await pendiente();
  agenda.registrarPagoDesdeChat.mockResolvedValueOnce('YA_NO_PENDIENTE');
  await worker().procesar();
  expect((await db.reservaChat.findUniqueOrThrow({where:{id:fila.id}})).estado).toBe('REVISION');
  const otra=await pendiente();
  agenda.registrarPagoDesdeChat.mockRejectedValueOnce(new Error('fallo externo sintético'));
  await worker().procesar();
  expect((await db.reservaChat.findUniqueOrThrow({where:{id:otra.fila.id}})).estado).toBe('COMPROBANTE_RECIBIDO');
  expect(constancia.enviar).not.toHaveBeenCalled();
});
it('apagar una línea frena transferencias pendientes sin perder el comprobante', async () => {
  const {fila}=await pendiente();
  process.env['WHATSAPP_INTERACCIONES_LINEAS']='';
  expect(await worker().procesar()).toBe(0);
  expect(agenda.registrarPagoDesdeChat).not.toHaveBeenCalled();
  expect((await db.reservaChat.findUniqueOrThrow({where:{id:fila.id}})).estado).toBe('COMPROBANTE_RECIBIDO');
});
it('reinicio respeta lease y recupera después; una reserva ya gestionada queda en revisión', async () => {
  const {fila}=await pendiente();
  const ahora=new Date();
  await db.reservaChat.update({where:{id:fila.id},data:{proximoIntento:new Date(ahora.getTime()+120000)}});
  expect(await worker().procesar(ahora)).toBe(0);
  agenda.registrarPagoDesdeChat.mockResolvedValue('YA_NO_PENDIENTE');
  expect(await worker().procesar(new Date(ahora.getTime()+120001))).toBe(1);
  expect(await db.reservaChat.findUnique({where:{id:fila.id}})).toMatchObject({estado:'REVISION',detalle:expect.stringContaining('No se sobrescribió')});
});
it('fallo parcial no afirma pago confirmado y tiene reintentos limitados', async () => {
  const {fila}=await pendiente();
  agenda.registrarPagoDesdeChat.mockRejectedValue(new Error('fallo externo sintético'));
  await worker().procesar();
  expect(await db.reservaChat.findUnique({where:{id:fila.id}})).toMatchObject({estado:'COMPROBANTE_RECIBIDO',intentos:1,proximoIntento:expect.any(Date)});
  await db.reservaChat.update({where:{id:fila.id},data:{intentos:19,proximoIntento:null}});
  await worker().procesar();
  expect(await db.reservaChat.findUnique({where:{id:fila.id}})).toMatchObject({estado:'REVISION'});
});
it('PDF va a revisión, nunca se carga como imagen', async () => {
  const {mensaje,fila}=await pendiente();
  await db.mensaje.update({where:{id:mensaje.id},data:{mediaMime:'application/pdf'}});
  await worker().procesar();
  expect(agenda.registrarPagoDesdeChat).not.toHaveBeenCalled();
  expect((await db.reservaChat.findUniqueOrThrow({where:{id:fila.id}})).estado).toBe('REVISION');
});
it('bytes sin Content-Length también tienen límite duro', async () => {
  const cuerpo=new ReadableStream<Uint8Array>({ start(c){c.enqueue(new Uint8Array(BYTES_MAXIMOS_IMAGEN+1));c.close();} });
  expect(await leerImagenAcotada(cuerpo)).toBeNull();
});

it('el despachador envía un QR una sola vez y nunca reenvía un resultado incierto', async () => {
  const datos=cierre();
  const pago=await db.$transaction(tx=>registrarReservaDeChat(tx,chat,datos));
  const transporte={enviar:jest.fn().mockResolvedValue({estado:'INCIERTO',motivo:'corte-sintetico'})};
  const d=new DespachadorSalienteService(db,gateway as unknown as ConversacionesGateway,
    {urlFirmada:async()=> 'https://almacen.invalid/qr-sintetico'} as unknown as R2Service,
    transporte as unknown as WhatsappCloudService,{cuentaDeConversacion:async()=>null} as unknown as LineasWhatsappService);
  const enviar=()=>d.texto({mensajeId:pago!.mensajeId,conversacionId:chat,telefono},pago!.texto,pago!.media);
  await Promise.all([enviar(),enviar()]);
  await enviar();
  expect(transporte.enviar).toHaveBeenCalledTimes(1);
  expect((await db.mensaje.findUniqueOrThrow({where:{id:pago!.mensajeId}})).estadoEnvio).toBe('INCIERTO');
});
it('despacho del QR se detiene si se apagó la línea o tomó control una persona', async () => {
  for (const motivo of ['linea','humano']) {
    process.env['WHATSAPP_INTERACCIONES_LINEAS']=linea;
    const pago=await db.$transaction(tx=>registrarReservaDeChat(tx,chat,cierre()));
    if (motivo==='linea') process.env['WHATSAPP_INTERACCIONES_LINEAS']='';
    else await db.conversacion.update({where:{id:chat},data:{atencionTomadaEn:new Date()}});
    const transporte={enviar:jest.fn()};
    const d=new DespachadorSalienteService(db,gateway as unknown as ConversacionesGateway,
      {} as R2Service,transporte as unknown as WhatsappCloudService,{} as LineasWhatsappService);
    await d.texto({mensajeId:pago!.mensajeId,conversacionId:chat,telefono},pago!.texto,pago!.media);
    expect(transporte.enviar).not.toHaveBeenCalled();
    expect(await db.mensaje.findUnique({where:{id:pago!.mensajeId}})).toMatchObject({permiteReintento:false,proximoIntento:null});
  }
});

describe('con la lectura de comprobantes encendida, la IA decide qué llega sola a la agenda', () => {
  beforeEach(() => { lineasIA.leeComprobantes.mockResolvedValue(true); });

  it('un comprobante que coincide en monto, fecha y operación se registra y guarda su lectura', async () => {
    /* Lo que le llega es la constancia, no un aviso de revisión. */
    const {fila}=await pendiente();
    lector.leer.mockResolvedValue(leido());
    expect(await worker().procesar()).toBe(1);
    expect(agenda.registrarPagoDesdeChat).toHaveBeenCalledTimes(1);
    const final=await db.reservaChat.findUniqueOrThrow({where:{id:fila.id}});
    expect(final.estado).toBe('PAGO_REGISTRADO');
    expect(final.lecturaComprobante).toMatchObject({resultado:'COINCIDE',mensajeId:fila.comprobanteMensajeId});
    /* Sin titular en el QR de la agenda no se compara el destinatario: no estorba el resultado. */
    expect((final.lecturaComprobante as {verificaciones:{campo:string}[]}).verificaciones.map(v=>v.campo)).not.toContain('DESTINATARIO');
    expect(constancia.enviar).toHaveBeenCalledTimes(1);
    expect(despachador.texto).not.toHaveBeenCalled();
  });

  it('otro monto, o una fecha anterior al QR, va a revisión y no toca la agenda', async () => {
    for (const cambios of [{monto:250}, {fechaHora:'2020-01-01T10:00'}, {moneda:'USD'}]) {
      const {fila}=await pendiente();
      lector.leer.mockResolvedValueOnce(leido(cambios));
      await worker().procesar();
      const final=await db.reservaChat.findUniqueOrThrow({where:{id:fila.id}});
      expect(final).toMatchObject({estado:'REVISION',detalle:expect.stringContaining('La IA no lo dio por bueno')});
      expect(final.lecturaComprobante).toMatchObject({resultado:'REVISAR'});
    }
    expect(agenda.registrarPagoDesdeChat).not.toHaveBeenCalled();
    expect(constancia.enviar).not.toHaveBeenCalled();
    /* Nunca se queda sin respuesta: una por comprobante. Otro monto, o en dólares, le dice cuánto era. */
    expect(despachador.texto).toHaveBeenCalledTimes(3);
    expect(await db.mensaje.count({where:{conversacionId:chat,contenido:{contains:'no coincide con el de su reserva (Bs 400,25)'}}})).toBe(2);
    expect(await db.mensaje.count({where:{conversacionId:chat,contenido:{contains:'no pudimos validarlo automáticamente'}}})).toBe(1);
  });

  it('sin número de operación legible no pasa solo', async () => {
    const {fila}=await pendiente();
    lector.leer.mockResolvedValue(leido({referencia:null}));
    await worker().procesar();
    expect(agenda.registrarPagoDesdeChat).not.toHaveBeenCalled();
    expect((await db.reservaChat.findUniqueOrThrow({where:{id:fila.id}})).estado).toBe('REVISION');
  });

  it('la misma operación en otra cita es un comprobante reutilizado: revisión', async () => {
    const primera=await pendiente();
    lector.leer.mockResolvedValue(leido({referencia:'OP-REPETIDA-1'}));
    await worker().procesar();
    expect((await db.reservaChat.findUniqueOrThrow({where:{id:primera.fila.id}})).estado).toBe('PAGO_REGISTRADO');
    /* La segunda cita: la primera ya no espera comprobante, así que no hay ambigüedad. */
    const segunda=await pendiente();
    await worker().procesar();
    const final=await db.reservaChat.findUniqueOrThrow({where:{id:segunda.fila.id}});
    expect(final).toMatchObject({estado:'REVISION',detalle:expect.stringContaining('reutilizado')});
    expect(agenda.registrarPagoDesdeChat).toHaveBeenCalledTimes(1);
  });

  it('una imagen que no es comprobante: vuelve a esperar y se le pide, una sola vez; la segunda va a revisión', async () => {
    const {fila,mensaje}=await pendiente();
    lector.leer.mockResolvedValue(leido({esComprobante:false,monto:null,referencia:null,fechaHora:null}));
    await worker().procesar();
    expect(await db.reservaChat.findUniqueOrThrow({where:{id:fila.id}})).toMatchObject({estado:'ESPERANDO_COMPROBANTE',comprobanteMensajeId:null,intentos:0});
    expect(await db.mensaje.count({where:{conversacionId:chat,contenido:TEXTO_NO_ES_COMPROBANTE}})).toBe(1);
    expect(despachador.texto).toHaveBeenCalledTimes(1);
    expect(agenda.registrarPagoDesdeChat).not.toHaveBeenCalled();
    /* Otra pasada no repite el aviso. */
    await worker().procesar();
    expect(despachador.texto).toHaveBeenCalledTimes(1);
    /* Manda otra imagen que tampoco es: ya no se le insiste, la ve una persona. */
    const otra=await db.mensaje.create({data:{conversacionId:chat,direccion:'ENTRANTE',tipo:'IMAGEN',contenido:'',mediaKey:'sintetico/otra.png',mediaMime:'image/png'}});
    expect(await db.$transaction(tx=>marcarComprobanteDeReserva(tx,chat,otra.id))).toBe(true);
    await worker().procesar();
    expect(await db.reservaChat.findUniqueOrThrow({where:{id:fila.id}})).toMatchObject({estado:'REVISION',comprobanteMensajeId:otra.id});
    expect(despachador.texto).toHaveBeenCalledTimes(2);
    expect(await db.mensaje.count({where:{conversacionId:chat,contenido:{contains:'tampoco parece un comprobante'}}})).toBe(1);
    expect(mensaje.id).not.toBe(otra.id);
  });

  it('si la IA no puede leerlo se reintenta, y a la tercera va a revisión sin pasar nunca a la agenda', async () => {
    const {fila}=await pendiente();
    lector.leer.mockRejectedValue(new Error('Vertex sintético caído'));
    await worker().procesar();
    expect(await db.reservaChat.findUniqueOrThrow({where:{id:fila.id}})).toMatchObject({estado:'COMPROBANTE_RECIBIDO',intentos:1,proximoIntento:expect.any(Date)});
    await db.reservaChat.update({where:{id:fila.id},data:{intentos:2,proximoIntento:null}});
    await worker().procesar();
    expect(await db.reservaChat.findUniqueOrThrow({where:{id:fila.id}})).toMatchObject({estado:'REVISION',detalle:expect.stringContaining('no pudo leer')});
    expect(agenda.registrarPagoDesdeChat).not.toHaveBeenCalled();
    expect(despachador.texto).toHaveBeenCalledTimes(1);
  });

  it('si la agenda falla después de leerlo, el reintento no lo vuelve a leer', async () => {
    const {fila}=await pendiente();
    lector.leer.mockResolvedValue(leido());
    agenda.registrarPagoDesdeChat.mockRejectedValueOnce(new Error('agenda sintética caída'));
    await worker().procesar();
    expect(await db.reservaChat.findUniqueOrThrow({where:{id:fila.id}})).toMatchObject({estado:'COMPROBANTE_RECIBIDO',lecturaComprobante:expect.objectContaining({resultado:'COINCIDE'})});
    await db.reservaChat.update({where:{id:fila.id},data:{proximoIntento:null}});
    await worker().procesar();
    expect(lector.leer).toHaveBeenCalledTimes(1);
    expect((await db.reservaChat.findUniqueOrThrow({where:{id:fila.id}})).estado).toBe('PAGO_REGISTRADO');
  });
});
