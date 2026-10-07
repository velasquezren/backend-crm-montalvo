import { Injectable } from '@nestjs/common';
import { CuentaLectura, LectorAgenda } from './agenda-lector';
import { consultarAgendaSql, RecursoAgendaSql } from './agenda.sql';

/** La lectura PÚBLICA (landing): catálogo, horas libres y fotos. Sin datos de pacientes. */
@Injectable()
export class AgendaVpsClient extends LectorAgenda {
  protected readonly cuenta: CuentaLectura = {
    usuarioEsperado: 'crm_agenda_lectura',
    variableUsuario: 'AGENDA_MYSQL_USUARIO',
    variablePassword: 'AGENDA_MYSQL_PASSWORD',
    bandera: 'AGENDA_VPS_LECTURA',
    conexiones: 4,
    mensajeNoDisponible: 'No pudimos consultar la agenda. Podés continuar en la agenda de la clínica o contactar con recepción.',
  };

  leer(recurso: RecursoAgendaSql, parametros: URLSearchParams): Promise<unknown> {
    return this.ejecutar(conexion => consultarAgendaSql(conexion, recurso, parametros));
  }
}
