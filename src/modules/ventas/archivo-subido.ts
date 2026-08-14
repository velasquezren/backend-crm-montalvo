/**
 * Lo que Multer entrega en `@UploadedFile()` al subir un comprobante de venta.
 */
export interface ArchivoSubido {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}
