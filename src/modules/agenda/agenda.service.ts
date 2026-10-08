import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CacheMemoria } from '../../common/cache/cache-memoria';
import { calcularPaginacion, PaginationDto, RespuestaPaginada } from '../../common/dto/pagination.dto';
import { DirectorioService } from '../directorio/directorio.service';
import { AgendaVpsClient } from './agenda-vps.client';
import { diasDeAgenda, disponibilidadDeAgenda, EspecialidadAgenda, especialidadDeAgenda, fechaConsultable, MedicoAgenda, medicoConEspecialidadDeAgenda, medicoDeAgenda, paginaAgenda } from './agenda.contrato';
import { QueryDiasAgendaDto, QueryDisponibilidadAgendaDto, QueryMedicosAgendaDto } from './dto/query-agenda.dto';

@Injectable()
export class AgendaService {
  private readonly especialidadesCache = new CacheMemoria<RespuestaPaginada<EspecialidadAgenda>>({ ttlMs: 30_000, maxEntradas: 30 });
  private readonly medicosCache = new CacheMemoria<RespuestaPaginada<MedicoAgenda>>({ ttlMs: 30_000, maxEntradas: 100 });
  private readonly medicoCache = new CacheMemoria<{ medico: MedicoAgenda; especialidad: EspecialidadAgenda } | null>({ ttlMs: 30_000, maxEntradas: 200 });
  constructor(
    private readonly vps: AgendaVpsClient,
    private readonly directorio: DirectorioService,
  ) {}

  private parametros(query: PaginationDto): URLSearchParams {
    const { take } = calcularPaginacion(query);
    return new URLSearchParams({ pagina: String(query.pagina ?? 1), limite: String(take) });
  }

  especialidades(query: PaginationDto) {
    if (!this.vps.habilitada()) throw this.vps.noDisponible();
    const parametros = this.parametros(query);
    return this.especialidadesCache.resolver(parametros.toString(), async () => {
      const crudo = await this.vps.leer('especialidades', parametros);
      try { return paginaAgenda(crudo, query.pagina ?? 1, calcularPaginacion(query).take, especialidadDeAgenda); }
      catch { throw this.vps.noDisponible(); }
    });
  }

  medicos(query: QueryMedicosAgendaDto) {
    if (!this.vps.habilitada()) throw this.vps.noDisponible();
    const parametros = this.parametros(query);
    parametros.set('especialidadId', query.especialidadId);
    return this.medicosCache.resolver(parametros.toString(), async () => {
      const crudo = await this.vps.leer('medicos', parametros);
      let pagina: RespuestaPaginada<MedicoAgenda>;
      try {
        pagina = paginaAgenda(crudo, query.pagina ?? 1, calcularPaginacion(query).take, medicoDeAgenda);
        if (pagina.datos.some(m => m.especialidadId !== query.especialidadId)) throw new Error('Especialidad diferente');
      } catch { throw this.vps.noDisponible(); }
      return { ...pagina, datos: await this.conFotosDelDirectorio(pagina.datos) };
    });
  }

  /**
   * Un médico con su especialidad: con él la web abre la reserva ya elegida
   * (el «Reservar» de su ficha). 404 si no existe, está inactivo o sin especialidad.
   */
  async medico(medicoId: number) {
    if (!this.vps.habilitada()) throw this.vps.noDisponible();
    const r = await this.medicoCache.resolver(String(medicoId), async () => {
      const crudo = await this.vps.leer('medico', new URLSearchParams({ medicoId: String(medicoId) }));
      let leido: { medico: MedicoAgenda; especialidad: EspecialidadAgenda } | null;
      try { leido = medicoConEspecialidadDeAgenda(crudo); }
      catch { throw this.vps.noDisponible(); }
      if (!leido) return null;
      const [medico] = await this.conFotosDelDirectorio([leido.medico]);
      return { ...leido, medico };
    });
    if (!r) throw new NotFoundException({ codigo: 'MEDICO_NO_DISPONIBLE', message: 'Ese profesional no está disponible en línea.' });
    return r;
  }

  /**
   * La foto de la ficha web PUBLICADA, si el médico tiene, gana a la de
   * ScriptCase: es la que la clínica cuida desde el CRM. Si el directorio no
   * responde, la reserva sigue con la de ScriptCase.
   */
  private async conFotosDelDirectorio(medicos: MedicoAgenda[]): Promise<MedicoAgenda[]> {
    const fotos = await this.directorio.fotosPublicasDeAgenda(medicos.map(m => Number(m.id))).catch(() => new Map<number, string>());
    return fotos.size === 0 ? medicos : medicos.map(m => ({ ...m, fotoUrl: fotos.get(Number(m.id)) ?? m.fotoUrl }));
  }

  async disponibilidad(query: QueryDisponibilidadAgendaDto) {
    if (!fechaConsultable(query.fecha)) throw new BadRequestException('Elige una fecha válida dentro de los próximos 30 días, incluido hoy.');
    const crudo = await this.vps.leer('disponibilidad', new URLSearchParams({ medicoId: query.medicoId, fecha: query.fecha }));
    try { return disponibilidadDeAgenda(crudo, query.medicoId, query.fecha); }
    catch { throw this.vps.noDisponible(); }
  }

  /** Días con horas libres en los próximos 30: la web solo ofrece esos. Sin caché, como la disponibilidad. */
  async dias(query: QueryDiasAgendaDto) {
    const crudo = await this.vps.leer('dias', new URLSearchParams({ medicoId: query.medicoId }));
    try { return diasDeAgenda(crudo, query.medicoId); }
    catch { throw this.vps.noDisponible(); }
  }
}
