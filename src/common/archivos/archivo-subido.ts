/**
 * Lo que Multer entrega en `@UploadedFile()`, acotado a los campos que usa
 * este backend. Se declara aquí en vez de instalar `@types/multer` solo para
 * cuatro propiedades.
 *
 * Es un tipo de transporte, común a todo endpoint que reciba un archivo
 * (comprobantes de venta, Mi Memoria, planilla de comisiones): había una copia
 * por módulo. El `ValidationPipe` no ve el archivo, así que cada service sigue
 * validando `mimetype` y `size` antes de usarlo.
 */
export interface ArchivoSubido {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}
