import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { R2Service } from '../../common/storage/r2.service';
import { TranscriptorAudio } from '../asistente/modelo.port';
import { EscuchaAudiosService } from './escucha-audios.service';
import { TranscripcionAudioService } from './transcripcion-audio.service';
import { ConversacionesGateway } from './conversaciones.gateway';

const db = new PrismaService('postgresql://crm_app:crm_dev_local@127.0.0.1:5433/crm_test');
const LINEA = 'f1700000-0000-4000-8000-000000000001';
const TELEFONO = '+59179001701';
let conversacionId: string;
const transcribir = jest.fn();
const gateway = { emitirActividad: jest.fn() };
const storage = { habilitado: true, leer: jest.fn(async () => ({ cuerpo: new Blob(['audio sintetico']).stream(), bytes: 15, tipo: 'audio/ogg' })) };
const escuchas = new EscuchaAudiosService(db, storage as unknown as R2Service, { nombre: 'sintetico', transcribir } as unknown as TranscriptorAudio, new ConfigService({ ASISTENTE_ESPERA_AUDIO_MS: '0' }), gateway as unknown as ConversacionesGateway);
const worker = new TranscripcionAudioService(db, escuchas);

beforeAll(async () => { await db.$connect(); });
afterAll(async () => {
  delete process.env.TRANSCRIPCION_AUDIO_LINEAS;
  await db.cliente.deleteMany({ where: { telefono: TELEFONO } });
  await db.lineaWhatsapp.deleteMany({ where: { id: LINEA } });
  await db.$disconnect();
});
beforeEach(async () => {
  await db.cliente.deleteMany({ where: { telefono: TELEFONO } });
  await db.lineaWhatsapp.upsert({ where: { id: LINEA }, create: { id: LINEA, nombre: 'Recepción sintética', tokenEnv: 'SINTETICO', activa: true }, update: { activa: true } });
  await db.asistenteLinea.upsert({ where: { lineaId: LINEA }, create: { lineaId: LINEA, modo: 'SOLO_MEDICOS' }, update: { modo: 'SOLO_MEDICOS' } });
  const cliente = await db.cliente.create({ data: { nombre: 'Prueba sintética', telefono: TELEFONO } });
  const c = await db.conversacion.create({ data: { clienteId: cliente.id, lineaId: LINEA, automatizacionPausadaEn: new Date(), esperandoRespuesta: true } });
  conversacionId = c.id;
  process.env.TRANSCRIPCION_AUDIO_LINEAS = LINEA;
  transcribir.mockReset().mockImplementation(async () => {
    await new Promise(r => setTimeout(r, 50));
    return { texto: 'Quisiera consultar un horario.', uso: { tokensEntrada: 8, tokensSalida: 5 } };
  });
  gateway.emitirActividad.mockClear();
});
async function audio(mediaKey: string | null = 'sintetico/audio') {
  return db.mensaje.create({ data: { conversacionId, direccion: 'ENTRANTE', tipo: 'AUDIO', contenido: '', mediaKey, mediaMime: 'audio/ogg', trabajoTranscripcion: { create: {} } } });
}
const tarea = (mensajeId: string) => db.trabajoTranscripcionAudio.findUniqueOrThrow({ where: { mensajeId } });

it('SOLO_MEDICOS: transcribe un audio de paciente en chat pausado, refresca y no responde ni resuelve', async () => {
  const m = await audio();
  const antes = await db.conversacion.findUniqueOrThrow({ where: { id: conversacionId } });
  await worker.barrerPendientes();
  expect((await db.mensaje.findUniqueOrThrow({ where: { id: m.id } })).transcripcion).toBe('Quisiera consultar un horario.');
  expect((await tarea(m.id)).proximoIntento).toBeNull();
  expect(gateway.emitirActividad).toHaveBeenCalledWith(conversacionId);
  expect(await db.mensaje.count({ where: { conversacionId, direccion: 'SALIENTE' } })).toBe(0);
  expect(await db.conversacion.findUnique({ where: { id: conversacionId } })).toMatchObject({ automatizacionPausadaEn: antes.automatizacionPausadaEn, esperandoRespuesta: true, updatedAt: antes.updatedAt });
  expect((await db.asistenteLinea.findUniqueOrThrow({ where: { lineaId: LINEA } })).modo).toBe('SOLO_MEDICOS');
});
it.each(['APAGADO', 'RESPONDER'] as const)('la transcripción también es independiente con asistente %s', async modo => {
  await db.asistenteLinea.update({ where: { lineaId: LINEA }, data: { modo } });
  const m = await audio();
  await worker.procesarUno(m.id);
  expect(transcribir).toHaveBeenCalledTimes(1);
});
it('dos workers y el turno conversacional concurrentes transcriben una sola vez', async () => {
  const m = await audio();
  await Promise.all([worker.procesarUno(m.id), new TranscripcionAudioService(db, escuchas).procesarUno(m.id), escuchas.escuchar([m])]);
  expect(transcribir).toHaveBeenCalledTimes(1);
  expect((await db.mensaje.findUniqueOrThrow({ where: { id: m.id } })).transcripcion).toBeTruthy();
});
it('un reinicio retoma la cola y un trabajo completado no vuelve a llamar al proveedor', async () => {
  const m = await audio();
  await new TranscripcionAudioService(db, escuchas).barrerPendientes();
  await new TranscripcionAudioService(db, escuchas).barrerPendientes();
  expect((await tarea(m.id)).proximoIntento).toBeNull();
  expect(transcribir).toHaveBeenCalledTimes(1);
});
it('línea no habilitada o inactiva no envía audio al proveedor', async () => {
  const m = await audio();
  process.env.TRANSCRIPCION_AUDIO_LINEAS = '';
  await worker.barrerPendientes(); await worker.procesarUno(m.id);
  process.env.TRANSCRIPCION_AUDIO_LINEAS = LINEA;
  await db.lineaWhatsapp.update({ where: { id: LINEA }, data: { activa: false } });
  await worker.procesarUno(m.id);
  expect(transcribir).not.toHaveBeenCalled();
});
it('espera media sin consumir intentos, y no procesa archivos históricos sin tarea', async () => {
  const m = await audio(null);
  await worker.procesarUno(m.id);
  expect(await tarea(m.id)).toMatchObject({ intentos: 0 });
  await db.mensaje.create({ data: { conversacionId, direccion: 'ENTRANTE', tipo: 'AUDIO', contenido: '', mediaKey: 'antiguo' } });
  await worker.barrerPendientes();
  expect(transcribir).not.toHaveBeenCalled();
});
it('audio no entendido tiene reintentos acotados, sin texto inventado ni respuesta', async () => {
  transcribir.mockResolvedValue({ texto: null, uso: { tokensEntrada: 8, tokensSalida: 0 } });
  const m = await audio();
  for (let intento = 0; intento < 3; intento++) {
    await db.trabajoTranscripcionAudio.update({ where: { mensajeId: m.id }, data: { proximoIntento: new Date(0) } });
    await worker.procesarUno(m.id);
  }
  await worker.barrerPendientes();
  expect(transcribir).toHaveBeenCalledTimes(3);
  expect(await tarea(m.id)).toMatchObject({ intentos: 3, proximoIntento: null, ultimoError: 'TRANSCRIPCION_NO_DISPONIBLE' });
  expect((await db.mensaje.findUniqueOrThrow({ where: { id: m.id } })).transcripcion).toBeNull();
  expect(await db.mensaje.count({ where: { conversacionId, direccion: 'SALIENTE' } })).toBe(0);
});
it('no transcribe mensajes salientes aunque una tarea incorrecta los referencie', async () => {
  const m = await audio();
  await db.mensaje.update({ where: { id: m.id }, data: { direccion: 'SALIENTE' } });
  await worker.procesarUno(m.id);
  expect(transcribir).not.toHaveBeenCalled();
  expect((await tarea(m.id)).ultimoError).toBe('NO_ES_AUDIO_ENTRANTE');
});
