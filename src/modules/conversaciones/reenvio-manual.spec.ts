import { motivoParaNoReenviar, MensajeReenviable } from './reenvio-manual';

const fallido = (cambios: Partial<MensajeReenviable> = {}): MensajeReenviable => ({
  estadoEnvio: 'FALLIDO', codigoErrorEnvio: null, automatico: false, plantillaCategoria: null, tieneInteraccion: false, ...cambios,
});

describe('motivoParaNoReenviar', () => {
  it.each([
    ['sin código (la red)', null],
    ['facturación de Meta, ya pagada', 131042],
    ['adjunto que Meta no pudo bajar', 131053],
    ['límite de frecuencia', 130429],
  ])('se reenvía un rechazo que la clínica puede resolver: %s', (_caso, codigo) => {
    expect(motivoParaNoReenviar(fallido({ codigoErrorEnvio: codigo }))).toBeNull();
  });

  it.each([131050, 130497, 131026])('no ofrece reenviar lo que reenviar no arregla (%s)', codigo => {
    expect(motivoParaNoReenviar(fallido({ codigoErrorEnvio: codigo }))).toContain('aunque se reenvíe');
  });

  it.each([
    ['ya salió', { estadoEnvio: 'ENTREGADO' }, 'ya no figura'],
    ['está en duda', { estadoEnvio: 'INCIERTO' }, 'ya no figura'],
    ['es una plantilla', { plantillaCategoria: 'MARKETING' }, 'Plantilla'],
    ['lo mandó el CRM', { automatico: true }, 'automáticos'],
    ['es una oferta interactiva', { tieneInteraccion: true }, 'automáticos'],
  ])('no se reenvía si %s', (_caso, cambios, motivo) => {
    expect(motivoParaNoReenviar(fallido(cambios as Partial<MensajeReenviable>))).toContain(motivo);
  });
});
