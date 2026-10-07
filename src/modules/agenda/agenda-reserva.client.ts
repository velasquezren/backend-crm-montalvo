import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CuentaEscritura, EscritorAgenda } from './agenda-escritor';

/**
 * Escritura en la agenda con el usuario `crm_agenda_reserva`, que SOLO puede
 * insertar en `para_agendar` y actualizar su comprobante, NIT, razón social y
 * estado (más leer lo imprescindible para comprobar la hora). Apagado salvo
 * `AGENDA_VPS_RESERVAS=on`.
 *
 * El candado (`GET_LOCK`) impide que dos pacientes que confirman la misma hora a
 * la vez se queden las dos con ella. ScriptCase no lo usa, así que contra
 * ScriptCase la defensa es volver a comprobar la hora y la PK de `para_age`.
 */
@Injectable()
export class AgendaReservaClient extends EscritorAgenda {
  constructor(config: ConfigService) {
    super(config);
  }

  protected readonly cuenta: CuentaEscritura = {
    usuarioEsperado: 'crm_agenda_reserva',
    variableUsuario: 'AGENDA_RESERVA_USUARIO',
    variablePassword: 'AGENDA_RESERVA_PASSWORD',
    bandera: 'AGENDA_VPS_RESERVAS',
    conexiones: 2,
    candado: 'crm_agenda_reserva',
    codigoNoDisponible: 'RESERVA_NO_DISPONIBLE',
    mensajeNoDisponible: 'No pudimos registrar la reserva. Volvé a intentarlo o escribinos por WhatsApp.',
  };
}
