import { Matches, MaxLength } from 'class-validator';

/**
 * Clave del objeto en R2 que se quiere descargar.
 *
 * **El patrón no es cosmético: sin él la clave se escapa del bucket.** La clave
 * se concatena a la URL base (`https://<cuenta>.r2.cloudflarestorage.com/<bucket>/<clave>`)
 * y `aws4fetch` la pasa por `new URL()`, que normaliza los `..`:
 *
 *   clave = "../otro-bucket/privado"
 *   → https://<cuenta>.r2.cloudflarestorage.com/otro-bucket/privado
 *
 * Es decir, cualquier objeto de cualquier bucket de la cuenta, firmado con
 * nuestras credenciales. Comprobado ejecutando `new URL()` con esa entrada.
 *
 * Por eso se acepta solo lo que el propio sistema genera: `wa/<conv>/<msg>`
 * para la media entrante y `memoria/…` para lo que sube la agente. Sin puntos,
 * sin `%`, sin barras iniciales.
 */
export class DescargarMediaDto {
  @MaxLength(300)
  @Matches(/^(wa|memoria)\/[A-Za-z0-9_\-/]+$/, {
    message: 'La clave no tiene un formato válido',
  })
  key!: string;
}
