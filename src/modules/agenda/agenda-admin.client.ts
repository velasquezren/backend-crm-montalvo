import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CuentaEscritura, EscritorAgenda } from './agenda-escritor';

/**
 * Administración de médicos y horarios de la agenda desde el CRM, con el usuario
 * `crm_agenda_admin`: lee médicos, horarios y bancos, y SOLO actualiza las
 * columnas que el CRM edita (nunca el código de FileMaker de un médico ya
 * creado, ni su usuario de acceso), da de alta médicos y casillas de horario y
 * cambia el estado de una casilla. No borra nada. Apagado salvo `AGENDA_VPS_ADMIN=on`.
 *
 * Decisión del propietario (7/10/2026): los médicos y horarios se editan solo
 * desde el CRM; el panel de ScriptCase queda como respaldo.
 */
@Injectable()
export class AgendaAdminClient extends EscritorAgenda {
  constructor(config: ConfigService) {
    super(config);
  }

  protected readonly cuenta: CuentaEscritura = {
    usuarioEsperado: 'crm_agenda_admin',
    variableUsuario: 'AGENDA_ADMIN_USUARIO',
    variablePassword: 'AGENDA_ADMIN_PASSWORD',
    bandera: 'AGENDA_VPS_ADMIN',
    /* Una menos que su MAX_USER_CONNECTIONS (3): MySQL tarda un instante en soltar una
       conexión destruida, y abrir otra en ese momento rebota. Los picos esperan en `CuposAgenda`. */
    conexiones: 2,
    candado: 'crm_agenda_admin',
    codigoNoDisponible: 'AGENDA_NO_DISPONIBLE',
    mensajeNoDisponible: 'La agenda de la clínica no respondió. Vuelve a intentarlo en un momento.',
  };
}
