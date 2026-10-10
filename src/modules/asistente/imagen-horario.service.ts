import { Injectable, Logger } from '@nestjs/common';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CacheMemoria } from '../../common/cache/cache-memoria';
import { R2Service } from '../../common/storage/r2.service';
import { AgendaMedicosCrmService } from '../agenda/agenda-medicos-crm.service';
import { ANCHO_HORARIO, svgDelHorario, VERSION_DISENO_HORARIO } from './horario-imagen';

export interface ImagenHorario {
  readonly key: string;
  readonly mime: 'image/png';
  readonly nombre: string;
}

const DIRECTORIO_FUENTES = join(process.cwd(), 'assets', 'fuentes');

/**
 * El WASM se inicia UNA vez por proceso: `initWasm` es global al módulo y una
 * segunda llamada lanza. Por eso vive aquí y no en la instancia.
 */
let motor: Promise<Uint8Array[]> | null = null;

function motorListo(): Promise<Uint8Array[]> {
  motor ??= (async () => {
    await initWasm(await readFile(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
    return Promise.all(['Poppins-Regular.ttf', 'Poppins-SemiBold.ttf'].map(async f => new Uint8Array(await readFile(join(DIRECTORIO_FUENTES, f)))));
  })().catch((error: unknown) => {
    motor = null;
    throw error;
  });
  return motor;
}

/**
 * La imagen del horario de un médico, dibujada una vez por versión del horario
 * y guardada en R2 (`asistente/horarios/`). Se manda como cualquier adjunto:
 * se guarda la CLAVE y el despachador firma la URL al enviar (una URL firmada
 * guardada caduca en una hora; ya rompió imágenes dos veces).
 *
 * WASM y no un binario nativo (`sharp`, `@resvg/resvg-js`): este servidor no
 * tiene staging, y una dependencia que compila contra la versión de Node o de
 * glibc es la que se rompe en un despliegue. El costo es velocidad, y aquí no
 * importa: la imagen se dibuja una vez por horario.
 */
@Injectable()
export class ImagenHorarioService {
  private readonly logger = new Logger(ImagenHorarioService.name);
  /** Lo ya subido en este proceso: no hace falta preguntarle a R2 cada vez. */
  private readonly subidas = new CacheMemoria<true>({ ttlMs: 24 * 3_600_000, maxEntradas: 200 });

  constructor(
    private readonly agenda: AgendaMedicosCrmService,
    private readonly r2: R2Service,
  ) {}

  /** `null` si no se puede (médico inactivo, agenda o R2 sin configurar): quien llama manda el horario en texto. */
  async de(medicoId: number): Promise<ImagenHorario | null> {
    if (!this.r2.habilitado) return null;
    const horario = await this.agenda.horarioSemanal(medicoId);
    if (!horario || horario.bloques.length === 0) return null;
    const svg = svgDelHorario({ medico: horario.nombre, especialidad: horario.especialidad, bloques: horario.bloques });
    const huella = createHash('sha256').update(`${VERSION_DISENO_HORARIO}:${svg}`).digest('hex').slice(0, 16);
    const key = `asistente/horarios/${medicoId}-${huella}.png`;
    const imagen: ImagenHorario = { key, mime: 'image/png', nombre: `Horario ${horario.nombre}.png` };
    await this.subidas.resolver(key, async () => {
      if (await this.r2.leer(key)) return true;
      const png = await this.dibujar(svg);
      await this.r2.subir(key, png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer, 'image/png');
      this.logger.log(`Horario del médico ${medicoId} dibujado (${png.byteLength} bytes)`);
      return true;
    });
    return imagen;
  }

  /** El SVG a PNG. Público para probar que el motor arranca y dibuja con la letra que corresponde. */
  async dibujar(svg: string): Promise<Uint8Array> {
    const fuentes = await motorListo();
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: ANCHO_HORARIO },
      font: { fontBuffers: fuentes, defaultFontFamily: 'Poppins', sansSerifFamily: 'Poppins' },
    });
    const imagen = resvg.render();
    try {
      return imagen.asPng();
    } finally {
      imagen.free();
      resvg.free();
    }
  }
}
