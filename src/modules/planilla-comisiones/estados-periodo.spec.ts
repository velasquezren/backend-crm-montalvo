import { EstadoPeriodo } from '@prisma/client';

import {
  bloqueosParaRevision,
  calcularEstadoRevision,
  esEditable,
  transicionPermitida,
} from './estados-periodo';

const SIN_ALERTAS = {
  filasSinClasificar: 0,
  vendedorasSinConfigurar: 0,
  filasSinVendedora: 0,
  vendedorasLiquidadas: 3,
};

describe('transicionPermitida', () => {
  it('deja avanzar por el camino normal', () => {
    expect(transicionPermitida(EstadoPeriodo.BORRADOR, EstadoPeriodo.CALCULADO)).toBe(true);
    expect(transicionPermitida(EstadoPeriodo.CALCULADO, EstadoPeriodo.EN_REVISION)).toBe(true);
    expect(transicionPermitida(EstadoPeriodo.EN_REVISION, EstadoPeriodo.CERRADO)).toBe(true);
    expect(transicionPermitida(EstadoPeriodo.CERRADO, EstadoPeriodo.PAGADO)).toBe(true);
  });

  it('deja volver atrás por rechazo y por reapertura', () => {
    expect(transicionPermitida(EstadoPeriodo.EN_REVISION, EstadoPeriodo.CALCULADO)).toBe(true);
    expect(transicionPermitida(EstadoPeriodo.CERRADO, EstadoPeriodo.CALCULADO)).toBe(true);
  });

  /* El salto que era legal antes de que existiera esta tabla, y el que motivó
     todo: reabrir de golpe un mes cerrado hasta dejarlo reimportable. */
  it('NO deja saltar de CERRADO a BORRADOR', () => {
    expect(transicionPermitida(EstadoPeriodo.CERRADO, EstadoPeriodo.BORRADOR)).toBe(false);
  });

  it('NO deja saltarse la revisión', () => {
    expect(transicionPermitida(EstadoPeriodo.CALCULADO, EstadoPeriodo.CERRADO)).toBe(false);
    expect(transicionPermitida(EstadoPeriodo.CALCULADO, EstadoPeriodo.PAGADO)).toBe(false);
  });

  /* Una planilla pagada no se reescribe: se corrige con un ajuste del mes
     siguiente. Si esto deja de ser cierto, el historial deja de ser citable. */
  it('PAGADO es terminal, no vuelve a ningún estado', () => {
    for (const estado of Object.values(EstadoPeriodo)) {
      expect(transicionPermitida(EstadoPeriodo.PAGADO, estado)).toBe(false);
    }
  });
});

describe('esEditable', () => {
  it('solo BORRADOR y CALCULADO admiten cambios', () => {
    expect(esEditable(EstadoPeriodo.BORRADOR)).toBe(true);
    expect(esEditable(EstadoPeriodo.CALCULADO)).toBe(true);
  });

  /* El estado nuevo. Sin esta línea, las cinco guardas que antes comparaban con
     CERRADO habrían dejado editar un mes que se está revisando. */
  it('EN_REVISION ya no se toca', () => {
    expect(esEditable(EstadoPeriodo.EN_REVISION)).toBe(false);
  });

  it('CERRADO y PAGADO tampoco', () => {
    expect(esEditable(EstadoPeriodo.CERRADO)).toBe(false);
    expect(esEditable(EstadoPeriodo.PAGADO)).toBe(false);
  });
});

describe('bloqueosParaRevision', () => {
  it('sin pendientes, deja pasar', () => {
    expect(bloqueosParaRevision(SIN_ALERTAS)).toEqual([]);
  });

  it('una venta sin clasificar bloquea: no se sabe con qué tarifa paga', () => {
    const bloqueos = bloqueosParaRevision({ ...SIN_ALERTAS, filasSinClasificar: 12 });

    expect(bloqueos).toHaveLength(1);
    expect(bloqueos[0].clave).toBe('FILAS_SIN_CLASIFICAR');
    expect(bloqueos[0].detalle).toContain('12');
  });

  /* Es el caso real de diciembre: alguien vendió $16.189 y no se le liquidó
     nada porque nadie le puso tipo ni área. Revisar el mes sin resolverlo es
     firmar que esa persona cobra cero. */
  it('una vendedora con ventas y sin configurar bloquea', () => {
    const bloqueos = bloqueosParaRevision({ ...SIN_ALERTAS, vendedorasSinConfigurar: 1 });

    expect(bloqueos.map(b => b.clave)).toEqual(['VENDEDORAS_SIN_CONFIGURAR']);
  });

  it('una venta sin dueña bloquea: su comisión no es de nadie', () => {
    const bloqueos = bloqueosParaRevision({ ...SIN_ALERTAS, filasSinVendedora: 3 });

    expect(bloqueos.map(b => b.clave)).toEqual(['FILAS_SIN_VENDEDORA']);
  });

  it('un mes sin liquidar no se puede mandar a revisar', () => {
    const bloqueos = bloqueosParaRevision({ ...SIN_ALERTAS, vendedorasLiquidadas: 0 });

    expect(bloqueos.map(b => b.clave)).toEqual(['SIN_LIQUIDAR']);
  });

  it('los enumera todos, no solo el primero', () => {
    const bloqueos = bloqueosParaRevision({
      filasSinClasificar: 4,
      vendedorasSinConfigurar: 1,
      filasSinVendedora: 2,
      vendedorasLiquidadas: 3,
    });

    expect(bloqueos).toHaveLength(3);
  });
});

describe('calcularEstadoRevision', () => {
  const ana = { id: 'u1', nombre: 'Ana' };
  const rene = { id: 'u2', nombre: 'René' };
  const aprobacion = (usuarioId: string) => ({
    usuarioId,
    comentario: null,
    createdAt: new Date('2026-08-28'),
  });

  it('con un solo SUPER_ADMIN, su firma cierra el mes', () => {
    const r = calcularEstadoRevision([rene], [aprobacion('u2')]);

    expect(r.completa).toBe(true);
    expect(r.faltan).toEqual([]);
  });

  it('con dos, una sola firma no alcanza y dice quién falta', () => {
    const r = calcularEstadoRevision([ana, rene], [aprobacion('u2')]);

    expect(r.completa).toBe(false);
    expect(r.faltan.map(f => f.nombre)).toEqual(['Ana']);
    expect(r.aprobaron.map(a => a.nombre)).toEqual(['René']);
  });

  /* El caso que pidió el usuario: un SUPER_ADMIN puede bajar a ADMIN.
     Congelar la lista de aprobadores al abrir la revisión dejaría el mes
     esperando para siempre una firma que ya nadie puede dar, y habría que
     destrabarlo por SQL. */
  it('quien baja a ADMIN deja de bloquear el cierre', () => {
    const conAmbas = calcularEstadoRevision([ana, rene], [aprobacion('u2')]);
    expect(conAmbas.completa).toBe(false);

    // Ana pierde el rol: ya no está en la lista de SUPER_ADMIN activos.
    const soloRene = calcularEstadoRevision([rene], [aprobacion('u2')]);
    expect(soloRene.completa).toBe(true);
  });

  /* Y al revés: su aprobación tampoco se hereda. Si Ana ya había firmado y
     luego baja a ADMIN, su firma deja de contar — pero como también sale del
     conjunto exigido, el resultado no cambia por su culpa. */
  it('la firma de quien ya no es SUPER_ADMIN no se cuenta', () => {
    const r = calcularEstadoRevision([rene], [aprobacion('u1'), aprobacion('u2')]);

    expect(r.aprobaron.map(a => a.nombre)).toEqual(['René']);
    expect(r.completa).toBe(true);
  });

  /* Un SUPER_ADMIN nuevo a mitad de revisión devuelve el mes a pendiente: no ha
     visto estas cifras, así que no puede estar firmándolas por omisión. */
  it('un SUPER_ADMIN nuevo vuelve a dejar el mes pendiente', () => {
    const antes = calcularEstadoRevision([rene], [aprobacion('u2')]);
    expect(antes.completa).toBe(true);

    const despues = calcularEstadoRevision([rene, ana], [aprobacion('u2')]);
    expect(despues.completa).toBe(false);
    expect(despues.faltan.map(f => f.nombre)).toEqual(['Ana']);
  });

  /*
   * El agujero que hay que blindar: "todos aprobaron" sobre un conjunto vacío
   * es verdadero. Sin el `aprobaron.length > 0`, el día que la clínica se
   * quedara sin ningún SUPER_ADMIN activo el mes se cerraría solo, sin una sola
   * firma, y la pantalla lo mostraría como aprobado.
   */
  it('sin ningún SUPER_ADMIN activo NO se da por aprobado', () => {
    const r = calcularEstadoRevision([], []);

    expect(r.completa).toBe(false);
    expect(r.aprobaron).toEqual([]);
  });

  it('sin ninguna firma tampoco, aunque haya aprobadores', () => {
    const r = calcularEstadoRevision([ana, rene], []);

    expect(r.completa).toBe(false);
    expect(r.faltan).toHaveLength(2);
  });
});
