/** Rechazos que requieren cambiar permisos, cuenta, destinatario o contenido. */
export const ERRORES_WHATSAPP_PERMANENTES = [
  10, 100, 190, 200, 368, 130497, 131026, 131031, 131042, 131047,
  132000, 132001, 132005, 132007, 132012, 132015, 132016, 133010,
];

export function permiteReintentarError(codigo?: number | null): boolean {
  return codigo == null || !ERRORES_WHATSAPP_PERMANENTES.includes(codigo);
}

/** Solo el código numérico viaja al cliente; nunca el mensaje crudo de Meta. */
export function codigoErrorWhatsapp(cuerpo: string): number | undefined {
  try {
    const datos: unknown = JSON.parse(cuerpo);
    if (!datos || typeof datos !== 'object' || !('error' in datos)) return undefined;
    const error = datos.error;
    if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
    return typeof error.code === 'number' && Number.isSafeInteger(error.code) ? error.code : undefined;
  } catch {
    return undefined;
  }
}
