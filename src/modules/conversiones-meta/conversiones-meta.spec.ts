import { clicDeLaFicha, decidirAviso, leerRespuesta, VentaParaAvisar } from './conversiones-meta';

const AHORA = new Date('2026-10-20T15:00:00Z');
const VENTA_EN = new Date('2026-10-20T13:00:00Z');

function venta(cambios: Partial<VentaParaAvisar> = {}): VentaParaAvisar {
  return {
    id: 'venta-1', estado: 'GANADA', monto: 1200,
    lead: { anuncioId: 'AD-1', metaLeadId: null, wabaId: 'WABA-1' },
    clic: { clickId: 'CLID-1', anuncioId: 'AD-1', fecha: new Date('2026-10-18T10:00:00Z') },
    ...cambios,
  };
}

describe('decidirAviso', () => {
  it('una venta de un clic en un anuncio de WhatsApp se avisa con lo mínimo y nada más', () => {
    const decision = decidirAviso(venta(), VENTA_EN, AHORA);
    expect(decision).toEqual({
      avisar: true,
      evento: {
        event_name: 'Purchase',
        event_time: Math.floor(VENTA_EN.getTime() / 1000),
        event_id: 'venta-1',
        action_source: 'business_messaging',
        messaging_channel: 'whatsapp',
        user_data: { whatsapp_business_account_id: 'WABA-1', ctwa_clid: 'CLID-1' },
        custom_data: { currency: 'BOB', value: 1200 },
      },
    });
  });

  /* Lo que NO puede viajar nunca, aunque mañana alguien agregue campos a la venta. */
  it('el evento no lleva producto, médico, nombre, teléfono ni nada de la paciente', () => {
    const decision = decidirAviso(venta(), VENTA_EN, AHORA);
    const texto = JSON.stringify(decision);
    for (const prohibido of ['producto', 'medico', 'nombre', 'telefono', 'ph', 'em', 'content_name', 'pac']) {
      expect(texto).not.toContain(`"${prohibido}"`);
    }
  });

  it.each([
    ['anulada', venta({ estado: 'PERDIDA' }), 'PERDIDA'],
    ['sin lead', venta({ lead: null }), 'Sin lead'],
    ['de un formulario de Meta', venta({ lead: { anuncioId: 'AD-1', metaLeadId: 'LG-1', wabaId: 'WABA-1' } }), 'formulario'],
    ['de un lead orgánico', venta({ lead: { anuncioId: null, metaLeadId: null, wabaId: 'WABA-1' } }), 'anuncio'],
    ['sin clic guardado', venta({ clic: null }), 'ctwa_clid'],
    ['cuyo último clic es de otro anuncio', venta({ clic: { clickId: 'CLID-9', anuncioId: 'AD-9', fecha: null } }), 'otro anuncio'],
    ['sin WABA', venta({ lead: { anuncioId: 'AD-1', metaLeadId: null, wabaId: null } }), 'WABA'],
    ['sin monto', venta({ monto: 0 }), 'monto'],
  ])('no avisa una venta %s', (_caso, datos, motivo) => {
    const decision = decidirAviso(datos, VENTA_EN, AHORA);
    expect(decision.avisar).toBe(false);
    expect(decision.avisar ? '' : decision.motivo).toContain(motivo);
  });

  it('fuera de la ventana de 7 días (del clic a la venta, o de la venta a hoy) no se avisa', () => {
    const clicViejo = venta({ clic: { clickId: 'CLID-1', anuncioId: 'AD-1', fecha: new Date('2026-10-01T10:00:00Z') } });
    expect(decidirAviso(clicViejo, VENTA_EN, AHORA).avisar).toBe(false);
    expect(decidirAviso(venta(), VENTA_EN, new Date('2026-10-28T15:00:00Z')).avisar).toBe(false);
  });
});

describe('clicDeLaFicha', () => {
  it('lee el clic que guarda la ingesta en campanaOrigen', () => {
    expect(clicDeLaFicha({ campanaOrigen: { clickId: 'C', anuncioId: 'A', fecha: '2026-10-18T10:00:00.000Z' } }))
      .toEqual({ clickId: 'C', anuncioId: 'A', fecha: new Date('2026-10-18T10:00:00.000Z') });
    expect(clicDeLaFicha({ campanaOrigen: { clickId: null } })).toBeNull();
    expect(clicDeLaFicha(null)).toBeNull();
  });
});

describe('leerRespuesta', () => {
  it('200 con el evento recibido es ENVIADO; sin recibir, FALLIDO', () => {
    expect(leerRespuesta(200, { events_received: 1, fbtrace_id: 'T1' })).toEqual({ estado: 'ENVIADO', fbtraceId: 'T1' });
    expect(leerRespuesta(200, { events_received: 0 }).estado).toBe('FALLIDO');
  });

  it('un 5xx es INCIERTO: Meta pudo contarlo antes de fallar', () => {
    expect(leerRespuesta(503, null).estado).toBe('INCIERTO');
  });

  it('un límite de uso se reintenta; otro 4xx es un rechazo', () => {
    expect(leerRespuesta(429, {}).estado).toBe('REINTENTAR');
    expect(leerRespuesta(400, { error: { code: 4, message: 'Application request limit reached' } }).estado).toBe('REINTENTAR');
    expect(leerRespuesta(400, { error: { code: 100, message: 'Invalid parameter' } })).toEqual({
      estado: 'FALLIDO', motivo: 'Meta respondió 400 (código 100): Invalid parameter',
    });
  });
});
