import { BadRequestException, ConflictException } from '@nestjs/common';

import { R2Service } from '../../common/storage/r2.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ArchivoSubido } from './archivo-subido';
import { MemoriaAgenteService } from './memoria-agente.service';

/**
 * Pruebas contra el Postgres de verdad (`crm_test` en el :5433 local).
 *
 * Este endpoint no es solo "Mi Memoria": es también por donde suben TODOS los
 * adjuntos del chat y las notas de voz. Se quedó sin una sola prueba, y así fue
 * como la lista blanca de MIME —pensada cuando solo había imágenes y PDF— se
 * quedó rechazando el audio que graba el composer. La grabadora se desplegó sin
 * poder enviar nada.
 *
 * La cuota se comprueba con SQL de verdad (`aggregate`) porque es justamente lo
 * que una base falsa daría por bueno sin ejecutar.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';

if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService(URL_TEST);

/** R2 es red; se registra lo que se subiría. */
class R2Espia {
  readonly subidos: Array<{ key: string; mime: string }> = [];
  habilitado = true;
  async subir(key: string, _cuerpo: ArrayBuffer, mime: string): Promise<void> {
    this.subidos.push({ key, mime });
  }
  async urlFirmada(key: string): Promise<string | null> {
    return `https://r2.local/${key}`;
  }
  /** Lo que se habría borrado de R2. Vacío = no se tocó el objeto. */
  readonly eliminados: string[] = [];
  async eliminar(key: string): Promise<void> {
    this.eliminados.push(key);
  }
}

let service: MemoriaAgenteService;
let r2: R2Espia;
let usuarioId: string;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.recursoMemoriaAgente.deleteMany();
  /*
   * `Actividad` y `Venta` antes que `Usuario`, y solo esas dos.
   *
   * Esta suite borraba todos los usuarios de entrada, y reventaba de forma
   * intermitente con `Foreign key constraint violated on the constraint:
   * Actividad_agenteId_fkey` — llevándose sus catorce pruebas de golpe. Las
   * filas que estorbaban no son suyas: las deja la suite de Actividades, y
   * que el choque ocurra o no depende del orden en que jest tome los
   * archivos. Por eso fallaba a veces sí y a veces no.
   *
   * Las dos tablas salen de mirar las claves foráneas reales, no de borrar
   * por si acaso: de las trece que apuntan a `Usuario`, once son CASCADE o
   * SET NULL y se resuelven solas. Solo `Actividad.agenteId` y
   * `Venta.agenteId` son RESTRICT, y por tanto solo ellas pueden bloquear.
   * Nada referencia a su vez a esas dos, así que se borran directamente.
   *
   * El arreglo es del test: el `onDelete` de producción no se toca. Que
   * borrar una agente con actividades esté prohibido es una regla correcta.
   */
  await prisma.actividad.deleteMany();
  await prisma.venta.deleteMany();
  await prisma.usuario.deleteMany();

  r2 = new R2Espia();
  service = new MemoriaAgenteService(prisma, r2 as unknown as R2Service);

  const usuario = await prisma.usuario.create({
    data: {
      nombre: 'agente-memoria',
      email: 'agente-memoria@test.local',
      passwordHash: 'x',
      rol: 'AGENTE',
      activo: true,
    },
  });
  usuarioId = usuario.id;
});

function archivo(mimetype: string, nombre = 'archivo', bytes = 1024): ArchivoSubido {
  return {
    originalname: nombre,
    mimetype,
    size: bytes,
    buffer: Buffer.alloc(bytes),
  };
}

describe('MemoriaAgenteService.subirBinario contra Postgres real', () => {
  describe('tipos aceptados', () => {
    it('acepta una nota de voz con el parámetro del códec pegado al MIME', async () => {
      const recurso = await service.subirBinario(
        usuarioId,
        { titulo: 'audio.ogg' },
        archivo('audio/ogg;codecs=opus', 'audio.ogg'),
      );

      expect(recurso.mediaKey).toBeTruthy();
      expect(r2.subidos).toHaveLength(1);
    });

    /* MediaRecorder no entrega el mismo contenedor en todos lados; el de Safari
       importa porque las agentes usan iPhone. */
    it.each(['audio/ogg', 'audio/webm;codecs=opus', 'audio/mp4', 'image/jpeg', 'application/pdf'])(
      'acepta %s',
      async mime => {
        await expect(
          service.subirBinario(usuarioId, { titulo: 't' }, archivo(mime)),
        ).resolves.toBeDefined();
      },
    );

    it.each(['video/mp4', 'application/zip', 'text/html'])('rechaza %s', async mime => {
      await expect(
        service.subirBinario(usuarioId, { titulo: 't' }, archivo(mime)),
      ).rejects.toThrow(BadRequestException);
    });

    it('lo rechazado no llega a R2', async () => {
      await expect(
        service.subirBinario(usuarioId, { titulo: 't' }, archivo('video/mp4')),
      ).rejects.toThrow(BadRequestException);

      expect(r2.subidos).toHaveLength(0);
    });
  });

  describe('límites', () => {
    it('rechaza por encima de 5 MB', async () => {
      await expect(
        service.subirBinario(
          usuarioId,
          { titulo: 'grande' },
          archivo('image/jpeg', 'grande.jpg', 5 * 1024 * 1024 + 1),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('la cuota de 30 MB se mide sumando lo ya guardado, no el archivo suelto', async () => {
      for (let i = 0; i < 6; i++) {
        await service.subirBinario(
          usuarioId,
          { titulo: `foto-${i}` },
          archivo('image/jpeg', `foto-${i}.jpg`, 5 * 1024 * 1024),
        );
      }

      await expect(
        service.subirBinario(usuarioId, { titulo: 'ultima' }, archivo('image/jpeg')),
      ).rejects.toThrow(BadRequestException);
    });

    /* La cuota es POR agente: que una llene la suya no puede dejar sin adjuntar
       a las demás, porque este mismo endpoint es el del chat. */
    it('la cuota de una agente no afecta a otra', async () => {
      for (let i = 0; i < 6; i++) {
        await service.subirBinario(
          usuarioId,
          { titulo: `foto-${i}` },
          archivo('image/jpeg', `foto-${i}.jpg`, 5 * 1024 * 1024),
        );
      }

      const otra = await prisma.usuario.create({
        data: {
          nombre: 'otra-agente',
          email: 'otra-agente@test.local',
          passwordHash: 'x',
          rol: 'AGENTE',
          activo: true,
        },
      });

      await expect(
        service.subirBinario(otra.id, { titulo: 'suya' }, archivo('image/jpeg')),
      ).resolves.toBeDefined();
    });
  });

  it('sin archivo da 400 en vez de guardar un recurso vacío', async () => {
    await expect(service.subirBinario(usuarioId, { titulo: 't' })).rejects.toThrow(
      BadRequestException,
    );
  });
});

/**
 * Borrar un recurso de Mi Memoria no puede romper el historial de una paciente.
 *
 * Este endpoint sube tanto la biblioteca del agente como los adjuntos del chat,
 * así que una misma `mediaKey` puede estar referenciada por mensajes ya
 * enviados. Y en el mensaje se guarda la CLAVE, no el archivo: el servidor
 * firma una URL nueva en cada lectura. Borrar el objeto de R2 dejaba la imagen
 * rota para siempre en la conversación —sin aviso— y condenaba al fracaso
 * cualquier reintento del barrido sobre ese mensaje.
 */
describe('MemoriaAgenteService.remove protege la media ya enviada', () => {
  /* Se limpia SOLO lo que crean estas pruebas, por id. El `beforeEach` común no
     toca conversaciones ni clientes, y dejarlos sueltos contaminaría los
     recuentos de otras suites. */
  const creados: { conversaciones: string[]; clientes: string[]; lineas: string[] } = {
    conversaciones: [], clientes: [], lineas: [],
  };

  afterEach(async () => {
    await prisma.mensaje.deleteMany({ where: { conversacionId: { in: creados.conversaciones } } });
    await prisma.conversacion.deleteMany({ where: { id: { in: creados.conversaciones } } });
    await prisma.cliente.deleteMany({ where: { id: { in: creados.clientes } } });
    await prisma.lineaWhatsapp.deleteMany({ where: { id: { in: creados.lineas } } });
    creados.conversaciones = [];
    creados.clientes = [];
    creados.lineas = [];
  });

  async function conversacionConAdjunto(mediaKey: string): Promise<void> {
    const linea = await prisma.lineaWhatsapp.create({
      data: {
        nombre: `Linea rm ${Date.now()}`,
        tokenEnv: `TOK_RM_${Date.now()}`,
        telefono: `+5915${Date.now() % 10000000}`,
        activa: true,
        comercial: true,
      },
    });
    const cliente = await prisma.cliente.create({
      data: { nombre: 'Paciente rm', telefono: `+5914${Date.now() % 10000000}` },
    });
    const conversacion = await prisma.conversacion.create({
      data: { clienteId: cliente.id, lineaId: linea.id },
    });
    creados.lineas.push(linea.id);
    creados.clientes.push(cliente.id);
    creados.conversaciones.push(conversacion.id);
    await prisma.mensaje.create({
      data: {
        conversacionId: conversacion.id,
        direccion: 'SALIENTE',
        contenido: '',
        estadoEnvio: 'ENVIADO',
        mediaKey,
        mediaMime: 'image/jpeg',
        tipo: 'IMAGEN',
      },
    });
  }

  it('un recurso YA ENVIADO no se puede borrar, y el archivo sigue en R2', async () => {
    const recurso = await service.subirBinario(
      usuarioId,
      { titulo: 'ecografia' },
      archivo('image/jpeg', 'ecografia.jpg'),
    );
    await conversacionConAdjunto(recurso.mediaKey!);

    await expect(service.remove(recurso.id, usuarioId)).rejects.toThrow(ConflictException);

    /* Ni la fila ni el objeto: la operación se rechaza entera. Quitar el
       recurso y dejar el archivo huérfano sería peor — nadie volvería a verlo
       para gestionarlo. */
    expect(await prisma.recursoMemoriaAgente.count({ where: { id: recurso.id } })).toBe(1);
    expect(r2.eliminados).toHaveLength(0);
  });

  it('un recurso NUNCA enviado sigue borrándose con normalidad', async () => {
    const recurso = await service.subirBinario(
      usuarioId,
      { titulo: 'borrador' },
      archivo('image/jpeg', 'borrador.jpg'),
    );

    await expect(service.remove(recurso.id, usuarioId)).resolves.toEqual({
      ok: true,
      id: recurso.id,
    });

    expect(await prisma.recursoMemoriaAgente.count({ where: { id: recurso.id } })).toBe(0);
    expect(r2.eliminados).toEqual([recurso.mediaKey]);
  });

  it('un recurso de texto, sin archivo, no consulta mensajes ni rompe nada', async () => {
    const recurso = await prisma.recursoMemoriaAgente.create({
      data: { usuarioId, titulo: 'precio lipo', contenido: 'Bs 8.000', tipo: 'TEXTO' },
    });

    await expect(service.remove(recurso.id, usuarioId)).resolves.toEqual({
      ok: true,
      id: recurso.id,
    });
    expect(r2.eliminados).toHaveLength(0);
  });
});
