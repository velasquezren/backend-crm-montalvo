import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';

import { armarAgendaDelDia } from '../agenda/agenda-medico-citas';
import { AgendaService } from '../agenda/agenda.service';
import {
  ContextoAsistente,
  declaraciones,
  HERRAMIENTAS,
  herramientasDisponibles,
  HerramientasAsistenteService,
  palabrasDeNombre,
  sonidoDe,
  PromocionParaAsistente,
  PuertoMedico,
  PuertoReservas,
  PuertoVentas,
  validarArgumentos,
} from './herramientas';

/*
 * El catálogo se prueba SIN modelo, que es la mitad del punto de tenerlo: si un
 * día cambia el proveedor, estas pruebas siguen valiendo igual.
 *
 * Lo que se fija aquí no es que las herramientas «funcionen» —eso ya lo
 * prueban las suites de la agenda— sino las tres cosas que el modelo puede
 * romper: pedir algo que no existe, mandar argumentos malos, y pedir una
 * escritura.
 */
const PROMO: PromocionParaAsistente = {
  id: 'p1', titulo: 'Botox tercio superior', resumen: 'Frente y entrecejo', condiciones: 'Una zona por persona.',
  etiquetaOferta: '-20%', precio: 1200, precioRegular: 1500, precioPromocional: 1200, vigenteHasta: '2026-10-31', servicios: [],
};

/** «Octubre Rosa»: varios servicios, cada uno con su precio; la promoción sin precio propio. */
const ROSA: PromocionParaAsistente = {
  id: 'p2', titulo: 'Octubre Rosa', resumen: 'Cinco servicios de ginecología con precio especial.', condiciones: 'Hasta el 31/10.',
  etiquetaOferta: null, precio: null, precioRegular: null, precioPromocional: null, vigenteHasta: '2026-10-31',
  servicios: [
    { id: 's1', nombre: 'Ecografía Mamaria', precioRegular: 446, precioPromocional: 268 },
    { id: 's2', nombre: 'Consulta Ginecológica', precioRegular: 250, precioPromocional: 175 },
  ],
};

function ventas(p: Partial<PuertoVentas> = {}): PuertoVentas {
  return {
    promociones: jest.fn().mockResolvedValue([PROMO]),
    promocion: jest.fn().mockResolvedValue({ ...PROMO, sePuedePagarPorChat: true, sePuedeEnviarTarjeta: true }),
    estadoDePago: jest.fn().mockResolvedValue({ qrDisponible: true, pago: null }),
    ...p,
  };
}

const CONTEXTO: ContextoAsistente = { telefono: '+59170012345', ventas: null };

function montar(agenda: Partial<AgendaService> = {}) {
  return new HerramientasAsistenteService(agenda as AgendaService);
}

describe('catálogo de herramientas del asistente', () => {
  it('una consulta de precio permite leer datos pero no enviar cobros aunque el modelo lo intente', async () => {
    const puerto = ventas();
    const contexto: ContextoAsistente = { ...CONTEXTO, ventas: puerto, solicitud: 'CONSULTAR' };
    const declaradas = herramientasDisponibles(contexto, { permitirEscritura: false }).map(h => h.nombre);
    expect(declaradas).toContain('ver_promocion');
    expect(declaradas).not.toContain('enviar_promocion');
    expect(declaradas).not.toContain('enviar_horario');
    expect(await montar().ejecutar('enviar_promocion', { promocionId: 'p1' }, contexto, { permitirEscritura: false })).toMatchObject({ ok: false });
    expect(puerto.promocion).not.toHaveBeenCalled();
  });

  it('ACLARAR solo permite pasar a una persona; no catálogos ni agenda', async () => {
    const contexto: ContextoAsistente = { ...CONTEXTO, ventas: ventas(), solicitud: 'ACLARAR', informes: true };
    expect(herramientasDisponibles(contexto, { permitirEscritura: false }).map(h => h.nombre)).toEqual(['pasar_a_persona']);
    expect(await montar().ejecutar('horas_libres', { medicoId: '7', fecha: '2026-10-14' }, contexto, { permitirEscritura: false })).toMatchObject({ ok: false });
  });

  it.each(['SALUDAR', 'CERRAR'] as const)('%s no declara ninguna herramienta: un saludo o un adiós se contestan con texto, sin derivar', async solicitud => {
    const contexto: ContextoAsistente = { ...CONTEXTO, ventas: ventas(), solicitud, informes: true };
    expect(herramientasDisponibles(contexto, { permitirEscritura: false })).toEqual([]);
    expect(await montar().ejecutar('pasar_a_persona', { motivo: 'OTRO', resumen: 'Saluda.' }, contexto, { permitirEscritura: false })).toMatchObject({ ok: false });
  });

  it('una petición de pago sí habilita la tarjeta y nunca habilita reservar', () => {
    const declaradas = herramientasDisponibles({ ...CONTEXTO, ventas: ventas(), solicitud: 'PAGAR' }, { permitirEscritura: false }).map(h => h.nombre);
    expect(declaradas).toContain('enviar_promocion');
    expect(declaradas).not.toContain('reservar');
  });
  it('cada declaración lleva nombre, descripción y esquema, y los requeridos existen como propiedades', () => {
    expect(HERRAMIENTAS.length).toBeGreaterThan(0);
    for (const h of HERRAMIENTAS) {
      expect(h.nombre).toMatch(/^[a-z_]+$/);
      /* La descripción la LEE el modelo para decidir: una vacía o de tres
         palabras es la causa más común de que elija mal. */
      expect(h.descripcion.length).toBeGreaterThan(40);
      for (const clave of h.parametros.required) {
        expect(Object.keys(h.parametros.properties)).toContain(clave);
      }
    }
  });

  it('los nombres no se repiten: el despacho es por nombre', () => {
    const nombres = HERRAMIENTAS.map(h => h.nombre);
    expect(new Set(nombres).size).toBe(nombres.length);
  });

  it('`telefono` NO es un parámetro de ninguna herramienta', () => {
    /* El teléfono es el de la conversación. Si alguna vez entra como parámetro,
       el modelo podría reservar a nombre de otro número. */
    for (const h of HERRAMIENTAS) {
      expect(Object.keys(h.parametros.properties)).not.toContain('telefono');
    }
  });

  it('las declaraciones salen con la forma que pide `tools: [{ functionDeclarations }]`', () => {
    const d = declaraciones();
    expect(d).toHaveLength(HERRAMIENTAS.length);
    expect(d[0]).toEqual({
      name: HERRAMIENTAS[0].nombre,
      description: HERRAMIENTAS[0].descripcion,
      parametersJsonSchema: HERRAMIENTAS[0].parametros,
    });
  });
});

describe('validación de lo que manda el modelo', () => {
  const reservar = HERRAMIENTAS.find(h => h.nombre === 'reservar')!;

  it('un requerido ausente, vacío o que no es texto se rechaza diciendo cuál', () => {
    for (const args of [{}, { medicoId: '  ' }, { medicoId: 7 }]) {
      const r = validarArgumentos(reservar, args as Record<string, unknown>);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.motivo).toContain('medicoId');
    }
  });

  it('una fecha con otro formato se rechaza diciendo cómo tiene que venir', () => {
    const r = validarArgumentos(reservar, { medicoId: '1', fecha: '12/10/2026', hora: '10:00', nombre: 'Ana Pérez', ci: '123456' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain('AAAA-MM-DD');
  });

  it('una hora imposible se rechaza', () => {
    for (const hora of ['25:00', '10:60', '10', '1:00']) {
      const r = validarArgumentos(reservar, { medicoId: '1', fecha: '2026-10-12', hora, nombre: 'Ana Pérez', ci: '123456' });
      expect(r.ok).toBe(false);
    }
  });

  it('los valores buenos pasan recortados', () => {
    const r = validarArgumentos(reservar, { medicoId: ' 1 ', fecha: '2026-10-12', hora: '10:30', nombre: ' Ana Pérez ', ci: '123456' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.valores).toMatchObject({ medicoId: '1', nombre: 'Ana Pérez', hora: '10:30' });
  });
});

describe('el despachador', () => {
  it('una herramienta inexistente se rechaza con su nombre, no revienta', async () => {
    const r = await montar().ejecutar('borrar_todo', {}, CONTEXTO, { permitirEscritura: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain('borrar_todo');
  });

  it('una lectura llama al servicio de la agenda', async () => {
    const especialidades = jest.fn().mockResolvedValue({ datos: [] });
    const r = await montar({ especialidades }).ejecutar('listar_especialidades', {}, CONTEXTO, { permitirEscritura: false });
    expect(r.ok).toBe(true);
    expect(especialidades).toHaveBeenCalledTimes(1);
  });

  /* La regla central: el modelo puede PEDIR una escritura y no se hace. */
  it('sin permiso, `reservar` ni siquiera mira la agenda y lo dice en castellano', async () => {
    const disponibilidad = jest.fn();
    const r = await montar({ disponibilidad }).ejecutar(
      'reservar',
      { medicoId: '1', fecha: '2026-10-12', hora: '10:30', nombre: 'Ana Pérez', ci: '123456' },
      { ...CONTEXTO, reservas: reservas() },
      { permitirEscritura: false },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain('una persona');
    expect(disponibilidad).not.toHaveBeenCalled();
  });

  it('una escritura con argumentos malos se rechaza por el permiso ANTES de validar', async () => {
    /* El orden importa: si validara primero, el mensaje de vuelta le diría al
       modelo qué corregir para una herramienta que de todas formas no puede usar. */
    const r = await montar().ejecutar('reservar', {}, CONTEXTO, { permitirEscritura: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).not.toContain('Falta');
  });
});

/* ── Reservar (15/10): el modelo propone, el código comprueba, el CRM registra ── */

function reservas(p: Partial<PuertoReservas> = {}): PuertoReservas {
  return { textoDeLaPaciente: 'Quiero agendar\nLunes 19\nreservar a las 12\nrene velasquez\n11340617\n73605150', reservaPendiente: jest.fn().mockResolvedValue(null), ...p };
}
const PEDIDO = { medicoId: '57', fecha: '2026-10-19', hora: '12:00', nombre: 'René Velásquez', ci: '11340617' };
function agendaConLibres(horas: string[]) {
  return {
    disponibilidad: jest.fn().mockResolvedValue({ medicoId: '57', fecha: '2026-10-19', estado: horas.length ? 'DISPONIBLE' : 'SIN_CUPOS', horarios: horas.map((hora, i) => ({ id: String(i), hora })) }),
    medico: jest.fn().mockResolvedValue({ medico: { id: '57', nombre: 'Dr. Juan Carlos Montalvo' }, especialidad: { id: 'e1', nombre: 'Ginecología' } }),
  } as unknown as Partial<AgendaService>;
}

describe('reservar desde el asistente', () => {
  it('solo se declara con permiso Y con el puerto de reservas de la conversación', () => {
    const nombres = (contexto: ContextoAsistente, permitirEscritura: boolean) => herramientasDisponibles(contexto, { permitirEscritura }).map(h => h.nombre);
    expect(nombres({ ...CONTEXTO, solicitud: 'AGENDAR' }, true)).not.toContain('reservar');
    expect(nombres({ ...CONTEXTO, solicitud: 'AGENDAR', reservas: reservas() }, false)).not.toContain('reservar');
    expect(nombres({ ...CONTEXTO, solicitud: 'AGENDAR', reservas: reservas() }, true)).toContain('reservar');
    /* Dar sus datos para la hora elegida puede leerse como consulta: sigue siendo agendar. */
    expect(nombres({ ...CONTEXTO, solicitud: 'CONSULTAR', reservas: reservas() }, true)).toContain('reservar');
    for (const solicitud of ['ACLARAR', 'PAGAR', 'PROMOCION', 'SALUDAR', 'CERRAR'] as const) {
      expect(nombres({ ...CONTEXTO, solicitud, reservas: reservas() }, true)).not.toContain('reservar');
    }
  });

  it('con los datos que ella escribió y la hora libre, queda como ACCIÓN: aquí no se escribe nada', async () => {
    const agenda = agendaConLibres(['12:00', '12:30']);
    const r = await montar(agenda).ejecutar('reservar', { ...PEDIDO, telefono: '+59177777777' }, { ...CONTEXTO, solicitud: 'AGENDAR', reservas: reservas() }, { permitirEscritura: true });
    expect(r).toMatchObject({ ok: true, accion: { tipo: 'RESERVA', ...PEDIDO, medico: 'Dr. Juan Carlos Montalvo' } });
    /* El teléfono no viaja en la acción: lo pone quien la ejecuta, de la conversación. */
    if (r.ok) expect(JSON.stringify(r.accion)).not.toContain('77777777');
    expect(agenda.disponibilidad).toHaveBeenCalledWith({ medicoId: '57', fecha: '2026-10-19' });
  });

  it.each([
    ['un nombre que no escribió', { nombre: 'René Vargas' }, 'no es el que ella escribió'],
    ['solo el nombre de pila', { nombre: 'René' }, 'nombre completo'],
    ['un carnet que no escribió', { ci: '11340618' }, 'no es el que ella escribió'],
    ['un carnet corto', { ci: '123' }, 'carnet'],
  ])('rechaza %s y no mira la agenda', async (_caso, cambio, motivo) => {
    const agenda = agendaConLibres(['12:00']);
    const r = await montar(agenda).ejecutar('reservar', { ...PEDIDO, ...cambio }, { ...CONTEXTO, solicitud: 'AGENDAR', reservas: reservas() }, { permitirEscritura: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain(motivo);
    expect(agenda.disponibilidad).not.toHaveBeenCalled();
  });

  it('una hora que no está libre devuelve las que sí, para que se las ofrezca', async () => {
    const r = await montar(agendaConLibres(['12:30', '16:00'])).ejecutar('reservar', PEDIDO, { ...CONTEXTO, solicitud: 'AGENDAR', reservas: reservas() }, { permitirEscritura: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain('12:30, 16:00');
  });

  it('con otra reserva esperando su pago no hace una nueva encima', async () => {
    const agenda = agendaConLibres(['12:00']);
    const r = await montar(agenda).ejecutar('reservar', PEDIDO, {
      ...CONTEXTO, solicitud: 'AGENDAR', reservas: reservas({ reservaPendiente: jest.fn().mockResolvedValue(4321) }),
    }, { permitirEscritura: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain('N.º 4321');
    expect(agenda.disponibilidad).not.toHaveBeenCalled();
  });

  it('sin el puerto de reservas (otra línea, otro país) la pasa a una persona', async () => {
    const r = await montar(agendaConLibres(['12:00'])).ejecutar('reservar', PEDIDO, { ...CONTEXTO, solicitud: 'AGENDAR' }, { permitirEscritura: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain('una persona');
  });
});

describe('qué herramientas tiene a mano', () => {
  it('sin permiso de escritura no hay `reservar`; sin línea comercial no hay nada de ventas', () => {
    const sinVentas = herramientasDisponibles(CONTEXTO, { permitirEscritura: false }).map(h => h.nombre);
    expect(sinVentas).not.toContain('reservar');
    expect(sinVentas).not.toContain('enviar_promocion');
    expect(sinVentas).toContain('pasar_a_persona');
    const conVentas = herramientasDisponibles({ ...CONTEXTO, ventas: ventas(), solicitud: 'PROMOCION' }, { permitirEscritura: false }).map(h => h.nombre);
    expect(conVentas).toEqual(expect.arrayContaining(['listar_promociones', 'enviar_promocion', 'estado_de_pago']));
  });

  it('ninguna herramienta manda el QR ni datos bancarios: cobrar es la tarjeta', () => {
    for (const h of HERRAMIENTAS) expect(h.nombre).not.toMatch(/qr|banco|cobrar|confirmar/);
  });
});

describe('las herramientas de ventas', () => {
  const conVentas = (p: Partial<PuertoVentas> = {}): ContextoAsistente => ({ ...CONTEXTO, ventas: ventas(p), solicitud: 'PROMOCION' });

  it('fuera de una línea comercial se rechazan aunque el modelo las pida', async () => {
    const r = await montar().ejecutar('listar_promociones', {}, CONTEXTO, { permitirEscritura: false });
    expect(r.ok).toBe(false);
  });

  it('listar_promociones da lo justo para elegir; sin promociones lo dice', async () => {
    const r = await montar().ejecutar('listar_promociones', {}, conVentas(), { permitirEscritura: false });
    expect(r).toEqual({ ok: true, datos: [{ id: 'p1', titulo: PROMO.titulo, resumen: PROMO.resumen, precioBs: 1200, vigenteHasta: '2026-10-31' }] });
    const vacia = await montar().ejecutar('listar_promociones', {}, conVentas({ promociones: jest.fn().mockResolvedValue([]) }), { permitirEscritura: false });
    expect(vacia).toEqual({ ok: true, datos: 'Hoy no hay promociones publicadas.' });
  });

  it('una promoción con servicios: la lista trae cada uno con su precio y el de siempre', async () => {
    const r = await montar().ejecutar('listar_promociones', {}, conVentas({ promociones: jest.fn().mockResolvedValue([ROSA]) }), { permitirEscritura: false });
    expect(r).toEqual({ ok: true, datos: [{
      id: 'p2', titulo: 'Octubre Rosa', resumen: ROSA.resumen, precioBs: null, vigenteHasta: '2026-10-31',
      servicios: [{ nombre: 'Ecografía Mamaria', precioBs: 268, antesBs: 446 }, { nombre: 'Consulta Ginecológica', precioBs: 175, antesBs: 250 }],
    }] });
  });

  it('enviar_promocion con un servicio: la acción lleva ese servicio; uno ajeno se rechaza diciéndole dónde mirar', async () => {
    const puerto = conVentas({ promocion: jest.fn().mockResolvedValue({ ...ROSA, sePuedePagarPorChat: true, sePuedeEnviarTarjeta: true }) });
    const r = await montar().ejecutar('enviar_promocion', { promocionId: 'p2', servicioId: 's1' }, puerto, { permitirEscritura: false });
    expect(r).toMatchObject({ ok: true, accion: { tipo: 'PROMOCION', promocionId: 'p2', servicioId: 's1' } });
    expect(JSON.stringify(r)).toContain('Ecografía Mamaria');
    const ajeno = await montar().ejecutar('enviar_promocion', { promocionId: 'p2', servicioId: 'otro' }, puerto, { permitirEscritura: false });
    expect(ajeno).toMatchObject({ ok: false, motivo: expect.stringContaining('ver_promocion') });
    const todos = await montar().ejecutar('enviar_promocion', { promocionId: 'p2' }, puerto, { permitirEscritura: false });
    expect(todos.ok && todos.accion).toEqual({ tipo: 'PROMOCION', promocionId: 'p2', titulo: 'Octubre Rosa' });
  });

  it('enviar_promocion no envía nada: deja la ACCIÓN para quien llama', async () => {
    const r = await montar().ejecutar('enviar_promocion', { promocionId: 'p1' }, conVentas(), { permitirEscritura: false });
    expect(r).toMatchObject({ ok: true, accion: { tipo: 'PROMOCION', promocionId: 'p1', titulo: PROMO.titulo } });
  });

  it('una promoción que no existe o no está vigente se rechaza diciéndole qué hacer', async () => {
    const r = await montar().ejecutar('enviar_promocion', { promocionId: 'zz' }, conVentas({ promocion: jest.fn().mockResolvedValue(null) }), { permitirEscritura: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain('no existe');
  });

  it('si la línea no manda tarjetas, enviar_promocion se rechaza y le dice que pase el pago a una persona', async () => {
    const promocion = jest.fn().mockResolvedValue({ ...PROMO, sePuedePagarPorChat: false, sePuedeEnviarTarjeta: false });
    const r = await montar().ejecutar('enviar_promocion', { promocionId: 'p1' }, conVentas({ promocion }), { permitirEscritura: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain('persona');
  });

  it('estado_de_pago devuelve lo del puerto, que está atado a ESTA conversación', async () => {
    const estadoDePago = jest.fn().mockResolvedValue({ qrDisponible: true, pago: { estado: 'COMPROBANTE_EN_REVISION', promocion: 'Botox', monto: 1200, motivoRechazo: null } });
    const r = await montar().ejecutar('estado_de_pago', { conversacionId: 'otra' }, conVentas({ estadoDePago }), { permitirEscritura: false });
    expect(r).toMatchObject({ ok: true, datos: { pago: { estado: 'COMPROBANTE_EN_REVISION' } } });
    expect(estadoDePago).toHaveBeenCalledWith();
  });
});

describe('agenda y derivación', () => {
  const medico = {
    medico: { id: '7', nombre: 'Dra. Ana Rojas', modalidad: 'ONLINE', precio: { importeCentavos: 25000, moneda: 'BOB' }, horarioInformativo: 'Martes: entre 10:00 y 12:00', fotoUrl: 'https://x/foto.jpg', especialidadId: 'e' },
    especialidad: { id: 'e', nombre: 'Dermatología' },
  };

  it('ver_medico devuelve lo que sirve para contestar, sin URLs internas', async () => {
    const r = await montar({ medico: jest.fn().mockResolvedValue(medico) }).ejecutar('ver_medico', { medicoId: '7' }, CONTEXTO, { permitirEscritura: false });
    expect(r).toEqual({ ok: true, datos: { id: '7', nombre: 'Dra. Ana Rojas', especialidad: 'Dermatología', modalidad: 'ONLINE', precioConsulta: 'Bs 250.00', atiende: 'Martes: entre 10:00 y 12:00' } });
  });

  it('enviar_horario deja la acción con el horario en texto (el pie de la imagen)', async () => {
    const r = await montar({ medico: jest.fn().mockResolvedValue(medico) }).ejecutar('enviar_horario', { medicoId: '7' }, { ...CONTEXTO, solicitud: 'HORARIO' }, { permitirEscritura: false });
    expect(r).toMatchObject({ ok: true, accion: { tipo: 'HORARIO', medicoId: 7, nombre: 'Dra. Ana Rojas', horario: 'Martes: entre 10:00 y 12:00' } });
  });

  it('un médico sin horario fijo no tiene imagen: atiende a solicitud', async () => {
    const sinHorario = { ...medico, medico: { ...medico.medico, horarioInformativo: null } };
    const r = await montar({ medico: jest.fn().mockResolvedValue(sinHorario) }).ejecutar('enviar_horario', { medicoId: '7' }, { ...CONTEXTO, solicitud: 'HORARIO' }, { permitirEscritura: false });
    expect(r.ok).toBe(false);
  });

  it('pasar_a_persona exige un motivo de la lista cerrada y deja la acción DERIVAR', async () => {
    const malo = await montar().ejecutar('pasar_a_persona', { motivo: 'ABURRIDA', resumen: 'x' }, CONTEXTO, { permitirEscritura: false });
    expect(malo.ok).toBe(false);
    if (!malo.ok) expect(malo.motivo).toContain('MEDICO');
    const bueno = await montar().ejecutar('pasar_a_persona', { motivo: 'MEDICO', resumen: 'Pregunta si puede tomar ibuprofeno.' }, CONTEXTO, { permitirEscritura: false });
    expect(bueno).toMatchObject({ ok: true, accion: { tipo: 'DERIVAR', motivo: 'MEDICO' } });
  });
});

/* ── Buscar un médico por su nombre (13/10) ─────────────────────────────── */
describe('buscar_medico: un médico por su nombre, en una sola vuelta', () => {
  const pagina = <T>(datos: T[]) => ({ datos, total: datos.length, pagina: 1, limite: 50, totalPaginas: 1 });
  const med = (id: string, nombre: string, especialidadId: string) =>
    ({ id, nombre, especialidadId, modalidad: 'ONLINE', precio: { importeCentavos: 30000, moneda: 'BOB' }, horarioInformativo: 'Lunes 9:00', fotoUrl: null });
  function agendaDeLaClinica() {
    const g = { id: 'g', nombre: 'Ginecología' };
    const d = { id: 'd', nombre: 'Dermatología' };
    return {
      todosLosMedicos: jest.fn().mockResolvedValue([
        { medico: med('1', 'Dr. Juan Carlos Montalvo Doria Medina', 'g'), especialidad: g },
        { medico: med('2', 'Dra. Claudia Azogue', 'g'), especialidad: g },
        { medico: med('3', 'Dr. Luis Montaño', 'd'), especialidad: d },
      ]),
      /* Lo que NO debe usar: una lectura por especialidad desbordaba el pool de la agenda (13/10). */
      especialidades: jest.fn().mockResolvedValue(pagina([g, d])),
      medicos: jest.fn().mockResolvedValue(pagina([])),
    };
  }
  const buscar = (agenda: ReturnType<typeof agendaDeLaClinica>, nombre: string) =>
    montar(agenda as unknown as Partial<AgendaService>).ejecutar('buscar_medico', { nombre }, CONTEXTO, { permitirEscritura: false });

  it('«dr montalvo» lo encuentra en todas las especialidades a la vez, con su especialidad y su precio', async () => {
    const agenda = agendaDeLaClinica();
    const r = await buscar(agenda, 'dr montalvo');
    expect(r).toEqual({
      ok: true,
      datos: [{ id: '1', nombre: 'Dr. Juan Carlos Montalvo Doria Medina', especialidad: 'Ginecología', modalidad: 'ONLINE', precioConsulta: 'Bs 300.00', atiende: 'Lunes 9:00' }],
    });
    /* UNA lectura de la agenda, sin importar cuántas especialidades haya. */
    expect(agenda.todosLosMedicos).toHaveBeenCalledTimes(1);
    expect(agenda.especialidades).not.toHaveBeenCalled();
    expect(agenda.medicos).not.toHaveBeenCalled();
  });

  it('si la agenda no responde, falla la herramienta (no inventa «no existe»)', async () => {
    const agenda = agendaDeLaClinica();
    agenda.todosLosMedicos.mockRejectedValue(new Error('agenda caída'));
    await expect(buscar(agenda, 'montalvo')).rejects.toThrow('agenda caída');
  });

  it('sin tildes ni mayúsculas, y por el principio de cada palabra («azog», «MONTAÑO»)', async () => {
    const agenda = agendaDeLaClinica();
    expect(await buscar(agenda, 'Dra. Azóg')).toMatchObject({ ok: true, datos: [{ id: '2' }] });
    expect(await buscar(agenda, 'MONTAÑO')).toMatchObject({ ok: true, datos: [{ id: '3' }] });
    /* «mont» es el principio de dos apellidos: vienen los dos y el modelo pregunta cuál. */
    expect(await buscar(agenda, 'mont')).toMatchObject({ ok: true, datos: [{ id: '1' }, { id: '3' }] });
  });

  it('si nadie se llama así, lo dice para que no lo invente', async () => {
    const r = await buscar(agendaDeLaClinica(), 'doctor Pérez');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.datos).toEqual(expect.stringContaining('No lo inventes'));
  });

  it('solo un título («doctor») no es un nombre: no recorre la agenda', async () => {
    const agenda = agendaDeLaClinica();
    expect((await buscar(agenda, 'Dr.')).ok).toBe(false);
    expect(agenda.todosLosMedicos).not.toHaveBeenCalled();
  });

  /* Un apellido compuesto, que la agenda escribe en dos palabras. */
  function agendaConApellidoCompuesto() {
    const agenda = agendaDeLaClinica();
    const u = { id: 'u', nombre: 'Urología' };
    agenda.todosLosMedicos.mockResolvedValue([
      { medico: med('4', 'Dr. San Roman Pedro', 'u'), especialidad: u },
      { medico: med('5', 'Dra. Lucía Roman Prueba', 'g'), especialidad: { id: 'g', nombre: 'Ginecología' } },
      { medico: med('1', 'Dr. Juan Carlos Montalvo Doria Medina', 'g'), especialidad: { id: 'g', nombre: 'Ginecología' } },
    ]);
    return agenda;
  }

  it('un apellido que la agenda escribe en dos palabras se encuentra escrito junto («sanroman» → «San Roman»)', async () => {
    expect(await buscar(agendaConApellidoCompuesto(), 'dr sanroman')).toMatchObject({ ok: true, datos: [{ id: '4', nombre: 'Dr. San Roman Pedro', especialidad: 'Urología' }] });
    expect(await buscar(agendaConApellidoCompuesto(), 'juancarlos')).toMatchObject({ ok: true, datos: [{ id: '1' }] });
    /* Separado sigue funcionando, y «roman» solo trae a los dos que lo llevan. */
    expect(await buscar(agendaConApellidoCompuesto(), 'san roman')).toMatchObject({ ok: true, datos: [{ id: '4' }] });
    expect(await buscar(agendaConApellidoCompuesto(), 'roman')).toMatchObject({ ok: true, datos: [{ id: '4' }, { id: '5' }] });
  });

  it('mal escrito, devuelve los parecidos con un aviso para que confirme con la paciente', async () => {
    for (const escrito of ['sanrroman', 'zanroman', 'Dr. Sanromen', 'montalbo']) {
      const r = await buscar(agendaConApellidoCompuesto(), escrito);
      expect(r).toMatchObject({ ok: true, datos: { aviso: expect.stringContaining('se parecen'), parecidos: [expect.any(Object)] } });
    }
    const r = await buscar(agendaConApellidoCompuesto(), 'sanrroman');
    expect(r).toMatchObject({ datos: { parecidos: [{ id: '4', nombre: 'Dr. San Roman Pedro' }] } });
  });

  it('lo parecido no se cuela si alguien se llama así, ni se inventa con palabras cortas', async () => {
    /* «Montaño» se parece a «Montalvo» de lejos, pero hay un Montalvo exacto: solo él. */
    expect(await buscar(agendaDeLaClinica(), 'montalvo')).toMatchObject({ ok: true, datos: [{ id: '1' }] });
    /* «Luiz» suena a «Luis»; «Lucas» tiene más de una letra de diferencia y no es nadie. */
    expect(await buscar(agendaDeLaClinica(), 'luiz')).toMatchObject({ ok: true, datos: { parecidos: [{ id: '3' }] } });
    for (const escrito of ['lucas', 'lopez']) {
      const nadie = await buscar(agendaDeLaClinica(), escrito);
      expect(nadie.ok && typeof nadie.datos).toBe('string');
    }
  });

  it('cómo suena: b/v, c/k/qu, s/z, h muda y letras dobles', () => {
    expect(sonidoDe('sanrroman')).toBe(sonidoDe('zanroman'));
    expect(sonidoDe('azogue')).toBe(sonidoDe('asogue'));
    expect(sonidoDe('hernandez')).toBe(sonidoDe('ernandes'));
    expect(sonidoDe('cecilia')).toBe(sonidoDe('sesilia'));
    expect(sonidoDe('chavez')).not.toBe(sonidoDe('cabes'));
  });

  it('las palabras de un nombre: sin tildes, sin títulos, sin signos', () => {
    expect(palabrasDeNombre('Dra. María José Ñúñez-Azogue')).toEqual(['maria', 'jose', 'nunez', 'azogue']);
    expect(palabrasDeNombre('doctor Montalvo')).toEqual(['montalvo']);
  });
});

/* ── La agenda del médico que escribe ──────────────────────────────────── */
describe('mi_agenda: la agenda del médico que escribe', () => {
  const AGENDA_DIA = armarAgendaDelDia('2026-10-12', [{ hora: '09:00', paciente: 'Ana Pérez' }], [{ hora: '10:00', paciente: 'Carla Soto', estado: 'PENDIENTE' }]);
  const conMedico = (p: Partial<PuertoMedico> = {}): { contexto: ContextoAsistente; puerto: PuertoMedico } => {
    const puerto: PuertoMedico = { nombre: 'Dra. Claudia Azogue', agendaDelDia: jest.fn().mockResolvedValue(AGENDA_DIA), ...p };
    return { contexto: { telefono: '+59170012345', ventas: null, medico: puerto }, puerto };
  };
  const NO = { permitirEscritura: false };
  const nombresDe = (c: ContextoAsistente) => herramientasDisponibles(c, NO).map(h => h.nombre);

  it('a un médico se le ofrecen su agenda, lo informativo de la clínica y pasar a una persona; a una paciente, nunca la agenda de un médico', () => {
    expect(nombresDe(conMedico().contexto).sort()).toEqual(['buscar_medico', 'dias_con_cupo', 'horas_libres', 'listar_especialidades', 'listar_medicos', 'mi_agenda', 'pasar_a_persona', 'ver_medico']);
    /* En una línea comercial, también leer promociones; mandarlas, cobrar o ver pagos, no. */
    const conVentas = nombresDe({ ...conMedico().contexto, ventas: ventas() });
    expect(conVentas).toEqual(expect.arrayContaining(['listar_promociones', 'ver_promocion']));
    for (const nunca of ['enviar_promocion', 'estado_de_pago', 'enviar_horario', 'reservar']) expect(conVentas).not.toContain(nunca);
    expect(nombresDe(CONTEXTO)).not.toContain('mi_agenda');
    expect(nombresDe({ ...CONTEXTO, ventas: ventas() })).not.toContain('mi_agenda');
    /* Ni con permiso de escritura se le abre `reservar` a un médico. */
    expect(herramientasDisponibles(conMedico().contexto, { permitirEscritura: true }).map(h => h.nombre)).not.toContain('reservar');
  });

  it('sin médico en el contexto, mi_agenda no se ejecuta aunque el modelo la pida (ni toca la agenda)', async () => {
    const citas = jest.fn();
    const r = await montar().ejecutar('mi_agenda', { fecha: '2026-10-12', detalle: 'LISTA' }, { ...CONTEXTO, medico: null }, NO);
    expect(r.ok).toBe(false);
    expect(citas).not.toHaveBeenCalled();
  });

  it('con un médico, lo que manda, cobra o reserva no se ejecuta aunque el modelo lo pida', async () => {
    const { contexto } = conMedico();
    const conVentas = { ...contexto, ventas: ventas() };
    const agenda = { especialidades: jest.fn(), medicos: jest.fn(), disponibilidad: jest.fn() };
    const servicio = montar(agenda as unknown as Partial<AgendaService>);
    for (const nombre of ['enviar_horario', 'enviar_promocion', 'estado_de_pago', 'reservar']) {
      const r = await servicio.ejecutar(nombre, { especialidadId: '1', medicoId: '7', fecha: '2026-10-12', hora: '09:00', nombre: 'x', ci: '1', promocionId: 'p1' }, conVentas, { permitirEscritura: true });
      expect(r.ok).toBe(false);
    }
    expect(agenda.disponibilidad).not.toHaveBeenCalled();
    /* Sin línea comercial, tampoco lee promociones. */
    expect((await servicio.ejecutar('listar_promociones', {}, contexto, NO)).ok).toBe(false);
  });

  it('con un médico, lo informativo de la clínica sí se consulta («¿qué servicios hay?»)', async () => {
    const { contexto } = conMedico();
    const agenda = { especialidades: jest.fn().mockResolvedValue({ datos: [{ id: 'e1', nombre: 'Ginecología' }], total: 1, pagina: 1, limite: 100, totalPaginas: 1 }) };
    const r = await montar(agenda as unknown as Partial<AgendaService>).ejecutar('listar_especialidades', {}, contexto, NO);
    expect(r.ok).toBe(true);
    expect(agenda.especialidades).toHaveBeenCalled();
  });

  it('al modelo vuelven SOLO las cantidades; los nombres van en la acción, para el código', async () => {
    const { contexto, puerto } = conMedico();
    const r = await montar().ejecutar('mi_agenda', { fecha: '2026-10-12', detalle: 'LISTA' }, contexto, NO);
    expect(puerto.agendaDelDia).toHaveBeenCalledWith('2026-10-12');
    expect(r).toMatchObject({
      ok: true,
      datos: { fecha: '2026-10-12', citas: 2, confirmadas: 1, pendientes: 1 },
      accion: { tipo: 'AGENDA_MEDICO', detalle: 'LISTA', medico: 'Dra. Claudia Azogue', agenda: { total: 2 } },
    });
    if (r.ok) expect(JSON.stringify(r.datos)).not.toMatch(/Ana|Pérez|Carla|Soto|09:00|10:00/);
  });

  it('el médico lo fija el contexto: un medicoId que mande el modelo no se usa ni se pasa', async () => {
    const { contexto, puerto } = conMedico();
    await montar().ejecutar('mi_agenda', { fecha: '2026-10-12', detalle: 'RESUMEN', medicoId: '99', agendaMedicoId: 99, telefono: '+59100000000' }, contexto, NO);
    expect((puerto.agendaDelDia as jest.Mock).mock.calls).toEqual([['2026-10-12']]);
    const h = HERRAMIENTAS.find(x => x.nombre === 'mi_agenda')!;
    expect(Object.keys(h.parametros.properties).sort()).toEqual(['detalle', 'fecha']);
  });

  it('valida la fecha y el detalle antes de consultar', async () => {
    const { contexto, puerto } = conMedico();
    for (const args of [{}, { fecha: 'mañana', detalle: 'LISTA' }, { fecha: '2026-10-12' }, { fecha: '2026-10-12', detalle: 'TODO' }]) {
      expect((await montar().ejecutar('mi_agenda', args, contexto, NO)).ok).toBe(false);
    }
    expect(puerto.agendaDelDia).not.toHaveBeenCalled();
  });

  it('una fecha fuera de rango vuelve al modelo como un error que puede corregir; un fallo de la agenda sube', async () => {
    const fuera = conMedico({ agendaDelDia: jest.fn().mockRejectedValue(new BadRequestException('Solo se consulta de 31 días atrás a 180 adelante.')) });
    const r = await montar().ejecutar('mi_agenda', { fecha: '2030-01-01', detalle: 'LISTA' }, fuera.contexto, NO);
    expect(r).toEqual({ ok: false, motivo: 'Solo se consulta de 31 días atrás a 180 adelante.' });
    const caida = conMedico({ agendaDelDia: jest.fn().mockRejectedValue(new ServiceUnavailableException()) });
    await expect(montar().ejecutar('mi_agenda', { fecha: '2026-10-12', detalle: 'LISTA' }, caida.contexto, NO)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
