/**
 * Lo que Multer entrega en `@UploadedFile()`, acotado a los campos que este
 * módulo usa. Se declara aquí en vez de instalar `@types/multer` solo para
 * cuatro propiedades.
 */
export interface ArchivoSubido {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}
