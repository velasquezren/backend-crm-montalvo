import { BadRequestException, Injectable } from '@nestjs/common';
import { CacheMemoria } from '../../common/cache/cache-memoria';
import { calcularPaginacion, PaginationDto, RespuestaPaginada } from '../../common/dto/pagination.dto';
import { AgendaVpsClient } from './agenda-vps.client';
import { disponibilidadDeAgenda, EspecialidadAgenda, especialidadDeAgenda, fechaConsultable, MedicoAgenda, medicoDeAgenda, paginaAgenda } from './agenda.contrato';
import { QueryDisponibilidadAgendaDto, QueryMedicosAgendaDto } from './dto/query-agenda.dto';

@Injectable()
export class AgendaService {
  private readonly especialidadesCache = new CacheMemoria<RespuestaPaginada<EspecialidadAgenda>>({ ttlMs: 30_000, maxEntradas: 30 });
  private readonly medicosCache = new CacheMemoria<RespuestaPaginada<MedicoAgenda>>({ ttlMs: 30_000, maxEntradas: 100 });
  constructor(private readonly vps: AgendaVpsClient) {}

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
      try {
        const pagina = paginaAgenda(crudo, query.pagina ?? 1, calcularPaginacion(query).take, medicoDeAgenda);
        if (pagina.datos.some(m => m.especialidadId !== query.especialidadId)) throw new Error('Especialidad diferente');
        return pagina;
      } catch { throw this.vps.noDisponible(); }
    });
  }

  async disponibilidad(query: QueryDisponibilidadAgendaDto) {
    if (!fechaConsultable(query.fecha)) throw new BadRequestException('Elegí una fecha válida dentro de los próximos 30 días, incluido hoy.');
    const crudo = await this.vps.leer('disponibilidad', new URLSearchParams({ medicoId: query.medicoId, fecha: query.fecha }));
    try { return disponibilidadDeAgenda(crudo, query.medicoId, query.fecha); }
    catch { throw this.vps.noDisponible(); }
  }
}
