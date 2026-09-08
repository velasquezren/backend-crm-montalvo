/**
 * Dónde están los `.xlsx` reales de la clínica que verifican el cálculo.
 *
 * Esos archivos **no se versionan**: llevan nombres de pacientes y las cifras
 * que se pagaron. Viven en el disco de quien los tiene y cada máquina los pone
 * donde quiere, así que la ruta se configura por entorno en vez de estar
 * cableada.
 *
 * Estuvo cableada a `/Users/macmini2024/Documents/CARPETA RENE/Excels`, la ruta
 * de una de las dos máquinas. En la otra las suites que dependen de ella no
 * fallaban: **se omitían en silencio y salían en verde**, que es peor —
 * `verificacion-diciembre.integracion.spec.ts` es la única prueba que compara
 * el motor contra lo que administración pagó de verdad en diciembre de 2025, y
 * pasaba sin comprobar nada. Ver `docs/ESTADO_ACTUAL.md`.
 *
 * Se declara en `.env.example`. Si no está, las suites siguen omitiéndose —no
 * todo el mundo que clone el repo tendrá la carpeta— pero avisando por consola.
 */
export const CARPETA_EXCELS_2025 = process.env.CRM_EXCELS_2025_DIR ?? '';
export const CARPETA_EXCELS_2026 = process.env.CRM_EXCELS_2026_DIR ?? '';

const yaAvisado = new Set<string>();

/** Un aviso por suite, para que "0 comprobaciones" no se confunda con "todo bien". */
export function avisarCarpetaAusente(suite: string, variable: string): void {
  if (yaAvisado.has(suite)) return; // un `it.each` de seis meses no debe gritar seis veces
  yaAvisado.add(suite);
  console.warn(
    `[${suite}] OMITIDA: no se encontraron los Excel reales. ` +
      `Define ${variable} con la carpeta que los contiene (ver .env.example). ` +
      `Los asserts de esta suite NO se ejecutaron.`,
  );
}
