import { codigoErrorWhatsapp, permiteReintentarError } from './error-envio';
import { datosSegunResultado } from '../../modules/conversaciones/despachador-saliente.service';

describe('rechazos de Meta', () => {
  it('extrae solo el código, incluso si Meta incluye texto o datos sensibles', () => {
    expect(codigoErrorWhatsapp('{"error":{"code":130497,"message":"dato externo"}}')).toBe(130497);
    expect(codigoErrorWhatsapp('{"error":{"code":"130497"}}')).toBeUndefined();
    expect(codigoErrorWhatsapp('<html>error</html>')).toBeUndefined();
  });
  it('el rechazo inmediato por país no se agenda, ni siquiera en un reintento', () => {
    for (const agendar of [true, false]) {
      expect(datosSegunResultado({ estado: 'NO_SALIO', motivo: 'Meta 403', codigoError: 130497 }, agendar))
        .toMatchObject({ estadoEnvio: 'FALLIDO', codigoErrorEnvio: 130497, proximoIntento: null });
    }
    expect(permiteReintentarError(131000)).toBe(true);
  });
});
