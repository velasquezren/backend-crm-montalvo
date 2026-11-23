# Archivos subidos: `ArchivoSubido`, no `any`

> Parte de la skill `crm-backend-module`: lee antes su [índice](../SKILL.md).

Los endpoints que reciben un archivo (importar planilla de comisiones, recursos de memoria del
agente) usan `FileInterceptor` de Multer. Como el `@UploadedFile()` no viene tipado y no vale la
pena instalar `@types/multer` por cuatro propiedades, existe la interfaz `ArchivoSubido`
(`common/archivos/archivo-subido.ts`): `originalname`, `mimetype`, `size`, `buffer`. Una sola
declaración para todo el backend: hubo una copia por módulo (Ventas, Memoria y el controller de
Planilla) hasta el 2026-09-28.

```ts
@Post('importar')
@Roles('SUPER_ADMIN')
@UseInterceptors(FileInterceptor('archivo'))
importar(@UploadedFile() archivo: ArchivoSubido, @CurrentUser() usuario: UsuarioJwt) { … }
```

Valida siempre `mimetype` y `size` en el service antes de parsear: el `ValidationPipe` no ve el
archivo, así que un DTO no te protege aquí.
