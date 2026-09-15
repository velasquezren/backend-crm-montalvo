import { PrismaService } from '../../prisma/prisma.service';
import { R2Service } from '../../common/storage/r2.service';
import { WhatsappCloudService } from '../../common/whatsapp/whatsapp-cloud.service';
import { LineasWhatsappService } from '../lineas-whatsapp/lineas-whatsapp.service';
import { ConversacionesGateway } from './conversaciones.gateway';
import { MAX_BYTES_MEDIA, MediaEntranteService } from './media-entrante.service';

function servicio() {
  return new MediaEntranteService({} as PrismaService, {} as ConversacionesGateway,
    {} as R2Service, {} as WhatsappCloudService, {} as LineasWhatsappService);
}

describe('media entrante: memoria y cancelación', () => {
  it('descarta por content-length y cancela sin leer bytes', async () => {
    const cancel = jest.fn();
    const respuesta = new Response(new ReadableStream({ cancel }), { headers: { 'content-length': String(MAX_BYTES_MEDIA + 1) } });
    await expect(servicio()['leerAcotado'](respuesta, new AbortController().signal))
      .rejects.toMatchObject({ codigo: 'TAMANO_EXCEDIDO', categoria: 'PERMANENTE' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('corta el stream sin content-length al exceder el máximo', async () => {
    const cancel = jest.fn();
    let lecturas = 0;
    const bloque = new Uint8Array(1024 * 1024);
    const respuesta = new Response(new ReadableStream({
      pull(c) { lecturas++; c.enqueue(bloque); }, cancel,
    }));
    await expect(servicio()['leerAcotado'](respuesta, new AbortController().signal))
      .rejects.toMatchObject({ codigo: 'TAMANO_EXCEDIDO' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(lecturas).toBeLessThanOrEqual(27); // lector + como máximo un bloque en la cola
  });
  it('conserva los bytes de un archivo permitido', async () => {
    const respuesta = new Response(new Uint8Array([1, 3, 5, 7]));
    expect(new Uint8Array(await servicio()['leerAcotado'](respuesta, new AbortController().signal)))
      .toEqual(new Uint8Array([1, 3, 5, 7]));
  });
  it('abortar desbloquea un read pendiente y no devuelve éxito parcial', async () => {
    const cancel = jest.fn();
    const controller = new AbortController();
    const lectura = servicio()['leerAcotado'](new Response(new ReadableStream({ cancel })), controller.signal);
    controller.abort();
    await expect(lectura).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('un service destruido no vuelve a reclamar ni arranca barridos', async () => {
    const s = servicio();
    s.onModuleDestroy();
    expect(await s.barrerPendientes()).toBe(0);
    expect(await s.procesarUno('mensaje')).toBe(false);
  });
  it('no arranca timers automáticamente bajo NODE_ENV=test', () => {
    const timer = jest.spyOn(global, 'setInterval');
    const s = servicio();
    s.onModuleInit();
    s.despertar();
    s.onModuleDestroy();
    expect(timer).not.toHaveBeenCalled();
    timer.mockRestore();
  });
});
