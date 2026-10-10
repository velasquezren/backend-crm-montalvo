import { AgendaReservasService } from '../agenda/agenda-reservas.service';
import { AgendaService } from '../agenda/agenda.service';
import {
  declaracionesParaElModelo,
  HERRAMIENTAS,
  HerramientasAsistenteService,
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
const CONTEXTO = { telefono: '+59170012345' };

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
    const d = declaracionesParaElModelo();
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
