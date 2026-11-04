import { EstadoEnvioLeido, esperarConfirmacion, motivoAvisoRechazado } from './confirmacion-aviso';

/* Un reloj de mentira: cada lectura avanza el tiempo lo que se durmió. */
function conFilas(filas: Array<EstadoEnvioLeido | null>) {
  let t = 0;
  let i = 0;
  const reloj = { ahora: () => t, dormir: async (ms: number) => { t += ms; } };
  const leer = async () => filas[Math.min(i++, filas.length - 1)];
  return { leer, reloj, lecturas: () => i };
}
const ESPERA = { plazoMs: 15_000, graciaMs: 5_000, cadaMs: 500 };
const registrado: EstadoEnvioLeido = { estadoEnvio: 'ENVIADO', whatsappMsgId: null, codigoErrorEnvio: null };
const aceptado: EstadoEnvioLeido = { ...registrado, whatsappMsgId: 'wamid.x' };

describe('qué contestó Meta al aviso de FileMaker', () => {
  it('aceptado y sin rechazo durante la gracia: salió', async () => {
    const { leer, reloj } = conFilas([registrado, aceptado]);
    await expect(esperarConfirmacion(leer, ESPERA, reloj)).resolves.toEqual({ tipo: 'ACEPTADO' });
  });

  it('el 131026 llega por el webhook después de aceptarlo: es un rechazo', async () => {
    const { leer, reloj } = conFilas([aceptado, aceptado, aceptado, { ...aceptado, estadoEnvio: 'FALLIDO', codigoErrorEnvio: 131026 }]);
    await expect(esperarConfirmacion(leer, ESPERA, reloj)).resolves.toEqual({ tipo: 'RECHAZADO', codigo: 131026 });
  });

  it('entregado corta la espera enseguida', async () => {
    const { leer, reloj, lecturas } = conFilas([{ ...aceptado, estadoEnvio: 'ENTREGADO' }]);
    await expect(esperarConfirmacion(leer, ESPERA, reloj)).resolves.toEqual({ tipo: 'ENTREGADO' });
    expect(lecturas()).toBe(1);
  });

  it('sin respuesta de Meta en el plazo: no se sabe, aunque esté INCIERTO', async () => {
    const { leer, reloj } = conFilas([registrado, { ...registrado, estadoEnvio: 'INCIERTO' }]);
    await expect(esperarConfirmacion(leer, ESPERA, reloj)).resolves.toEqual({ tipo: 'SIN_CONFIRMAR' });
  });

  it('el plazo manda sobre la gracia: aceptado al final del plazo cuenta como salido', async () => {
    const filas = [...Array(29).fill(registrado), aceptado];
    const { leer, reloj } = conFilas(filas);
    await expect(esperarConfirmacion(leer, ESPERA, reloj)).resolves.toEqual({ tipo: 'ACEPTADO' });
  });

  it('el motivo dice qué hacer y que el informe sigue publicado', () => {
    expect(motivoAvisoRechazado(131026)).toMatch(/puede no tener WhatsApp.*sigue publicado/);
    expect(motivoAvisoRechazado(132001)).toMatch(/rechazó el aviso \(código 132001\)/);
    expect(motivoAvisoRechazado(null)).toMatch(/^WhatsApp rechazó el aviso\. /);
  });
});
