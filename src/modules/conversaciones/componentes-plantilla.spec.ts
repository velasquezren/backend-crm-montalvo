import { componentesPlantilla } from './despachador-saliente.service';

/**
 * Meta rechaza el envío ENTERO si los componentes no coinciden con la plantilla
 * aprobada: sobra uno, falta uno, o `components` viene vacío. El paciente no
 * recibe nada y el error llega como un código genérico de parámetros.
 */
describe('componentesPlantilla', () => {
  it('sin variables ni botón no manda ningún componente', () => {
    expect(componentesPlantilla({ plantilla: 'p', idioma: 'es' })).toEqual([]);
    expect(componentesPlantilla({ plantilla: 'p', idioma: 'es', parametros: [] })).toEqual([]);
  });

  it('solo cuerpo: las variables van en orden', () => {
    expect(componentesPlantilla({ plantilla: 'p', idioma: 'es', parametros: ['22 sep', '10:30'] })).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: '22 sep' }, { type: 'text', text: '10:30' }] },
    ]);
  });

  /* La plantilla de resultados: cuerpo sin variables y botón URL en índice 0. */
  it('solo botón: componente de botón en índice 0, sin cuerpo', () => {
    expect(
      componentesPlantilla({ plantilla: 'montalvo_resultado_disponible', idioma: 'es', boton: '32415e53-ef1f-45e6-a9fa-7f6c91f9168b' }),
    ).toEqual([
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '32415e53-ef1f-45e6-a9fa-7f6c91f9168b' }] },
    ]);
  });

  it('cuerpo y botón conviven, y el botón va después', () => {
    const componentes = componentesPlantilla({ plantilla: 'p', idioma: 'es', parametros: ['Ana'], boton: 'abc' });
    expect(componentes).toHaveLength(2);
    expect(componentes[0].type).toBe('body');
    expect(componentes[1].type).toBe('button');
  });

  it('plantilla NAMED: cada parámetro lleva su nombre', () => {
    expect(
      componentesPlantilla({ plantilla: 'p', idioma: 'es', parametros: ['Ana', 'lunes'], nombresParametros: ['nombre', 'dia'] }),
    ).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', parameter_name: 'nombre', text: 'Ana' },
          { type: 'text', parameter_name: 'dia', text: 'lunes' },
        ],
      },
    ]);
  });

  it('con imagen de cabecera: el encabezado va primero, luego el botón', () => {
    const componentes = componentesPlantilla({
      plantilla: 'montalvo_informe_listo', idioma: 'es', boton: 'abc',
      imagenCabecera: 'https://resultados.example/resultados/imagen-aviso',
    });
    expect(componentes).toEqual([
      { type: 'header', parameters: [{ type: 'image', image: { link: 'https://resultados.example/resultados/imagen-aviso' } }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'abc' }] },
    ]);
  });
});
