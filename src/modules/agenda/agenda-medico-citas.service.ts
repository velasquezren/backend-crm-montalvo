import { BadRequestException, Injectable } from '@nestjs/common';

import { fechaCivilClinica, fechaCivilDesdeTexto, textoDeFechaCivil } from '../../common/fechas/zona-clinica';
import { AgendaConsultaClient } from './agenda-consulta.client';
import { AgendaDelDia, armarAgendaDelDia } from './agenda-medico-citas';
import { citasEntreFechasDelMedico, citasVigentesDelMedico, reservasSinCargarDelMedico } from './agenda-medico-citas.sql';

const DIA = 86_400_000;
/** Hacia atrás: «¿a quién vi ayer?». Hacia adelante: lo que la agenda ya tiene cargado. */
const DIAS_ATRAS = 31;
const DIAS_ADELANTE = 180;

/**
 * La agenda de un médico, con las citas reales de la clínica. Solo lee, con la
 * cuenta interna de consulta, y **no recibe un usuario**: quien llama ya decidió
 * de qué médico se trata. Hoy lo llama el asistente con el médico que salió del
 * número de WhatsApp autorizado (`AccesoMedicoAgendaService`); nunca con un id
 * que haya puesto el modelo o quien escribe.
 */
@Injectable()
export class AgendaMedicoCitasService {
  constructor(private readonly agenda: AgendaConsultaClient) {}

  /** ¿Está encendida la lectura interna de la agenda? Sin ella no hay nada que contestar. */
  disponible(): boolean {
    return this.agenda.habilitada();
  }

  async delDia(medicoId: number, fecha: string, ahora = new Date()): Promise<AgendaDelDia> {
    const dia = fechaCivilDesdeTexto(fecha);
    if (!dia) throw new BadRequestException('La fecha tiene que ser AAAA-MM-DD y existir.');
    const hoy = fechaCivilClinica(ahora).getTime();
    if (dia.getTime() < hoy - DIAS_ATRAS * DIA || dia.getTime() > hoy + DIAS_ADELANTE * DIA) {
      throw new BadRequestException(`Solo se consulta de ${DIAS_ATRAS} días atrás a ${DIAS_ADELANTE} días adelante.`);
    }
    const texto = textoDeFechaCivil(dia);
    const [agenda, reservas] = await this.agenda.ejecutar(async db => [
      await citasVigentesDelMedico(db, medicoId, texto),
      await reservasSinCargarDelMedico(db, medicoId, texto),
    ] as const);
    return armarAgendaDelDia(texto, agenda, reservas);
  }

  /** Cuántas citas y reservas tiene entre dos días (AAAA-MM-DD, incluidos): las que una ausencia deja por reprogramar. */
  citasEntre(medicoId: number, desde: string, hasta: string): Promise<{ citas: number; reservas: number }> {
    return this.agenda.ejecutar(db => citasEntreFechasDelMedico(db, medicoId, desde, hasta));
  }
}
