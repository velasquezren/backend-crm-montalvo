import { ConfigService } from '@nestjs/config';

import { LIMITES_ASISTENTE, motivoParaNoGuardar } from './asistente-lineas.service';
import { ConfiguracionIA, MODELO_POR_DEFECTO } from './vertex/proveedor-vertex';

describe('motivoParaNoGuardar', () => {
  it('RESPONDER sin el criterio de la clínica no se guarda', () => {
    expect(motivoParaNoGuardar({ modo: 'RESPONDER', criterioDerivacion: '' })).toContain('la clínica');
    expect(motivoParaNoGuardar({ modo: 'RESPONDER', criterioDerivacion: 'lo médico' })).not.toBeNull();
  });

  it('con un criterio de verdad, o en SUGERIR, sí', () => {
    expect(motivoParaNoGuardar({ modo: 'RESPONDER', criterioDerivacion: 'x'.repeat(LIMITES_ASISTENTE.criterioMinimo) })).toBeNull();
    expect(motivoParaNoGuardar({ modo: 'SUGERIR', criterioDerivacion: '' })).toBeNull();
  });
});

describe('ConfiguracionIA', () => {
  const con = (v: Record<string, string>) => new ConfiguracionIA(new ConfigService(v));

  it('apagada por defecto: sin ASISTENTE_IA=on no está lista aunque haya proyecto', () => {
    expect(con({ GOOGLE_CLOUD_PROJECT: 'montalvo' }).estado().listo).toBe(false);
  });

  it('encendida y con proyecto, está lista; el modelo y la ubicación tienen valores seguros por defecto', () => {
    const e = con({ ASISTENTE_IA: 'on', GOOGLE_CLOUD_PROJECT: 'montalvo' }).estado();
    expect(e).toMatchObject({ listo: true, modelo: MODELO_POR_DEFECTO, ubicacion: 'global', credenciales: 'AMBIENTE' });
  });

  it('una ruta de credenciales que no existe no está lista: falla al configurar, no con la primera paciente', () => {
    const e = con({ ASISTENTE_IA: 'on', GOOGLE_CLOUD_PROJECT: 'montalvo', GOOGLE_APPLICATION_CREDENTIALS: '/no/existe.json' }).estado();
    expect(e).toMatchObject({ listo: false, credenciales: 'ARCHIVO_INEXISTENTE' });
  });

  it('el modelo se cambia por variable, con su nombre exacto', () => {
    expect(con({ ASISTENTE_MODELO: 'gemini-3.8-flash' }).modelo).toBe('gemini-3.8-flash');
  });
});
