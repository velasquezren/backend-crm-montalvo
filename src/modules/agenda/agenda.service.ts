import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CacheMemoria } from '../../common/cache/cache-memoria';
import { calcularPaginacion, PaginationDto, RespuestaPaginada } from '../../common/dto/pagination.dto';
import { fechaCivilClinica, textoDeFechaCivil } from '../../common/fechas/zona-clinica';
import { AusenciaPublica, ausenciaDelDia, ausenciasEnRango, sumarDias } from '../directorio/ausencias';
import { DirectorioService } from '../directorio/directorio.service';
import { AgendaVpsClient } from './agenda-vps.client';
import { DiasAgenda, diasDeAgenda, DisponibilidadAgenda, disponibilidadDeAgenda, EspecialidadAgenda, especialidadDeAgenda, fechaConsultable, MedicoAgenda, medicoConEspecialidadDeAgenda, medicoDeAgenda, paginaAgenda, todosLosMedicosDeAgenda } from './agenda.contrato';
import { QueryDiasAgendaDto, QueryDisponibilidadAgendaDto, QueryMedicosAgendaDto } from './dto/query-agenda.dto';

/** Sin el id interno: lo que sale hacia la web, el Flow y el asistente. */
const publica = ({ desde, hasta, motivo }: AusenciaPublica): AusenciaPublica => ({ desde, hasta, motivo });

@Injectable()
export class AgendaService {
  private revisionCatalogo = 0;
  private readonly especialidadesCache = new CacheMemoria<RespuestaPaginada<EspecialidadAgenda>>({ ttlMs: 30_000, maxEntradas: 30 });
  private readonly medicosCache = new CacheMemoria<RespuestaPaginada<MedicoAgenda>>({ ttlMs: 30_000, maxEntradas: 100 });
  private readonly medicoCache = new CacheMemoria<{ medico: MedicoAgenda; especialidad: EspecialidadAgenda } | null>({ ttlMs: 30_000, maxEntradas: 200 });
  private readonly todosCache = new CacheMemoria<{ medico: MedicoAgenda; especialidad: EspecialidadAgenda }[]>({ ttlMs: 60_000, maxEntradas: 1 });
  constructor(
    private readonly vps: AgendaVpsClient,
    private readonly directorio: DirectorioService,
  ) {}

  /** La generación separa las lecturas anteriores que todavía estén en vuelo. */
  invalidarCatalogo(): void {
    this.revisionCatalogo++;
    this.especialidadesCache.invalidar(); this.medicosCache.invalidar(); this.medicoCache.invalidar(); this.todosCache.invalidar();
  }

  private parametros(query: PaginationDto): URLSearchParams {
    const { take } = calcularPaginacion(query);
    return new URLSearchParams({ pagina: String(query.pagina ?? 1), limite: String(take) });
  }

  especialidades(query: PaginationDto) {
    if (!this.vps.habilitada()) throw this.vps.noDisponible();
    const parametros = this.parametros(query);
    return this.especialidadesCache.resolver(`${this.revisionCatalogo}:${parametros}`, async () => {
      const crudo = await this.vps.leer('especialidades', parametros);
      try { return paginaAgenda(crudo, query.pagina ?? 1, calcularPaginacion(query).take, especialidadDeAgenda); }
      catch { throw this.vps.noDisponible(); }
    });
  }

  medicos(query: QueryMedicosAgendaDto) {
    if (!this.vps.habilitada()) throw this.vps.noDisponible();
    const parametros = this.parametros(query);
    parametros.set('especialidadId', query.especialidadId);
    return this.medicosCache.resolver(`${this.revisionCatalogo}:${parametros}`, async () => {
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
   * Todos los médicos activos con su especialidad, en UNA lectura de la agenda
   * (el asistente busca por nombre aquí). Sin fotos: quien busca solo necesita
   * nombre, especialidad, precio y horario.
   */
  todosLosMedicos() {
    if (!this.vps.habilitada()) throw this.vps.noDisponible();
    return this.todosCache.resolver(`${this.revisionCatalogo}:todos`, async () => {
      const crudo = await this.vps.leer('todos', new URLSearchParams());
      try { return todosLosMedicosDeAgenda(crudo); }
      catch { throw this.vps.noDisponible(); }
    });
  }

  /**
   * Un médico con su especialidad: con él la web abre la reserva ya elegida
   * (el «Reservar» de su ficha). 404 si no existe, está inactivo o sin especialidad.
   */
  async medico(medicoId: number) {
    if (!this.vps.habilitada()) throw this.vps.noDisponible();
    const r = await this.medicoCache.resolver(`${this.revisionCatalogo}:${medicoId}`, async () => {
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

  /**
   * Las horas libres de un día. Si ese día el médico está de vacaciones (o en
   * un congreso) no se ofrece ninguna, aunque la agenda las tenga libres: la
   * agenda de ScriptCase no sabe de ausencias, las guarda el CRM.
   */
  async disponibilidad(query: QueryDisponibilidadAgendaDto): Promise<DisponibilidadAgenda> {
    if (!fechaConsultable(query.fecha)) throw new BadRequestException('Elige una fecha válida dentro de los próximos 30 días, incluido hoy.');
    const crudo = await this.vps.leer('disponibilidad', new URLSearchParams({ medicoId: query.medicoId, fecha: query.fecha }));
    let r: DisponibilidadAgenda;
    try { r = disponibilidadDeAgenda(crudo, query.medicoId, query.fecha); }
    catch { throw this.vps.noDisponible(); }
    const [ausencia] = ausenciasEnRango(await this.ausenciasDe(query.medicoId), query.fecha, query.fecha);
    return ausencia ? { ...r, estado: 'SIN_ATENCION', horarios: [], ausencia } : r;
  }

  /** Días con horas libres en los próximos 30, sin los de ausencia: la web solo ofrece esos. Sin caché, como la disponibilidad. */
  async dias(query: QueryDiasAgendaDto): Promise<DiasAgenda> {
    const crudo = await this.vps.leer('dias', new URLSearchParams({ medicoId: query.medicoId }));
    let r: DiasAgenda;
    try { r = diasDeAgenda(crudo, query.medicoId); }
    catch { throw this.vps.noDisponible(); }
    const todas = await this.ausenciasDe(query.medicoId);
    if (todas.length === 0) return r;
    // Los 30 días que ofrece la agenda: hoy y los 29 siguientes (`fechaConsultable`).
    const hoy = textoDeFechaCivil(fechaCivilClinica(new Date()));
    const ausencias = ausenciasEnRango(todas, hoy, sumarDias(hoy, 29));
    return { ...r, fechas: r.fechas.filter(f => !ausenciaDelDia(todas, f)), ...(ausencias.length ? { ausencias } : {}) };
  }

  /**
   * Las ausencias que todavía no terminaron de cada médico (por su id de la
   * agenda), para decírselas a la paciente. Un médico sin ausencias no está.
   */
  async ausenciasProximas(medicoIds: readonly string[]): Promise<Map<string, (AusenciaPublica & { vuelve: string })[]>> {
    const ids = medicoIds.filter(id => /^\d{1,10}$/.test(id)).map(Number);
    const porMedico = await this.directorio.ausenciasDeAgenda(ids);
    const hoy = textoDeFechaCivil(fechaCivilClinica(new Date()));
    return new Map([...porMedico].map(([id, lista]) => [String(id), ausenciasEnRango(lista.map(publica), hoy, '9999-12-31')]));
  }

  /** La ausencia que cubre ese día, si hay: la reserva no se registra en un día así. */
  async ausenciaEnFecha(medicoId: string, fecha: string): Promise<AusenciaPublica | null> {
    return ausenciaDelDia(await this.ausenciasDe(medicoId), fecha);
  }

  private async ausenciasDe(medicoId: string): Promise<AusenciaPublica[]> {
    if (!/^\d{1,10}$/.test(medicoId)) return [];
    return ((await this.directorio.ausenciasDeAgenda([Number(medicoId)])).get(Number(medicoId)) ?? []).map(publica);
  }
}
