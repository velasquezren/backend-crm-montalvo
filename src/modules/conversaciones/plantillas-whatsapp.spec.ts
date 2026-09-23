import { PlantillaMeta, renderizarPlantilla, resumirPlantilla, validarParametros } from './plantillas-whatsapp';

const meta = (extra: Partial<PlantillaMeta> = {}): PlantillaMeta => ({
  name: 'recordatorio',
  status: 'APPROVED',
  category: 'UTILITY',
  language: 'es',
  components: [
    { type: 'BODY', text: 'Hola {{1}}, tu cita es el {{2}}. Te esperamos, {{1}}.' },
    { type: 'FOOTER', text: 'Clínica Montalvo' },
  ],
  ...extra,
});

describe('resumirPlantilla', () => {
  it('posicional: variables únicas y en orden numérico', () => {
    const p = resumirPlantilla(meta({ components: [{ type: 'BODY', text: '{{2}} y luego {{1}}' }] }));
    expect(p.nombresVariables).toEqual(['1', '2']);
    expect(p.formato).toBe('POSITIONAL');
    expect(p.enviable).toBe(true);
  });

  it('con nombre: en orden de aparición', () => {
    const p = resumirPlantilla(
      meta({ parameter_format: 'NAMED', components: [{ type: 'BODY', text: 'Hola {{nombre}}, el {{fecha}}' }] }),
    );
    expect(p.nombresVariables).toEqual(['nombre', 'fecha']);
    expect(p.formato).toBe('NAMED');
  });

  it('no deja enviar lo que el chat no sabe rellenar', () => {
    const conImagen = resumirPlantilla(meta({ components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'x' }] }));
    const conEnlace = resumirPlantilla(
      meta({ components: [{ type: 'BODY', text: 'x' }, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Ver', url: 'https://a.b/{{1}}' }] }] }),
    );
    const cabeceraTexto = resumirPlantilla(meta({ components: [{ type: 'HEADER', format: 'TEXT', text: 'Aviso' }, { type: 'BODY', text: 'x' }] }));
    expect(conImagen.enviable).toBe(false);
    expect(conEnlace.enviable).toBe(false);
    expect(cabeceraTexto.enviable).toBe(true);
  });
});

describe('validarParametros', () => {
  const p = resumirPlantilla(meta());

  it('recorta y acepta valores completos', () => {
    expect(validarParametros(p, ['  Ana ', 'lunes 10:00'])).toEqual(['Ana', 'lunes 10:00']);
  });

  it('rechaza faltantes, vacíos y saltos de línea antes de llegar a Meta', () => {
    expect(() => validarParametros(p, ['Ana'])).toThrow('necesita 2');
    expect(() => validarParametros(p, ['Ana', '  '])).toThrow('Falta completar «2»');
    expect(() => validarParametros(p, ['Ana', 'lunes\n10:00'])).toThrow('saltos de línea');
  });
});

describe('renderizarPlantilla', () => {
  it('guarda lo que recibe el paciente, no las llaves', () => {
    const p = resumirPlantilla(meta());
    expect(renderizarPlantilla(p, ['Ana', 'lunes'])).toBe(
      'Hola Ana, tu cita es el lunes. Te esperamos, Ana.\n\nClínica Montalvo',
    );
  });
});
