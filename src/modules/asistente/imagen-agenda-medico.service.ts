import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { R2Service } from '../../common/storage/r2.service';
import type { AgendaDelDia } from '../agenda/agenda-medico-citas';
import { svgDeAgendaMedico, VERSION_DISENO_AGENDA_MEDICO } from './agenda-medico-imagen';
import { ImagenHorario, ImagenHorarioService } from './imagen-horario.service';

/**
 * La imagen de la agenda de un médico, dibujada con los datos que devolvió la
 * agenda (no con lo que dijo el modelo) y guardada en R2. Reusa el motor del
 * horario (`ImagenHorarioService.dibujar`: resvg en WASM y la Poppins).
 *
 * La clave es la huella del dibujo: la misma agenda pedida dos veces es el mismo
 * archivo, y una cita nueva es otro. **Lleva nombres de pacientes**: por eso va
 * en su carpeta (`asistente/agenda-medico/`) y no en la de horarios, que es
 * pública en el sentido de que no tiene nada que proteger. Se manda como cualquier
 * adjunto del chat: el despachador firma la URL al enviar.
 */
@Injectable()
export class ImagenAgendaMedicoService {
  private readonly logger = new Logger(ImagenAgendaMedicoService.name);

  constructor(
    private readonly motor: ImagenHorarioService,
    private readonly r2: R2Service,
  ) {}

  /** `null` si no se puede (R2 sin configurar o el motor falló): quien llama manda el listado en texto. */
  async de(medico: string, agenda: AgendaDelDia): Promise<ImagenHorario | null> {
    if (!this.r2.habilitado) return null;
    try {
      const svg = svgDeAgendaMedico(medico, agenda);
      const huella = createHash('sha256').update(`${VERSION_DISENO_AGENDA_MEDICO}:${svg}`).digest('hex').slice(0, 24);
      const key = `asistente/agenda-medico/${huella}.png`;
      if (!(await this.r2.leer(key))) {
        const png = await this.motor.dibujar(svg);
        await this.r2.subir(key, png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer, 'image/png');
        this.logger.log(`Agenda de médico dibujada (${png.byteLength} bytes)`);
      }
      return { key, mime: 'image/png', nombre: `Agenda ${agenda.fecha}.png` };
    } catch (error: unknown) {
      this.logger.warn(`Imagen de la agenda: ${error instanceof Error ? error.message : 'falló'}`);
      return null;
    }
  }
}
