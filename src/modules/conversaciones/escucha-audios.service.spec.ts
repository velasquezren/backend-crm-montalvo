import { ConfigService } from '@nestjs/config';

import { R2Service } from '../../common/storage/r2.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TranscriptorAudio, TurnoModelo } from '../asistente/modelo.port';
import { BYTES_MAXIMOS_AUDIO } from '../asistente/transcripcion';
import { aTurno, rafagaDeLaPaciente } from './asistente-chat.service';
import { AUDIOS_POR_TURNO, audiosDeLaRafaga, EscuchaAudiosService, MensajeEscuchable } from './escucha-audios.service';

/*
 * Las notas de voz para el asistente, sin base ni Google: un Prisma, un R2 y un
 * transcriptor falsos. De punta a punta (webhook → R2 → turno) en
 * `asistente-chat.integracion.spec.ts`.
 */
const m = (id: string, direccion: 'ENTRANTE' | 'SALIENTE', tipo = 'TEXTO', transcripcion: string | null = null, automatico = false): MensajeEscuchable => ({ id, direccion, tipo, transcripcion, automatico });
const USO = { tokensEntrada: 40, tokensSalida: 10 };

describe('audiosDeLaRafaga', () => {
  it('solo las notas de voz de ella desde el último mensaje de la clínica, en orden', () => {
    const mensajes = [m('a0', 'ENTRANTE', 'AUDIO'), m('c1', 'SALIENTE'), m('t1', 'ENTRANTE'), m('a1', 'ENTRANTE', 'AUDIO'), m('i1', 'ENTRANTE', 'IMAGEN'), m('a2', 'ENTRANTE', 'AUDIO')];
    expect(audiosDeLaRafaga(mensajes).map(x => x.id)).toEqual(['a1', 'a2']);
  });
  it('un acuse automático en medio no corta la ráfaga: el audio de antes sigue siendo de lo que se contesta', () => {
    expect(audiosDeLaRafaga([m('a1', 'ENTRANTE', 'AUDIO'), m('acuse', 'SALIENTE', 'TEXTO', null, true)]).map(x => x.id)).toEqual(['a1']);
  });
  it('si lo último lo escribió una persona de la clínica, no hay nada que escuchar', () => {
    expect(audiosDeLaRafaga([m('a1', 'ENTRANTE', 'AUDIO'), m('c1', 'SALIENTE')])).toEqual([]);
  });
  it('un monólogo de audios se escucha hasta el tope: los últimos', () => {
    const muchos = Array.from({ length: 6 }, (_, i) => m(`a${i}`, 'ENTRANTE', 'AUDIO'));
    expect(audiosDeLaRafaga(muchos).map(x => x.id)).toEqual(['a3', 'a4', 'a5']);
    expect(AUDIOS_POR_TURNO).toBe(3);
  });
});

function montar(o: {
  claves?: Record<string, (string | null)[]>; objetos?: Record<string, { bytes: Uint8Array; tipo?: string; declarado?: number | null }>;
  transcribir?: jest.Mock; r2Habilitado?: boolean; esperaMs?: string;
} = {}) {
  const lecturas: Record<string, number> = {};
  const prisma = {
    mensaje: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const serie = o.claves?.[where.id] ?? [null];
        const i = Math.min(lecturas[where.id] ?? 0, serie.length - 1);
        lecturas[where.id] = (lecturas[where.id] ?? 0) + 1;
        return { mediaKey: serie[i], mediaMime: 'audio/ogg; codecs=opus' };
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const cancel = jest.fn();
  const r2 = {
    habilitado: o.r2Habilitado ?? true,
    leer: jest.fn(async (k: string) => {
      const ob = o.objetos?.[k];
      if (!ob) return null;
      return { cuerpo: Object.assign(new Blob([Uint8Array.from(ob.bytes)]).stream(), { cancel }), tipo: ob.tipo ?? 'audio/ogg', bytes: ob.declarado === undefined ? ob.bytes.byteLength : ob.declarado };
    }),
  };
  const transcribir = o.transcribir ?? jest.fn().mockResolvedValue({ texto: 'Hola, quería una cita', uso: USO });
  const servicio = new EscuchaAudiosService(
    prisma as unknown as PrismaService, r2 as unknown as R2Service, { nombre: 't', transcribir } as unknown as TranscriptorAudio,
    new ConfigService({ ASISTENTE_ESPERA_AUDIO_MS: o.esperaMs ?? '0' }),
  );
  jest.spyOn(servicio['logger'], 'warn').mockImplementation(() => undefined);
  return { servicio, transcribir, r2, prisma };
}

const AUDIO = { bytes: new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]) };

describe('EscuchaAudiosService', () => {
  it('transcribe la nota de voz con sus bytes y el tipo que manda WhatsApp, la guarda una vez y suma el consumo', async () => {
    const { servicio, transcribir, prisma } = montar({ claves: { a1: ['wa/c/a1'] }, objetos: { 'wa/c/a1': AUDIO } });
    const r = await servicio.escuchar([m('t1', 'ENTRANTE'), m('a1', 'ENTRANTE', 'AUDIO')]);
    expect(r.transcripciones.get('a1')).toBe('Hola, quería una cita');
    expect(r.uso).toEqual(USO);
    expect(transcribir).toHaveBeenCalledWith({ bytes: AUDIO.bytes, mime: 'audio/ogg; codecs=opus' });
    /* `transcripcion: null` en el where: si dos turnos la escuchan a la vez, la primera gana y nada se pisa. */
    expect(prisma.mensaje.updateMany).toHaveBeenCalledWith({ where: { id: 'a1', transcripcion: null }, data: { transcripcion: 'Hola, quería una cita' } });
  });

  it('lo ya escuchado no vuelve a Google, y un audio de antes sigue teniendo su texto', async () => {
    const { servicio, transcribir, prisma } = montar();
    const r = await servicio.escuchar([m('a0', 'ENTRANTE', 'AUDIO', 'lo de antes'), m('c1', 'SALIENTE'), m('a1', 'ENTRANTE', 'AUDIO', 'lo de ahora')]);
    expect(Object.fromEntries(r.transcripciones)).toEqual({ a0: 'lo de antes', a1: 'lo de ahora' });
    expect(transcribir).not.toHaveBeenCalled();
    expect(prisma.mensaje.findUnique).not.toHaveBeenCalled();
    expect(r.uso).toEqual({ tokensEntrada: 0, tokensSalida: 0 });
  });

  it('lo que no se entendió no se guarda (se reintenta si vuelve a estar en la ráfaga)', async () => {
    const { servicio, prisma } = montar({ claves: { a1: ['k'] }, objetos: { k: AUDIO }, transcribir: jest.fn().mockResolvedValue({ texto: null, uso: USO }) });
    expect((await servicio.escuchar([m('a1', 'ENTRANTE', 'AUDIO')])).transcripciones.get('a1')).toBeNull();
    expect(prisma.mensaje.updateMany).not.toHaveBeenCalled();
  });

  it('espera a que el audio termine de bajar a R2', async () => {
    const { servicio } = montar({ claves: { a1: [null, null, 'wa/c/a1'] }, objetos: { 'wa/c/a1': AUDIO }, esperaMs: '5000' });
    const r = await servicio.escuchar([m('a1', 'ENTRANTE', 'AUDIO')]);
    expect(r.transcripciones.get('a1')).toBe('Hola, quería una cita');
  }, 10_000);

  it('si no bajó a tiempo, no se escuchó: null, y no se llama a Google', async () => {
    const { servicio, transcribir } = montar({ claves: { a1: [null] } });
    const r = await servicio.escuchar([m('a1', 'ENTRANTE', 'AUDIO')]);
    expect(r.transcripciones.get('a1')).toBeNull();
    expect(transcribir).not.toHaveBeenCalled();
  });

  it('un audio de más de 10 MB no se descarga entero ni se manda', async () => {
    const { servicio, transcribir } = montar({ claves: { a1: ['k'] }, objetos: { k: { ...AUDIO, declarado: BYTES_MAXIMOS_AUDIO + 1 } } });
    expect((await servicio.escuchar([m('a1', 'ENTRANTE', 'AUDIO')])).transcripciones.get('a1')).toBeNull();
    expect(transcribir).not.toHaveBeenCalled();
  });

  it('sin R2 configurado no hay audio que escuchar', async () => {
    const { servicio, transcribir } = montar({ r2Habilitado: false, claves: { a1: ['k'] }, objetos: { k: AUDIO } });
    expect((await servicio.escuchar([m('a1', 'ENTRANTE', 'AUDIO')])).transcripciones.get('a1')).toBeNull();
    expect(transcribir).not.toHaveBeenCalled();
  });

  it('si Google falla con uno, ese queda sin escuchar y los demás siguen', async () => {
    const transcribir = jest.fn().mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce({ texto: 'segundo', uso: USO });
    const { servicio } = montar({ claves: { a1: ['k1'], a2: ['k2'] }, objetos: { k1: AUDIO, k2: AUDIO }, transcribir });
    const r = await servicio.escuchar([m('a1', 'ENTRANTE', 'AUDIO'), m('a2', 'ENTRANTE', 'AUDIO')]);
    expect(r.transcripciones.get('a1')).toBeNull();
    expect(r.transcripciones.get('a2')).toBe('segundo');
  });

  it('sin audios en la ráfaga no toca nada', async () => {
    const { servicio, prisma, transcribir } = montar();
    const r = await servicio.escuchar([m('t1', 'ENTRANTE')]);
    expect(r.transcripciones.size).toBe(0);
    expect(prisma.mensaje.findUnique).not.toHaveBeenCalled();
    expect(transcribir).not.toHaveBeenCalled();
  });
});

describe('aTurno con notas de voz', () => {
  const audio = { id: 'a1', direccion: 'ENTRANTE' as const, tipo: 'AUDIO' as const, contenido: '', mediaNombre: null, transcripcion: null, automatico: false, createdAt: new Date() };
  const textoDe = (t: TurnoModelo | null) => (t && 'texto' in t ? t.texto : null);
  it('recupera la transcripción guardada de un audio anterior aunque ya no forme parte de la ráfaga', () => {
    const anterior = { ...audio, transcripcion: 'Quiero consultar con la doctora el jueves.' };
    expect(textoDe(aTurno(anterior, new Map()))).toContain('la doctora el jueves');
    expect(textoDe(aTurno(anterior, new Map([['a1', null]])))).toBe('[Nota de voz: no se pudo escuchar]');
  });
  it('transcrita, el modelo la lee como lo que ella dijo, y entra en la ráfaga que filtra el triaje', () => {
    const t = aTurno(audio, new Map([['a1', 'me duele la panza desde ayer']]));
    expect(t).toEqual({ rol: 'paciente', texto: '[Nota de voz, transcrita] me duele la panza desde ayer' });
    expect(rafagaDeLaPaciente(t ? [t] : [])).toContain('me duele la panza');
  });
  it('si no se pudo escuchar, lo dice; una anterior a la ráfaga sigue como antes', () => {
    expect(textoDe(aTurno(audio, new Map([['a1', null]])))).toBe('[Nota de voz: no se pudo escuchar]');
    expect(textoDe(aTurno(audio))).toBe('[Audio: no lo puedes escuchar]');
    expect(textoDe(aTurno(audio, new Map()))).toBe('[Audio: no lo puedes escuchar]');
  });
});
