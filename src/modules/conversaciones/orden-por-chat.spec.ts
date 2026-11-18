import { chatsConDespachosEnCurso, enOrdenPorChat } from './orden-por-chat';

/** Una tarea que termina cuando se le dice, y anota cuándo empezó y terminó. */
function tarea(nombre: string, registro: string[]) {
  let terminar!: () => void;
  let fallar!: (e: Error) => void;
  const hecha = new Promise<void>((ok, mal) => { terminar = ok; fallar = mal; });
  return {
    trabajo: () => { registro.push(`empieza ${nombre}`); return hecha.then(() => { registro.push(`termina ${nombre}`); }); },
    terminar: () => terminar(),
    fallar: () => fallar(new Error(nombre)),
  };
}

const vaciar = () => new Promise(resolve => setImmediate(resolve));

describe('envíos a Meta en orden por chat', () => {
  it('en el mismo chat, la segunda foto no sale hasta que terminó la primera', async () => {
    const registro: string[] = [];
    const uno = tarea('foto 1', registro);
    const dos = tarea('foto 2', registro);
    const fin1 = enOrdenPorChat('chat-a', uno.trabajo);
    const fin2 = enOrdenPorChat('chat-a', dos.trabajo);
    await vaciar();
    expect(registro).toEqual(['empieza foto 1']);
    uno.terminar();
    await fin1;
    await vaciar();
    expect(registro).toEqual(['empieza foto 1', 'termina foto 1', 'empieza foto 2']);
    dos.terminar();
    await fin2;
    await vaciar();
    expect(chatsConDespachosEnCurso()).toBe(0);
  });

  it('un fallo no frena lo que viene detrás, y quien lo encoló recibe su error', async () => {
    const registro: string[] = [];
    const uno = tarea('foto 1', registro);
    const dos = tarea('foto 2', registro);
    const fin1 = enOrdenPorChat('chat-b', uno.trabajo);
    const fin2 = enOrdenPorChat('chat-b', dos.trabajo);
    uno.fallar();
    /* El error llega a quien encoló: `enSegundoPlano` lo registra. */
    await expect(fin1).rejects.toThrow('foto 1');
    await vaciar();
    expect(registro).toContain('empieza foto 2');
    dos.terminar();
    await expect(fin2).resolves.toBeUndefined();
  });

  it('chats distintos no se esperan entre sí', async () => {
    const registro: string[] = [];
    const a = tarea('chat c', registro);
    const b = tarea('chat d', registro);
    enOrdenPorChat('chat-c', a.trabajo);
    enOrdenPorChat('chat-d', b.trabajo);
    await vaciar();
    expect(registro).toEqual(['empieza chat c', 'empieza chat d']);
    a.terminar();
    b.terminar();
    await vaciar();
  });
});
