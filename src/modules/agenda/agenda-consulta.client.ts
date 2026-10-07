import { Injectable } from '@nestjs/common';
import { CuentaLectura, LectorAgenda } from './agenda-lector';

/**
 * La lectura INTERNA del CRM: las reservas con los datos de la paciente y su
 * comprobante. Usuario `crm_agenda_consulta`, solo SELECT; solo la usan rutas
 * con sesión. Apagada salvo `AGENDA_VPS_CONSULTA=on`.
 */
@Injectable()
export class AgendaConsultaClient extends LectorAgenda {
  protected readonly cuenta: CuentaLectura = {
    usuarioEsperado: 'crm_agenda_consulta',
    variableUsuario: 'AGENDA_CONSULTA_USUARIO',
    variablePassword: 'AGENDA_CONSULTA_PASSWORD',
    bandera: 'AGENDA_VPS_CONSULTA',
    conexiones: 3,
    mensajeNoDisponible: 'No pudimos consultar la agenda de la clínica. Probá de nuevo en un momento.',
  };
}
