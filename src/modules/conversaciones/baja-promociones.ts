/**
 * «No me interesa»: el botón que da de baja de las promociones.
 *
 * Solo cuenta si llega como TOQUE de un botón de plantilla, nunca como texto
 * escrito: una paciente que escribe «quiero bajar de peso» o «me dio de baja
 * el seguro» no está pidiendo que no le escriban. Quien decide que es un toque
 * es el webhook (`extraerRespuestaBoton`); aquí solo se reconoce el texto.
 *
 * `baja` es el botón de `reactivacion_paciente`, la plantilla anterior.
 */
const TEXTOS_DE_BAJA = new Set(['no me interesa', 'baja']);

function normalizado(texto: string): string {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

export function esPedidoDeBaja(textoDelBoton: string): boolean {
  return TEXTOS_DE_BAJA.has(normalizado(textoDelBoton));
}

/**
 * Lo que se le contesta. Confirmar no es un extra: sin respuesta, quien tocó
 * el botón no sabe si funcionó y lo que le queda es bloquear el número.
 * Mismo voseo que las plantillas de Ventas.
 */
export const CONFIRMACION_BAJA =
  'Listo, no te enviaremos más promociones. Si necesitas algo de la clínica, escríbenos por aquí cuando quieras.';
