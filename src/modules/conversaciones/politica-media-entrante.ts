import { ErrorMedia } from '../../common/fiabilidad/error-media';

export const MAX_INTENTOS_MEDIA = 8;
export const PLAZO_MEDIA_MS = 7 * 24 * 60 * 60 * 1000;
export const TIEMPO_MEDIA_MS = 60_000;
const ESPERAS_MINUTOS = [1, 5, 15, 60, 180, 360, 720];

export function resultadoFalloMedia(error: ErrorMedia, intentos: number, creada: Date, ahora: Date) {
  if (error.categoria === 'PERMANENTE') {
    return { estado: 'DESCARTADO', ultimoError: error.codigo, proximoIntento: null };
  }
  const limite = creada.getTime() + PLAZO_MEDIA_MS;
  if (ahora.getTime() >= limite || intentos >= MAX_INTENTOS_MEDIA) {
    return {
      estado: 'AGOTADO',
      ultimoError: ahora.getTime() >= limite ? 'PLAZO_AGOTADO' : `INTENTOS_AGOTADOS:${error.codigo}`,
      proximoIntento: null,
    };
  }
  const minutos = error.categoria === 'CONFIGURACION' ? 60 : ESPERAS_MINUTOS[Math.max(0, intentos - 1)]!;
  return {
    estado: 'REINTENTABLE',
    ultimoError: error.codigo,
    proximoIntento: new Date(Math.min(limite, ahora.getTime() + minutos * 60_000)),
  };
}
