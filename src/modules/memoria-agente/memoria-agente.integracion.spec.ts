import { BadRequestException } from '@nestjs/common';

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

const prisma = new PrismaService({ datasources: { db: { url: URL_TEST } } });

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
  async eliminar(): Promise<void> {}
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
