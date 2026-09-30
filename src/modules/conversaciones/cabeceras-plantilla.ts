import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Las imágenes de cabecera de las plantillas que el chat manda por su cuenta.
 *
 * Una plantilla aprobada con cabecera de imagen la exige en CADA envío: sin
 * ella Meta rechaza el mensaje entero. La imagen se elige al diseñar la
 * plantilla, no al enviarla, así que vive versionada junto al código:
 *
 *     assets/cabeceras/<nombre de la plantilla>.jpg
 *
 * El nombre del archivo ES el de la plantilla. Añadir otra plantilla con
 * imagen es dejar su archivo aquí; sin tabla ni variable nueva.
 *
 * Meta descarga la imagen desde internet, por eso se sirve en una ruta pública
 * (`CabecerasPlantillaController`) bajo `CRM_URL_PUBLICA`.
 */
export const DIRECTORIO_CABECERAS = join(process.cwd(), 'assets', 'cabeceras');

/**
 * Lo que Meta admite como nombre de plantilla. Es también la única defensa que
 * necesita la ruta pública: sin `/` ni `.`, un nombre no puede salir de la
 * carpeta de cabeceras.
 */
const NOMBRE_DE_PLANTILLA = /^[a-z0-9_]{1,512}$/;

/** ¿Hay imagen de cabecera para esta plantilla? */
export function tieneCabecera(plantilla: string): boolean {
  return NOMBRE_DE_PLANTILLA.test(plantilla) && existsSync(join(DIRECTORIO_CABECERAS, `${plantilla}.jpg`));
}

/**
 * La URL pública de su imagen, o null si no la tiene o el servidor no sabe su
 * propia dirección pública (entonces la plantilla no se ofrece como enviable,
 * en vez de salir y rebotar en Meta).
 */
export function urlDeCabecera(plantilla: string, base: string | undefined): string | null {
  const origen = base?.trim().replace(/\/+$/, '');
  if (!origen || !tieneCabecera(plantilla)) return null;
  return `${origen}/publico/cabeceras/${plantilla}.jpg`;
}
