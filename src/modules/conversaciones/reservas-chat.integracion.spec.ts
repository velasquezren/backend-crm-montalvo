import { DespachadorSalienteService } from './despachador-saliente.service';
import { WhatsappCloudService } from '../../common/whatsapp/whatsapp-cloud.service';
import { LineasWhatsappService } from '../lineas-whatsapp/lineas-whatsapp.service';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { R2Service } from '../../common/storage/r2.service';
import { AgendaReservasService } from '../agenda/agenda-reservas.service';
import { ConversacionesGateway } from './conversaciones.gateway';
import { ComprobantesReservaChatService, leerImagenAcotada } from './comprobantes-reserva-chat.service';
import { comprobanteAmbiguo, marcarComprobanteDeReserva, registrarReservaDeChat } from './reservas-chat';
import { BYTES_MAXIMOS_IMAGEN } from '../../common/storage/imagen-publica';

const db = new PrismaService('postgresql://crm_app@127.0.0.1:5433/crm_test');
const telefono = '+59170009988';
let linea: string, apagada: string, chat: string, otroChat: string, cliente: string;
let codigo = 1000000;
const agenda = { registrarPagoDesdeChat: jest.fn<Promise<'REGISTRADO' | 'YA_NO_PENDIENTE'>, [number,Buffer]>() };
const gateway = { emitirActividad: jest.fn() };
const r2 = { leer: jest.fn(async () => ({ cuerpo: new Blob([Uint8Array.from([1,2,3])]).stream(), bytes: 3 })) };
const worker = () => new ComprobantesReservaChatService(db, r2 as unknown as R2Service, agenda as unknown as AgendaReservasService, gateway as unknown as ConversacionesGateway);
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
