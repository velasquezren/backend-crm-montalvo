import { AgendaReservasService } from '../agenda/agenda-reservas.service';
import { AgendaService } from '../agenda/agenda.service';
import {
  ContextoAsistente,
  declaraciones,
  HERRAMIENTAS,
  herramientasDisponibles,
  HerramientasAsistenteService,
  PromocionParaAsistente,
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
  etiquetaOferta: '-20%', precio: 1200, precioRegular: 1500, precioPromocional: 1200, vigenteHasta: '2026-10-31',
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

function montar(agenda: Partial<AgendaService> = {}, reservas: Partial<AgendaReservasService> = {}) {
  return new HerramientasAsistenteService(
    agenda as AgendaService,
    reservas as AgendaReservasService,
  );
}

describe('catálogo de herramientas del asistente', () => {
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

  it('una lectura llama al servicio de la agenda, no al de reservas', async () => {
    const especialidades = jest.fn().mockResolvedValue({ datos: [] });
    const reservar = jest.fn();
    const r = await montar({ especialidades }, { reservar }).ejecutar('listar_especialidades', {}, CONTEXTO, { permitirEscritura: false });
    expect(r.ok).toBe(true);
    expect(especialidades).toHaveBeenCalledTimes(1);
    expect(reservar).not.toHaveBeenCalled();
  });

  /* La regla central: el modelo puede PEDIR una escritura y no se hace. */
  it('sin permiso, `reservar` NO llega al servicio y lo dice en castellano', async () => {
    const reservar = jest.fn();
    const r = await montar({}, { reservar }).ejecutar(
      'reservar',
      { medicoId: '1', fecha: '2026-10-12', hora: '10:30', nombre: 'Ana Pérez', ci: '123456' },
      CONTEXTO,
      { permitirEscritura: false },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain('una persona');
    expect(reservar).not.toHaveBeenCalled();
  });

  it('con permiso, reserva con el teléfono DE LA CONVERSACIÓN y no uno del modelo', async () => {
    const reservar = jest.fn().mockResolvedValue({ codigo: 9 });
    const r = await montar({}, { reservar }).ejecutar(
      'reservar',
      { medicoId: '1', fecha: '2026-10-12', hora: '10:30', nombre: 'Ana Pérez', ci: '123456', telefono: '+59177777777' },
      CONTEXTO,
      { permitirEscritura: true },
    );
    expect(r.ok).toBe(true);
    expect(reservar).toHaveBeenCalledTimes(1);
    const dto = reservar.mock.calls[0][0];
    expect(dto.telefono).toBe(CONTEXTO.telefono);
    expect(dto.telefono).not.toBe('+59177777777');
    expect(dto.observaciones).toContain('asistente');
  });

  it('una escritura con argumentos malos se rechaza por el permiso ANTES de validar', async () => {
    /* El orden importa: si validara primero, el mensaje de vuelta le diría al
       modelo qué corregir para una herramienta que de todas formas no puede usar. */
    const reservar = jest.fn();
    const r = await montar({}, { reservar }).ejecutar('reservar', {}, CONTEXTO, { permitirEscritura: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).not.toContain('Falta');
    expect(reservar).not.toHaveBeenCalled();
  });
});

describe('qué herramientas tiene a mano', () => {
  it('sin permiso de escritura no hay `reservar`; sin línea comercial no hay nada de ventas', () => {
    const sinVentas = herramientasDisponibles(CONTEXTO, { permitirEscritura: false }).map(h => h.nombre);
    expect(sinVentas).not.toContain('reservar');
    expect(sinVentas).not.toContain('enviar_promocion');
    expect(sinVentas).toContain('pasar_a_persona');
    const conVentas = herramientasDisponibles({ ...CONTEXTO, ventas: ventas() }, { permitirEscritura: false }).map(h => h.nombre);
    expect(conVentas).toEqual(expect.arrayContaining(['listar_promociones', 'enviar_promocion', 'estado_de_pago']));
  });

  it('ninguna herramienta manda el QR ni datos bancarios: cobrar es la tarjeta', () => {
    for (const h of HERRAMIENTAS) expect(h.nombre).not.toMatch(/qr|banco|cobrar|confirmar/);
  });
});

describe('las herramientas de ventas', () => {
  const conVentas = (p: Partial<PuertoVentas> = {}): ContextoAsistente => ({ ...CONTEXTO, ventas: ventas(p) });

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
    const r = await montar({ medico: jest.fn().mockResolvedValue(medico) }).ejecutar('enviar_horario', { medicoId: '7' }, CONTEXTO, { permitirEscritura: false });
    expect(r).toMatchObject({ ok: true, accion: { tipo: 'HORARIO', medicoId: 7, nombre: 'Dra. Ana Rojas', horario: 'Martes: entre 10:00 y 12:00' } });
  });

  it('un médico sin horario fijo no tiene imagen: atiende a solicitud', async () => {
    const sinHorario = { ...medico, medico: { ...medico.medico, horarioInformativo: null } };
    const r = await montar({ medico: jest.fn().mockResolvedValue(sinHorario) }).ejecutar('enviar_horario', { medicoId: '7' }, CONTEXTO, { permitirEscritura: false });
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
