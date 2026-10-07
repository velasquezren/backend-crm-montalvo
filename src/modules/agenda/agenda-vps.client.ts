import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CuentaLectura, LectorAgenda } from './agenda-lector';
import { consultarAgendaSql, RecursoAgendaSql } from './agenda.sql';

/** La lectura PÚBLICA (landing): catálogo, horas libres y fotos. Sin datos de pacientes. */
@Injectable()
export class AgendaVpsClient extends LectorAgenda {
  /* Constructor explícito: Nest inyecta por los tipos del constructor de ESTA
     clase; heredado de `LectorAgenda` (sin decorador) quedaba sin ConfigService. */
  constructor(config: ConfigService) {
    super(config);
  }

  protected readonly cuenta: CuentaLectura = {
    usuarioEsperado: 'crm_agenda_lectura',
    variableUsuario: 'AGENDA_MYSQL_USUARIO',
    variablePassword: 'AGENDA_MYSQL_PASSWORD',
    bandera: 'AGENDA_VPS_LECTURA',
    /* Una menos que su MAX_USER_CONNECTIONS (4), por la misma razón que la de administración; los picos esperan en fila. */
    conexiones: 3,
    mensajeNoDisponible: 'No pudimos consultar la agenda. Vuelve a intentarlo en un momento o escríbenos por WhatsApp.',
  };

  leer(recurso: RecursoAgendaSql, parametros: URLSearchParams): Promise<unknown> {
    return this.ejecutar(conexion => consultarAgendaSql(conexion, recurso, parametros));
  }
}
