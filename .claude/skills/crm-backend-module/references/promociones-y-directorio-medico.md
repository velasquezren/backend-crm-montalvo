# Promociones y directorio médico (2026-10-05)

> Parte de la skill `crm-backend-module`: lee antes su [índice](../SKILL.md).

Diseño en [promociones y directorio](../../../../docs/promociones-y-directorio.md). El CRM es la
única fuente de lo que la clínica ofrece y de quién atiende; la landing lo lee por `/publico/*`.

- **`modules/promociones` y `modules/directorio` son dueños únicos de sus tablas**; leen
  `Lead`/`Venta` (atribución) y `Medico` (enlace con FileMaker) sin escribirlos.
- **El ciclo de vida vive en `TRANSICIONES`** (`modules/promociones/promocion-reglas.ts`): la
  agente envía, un ADMIN publica/devuelve/pausa/archiva. Cada transición bloquea la fila
  (`FOR NO KEY UPDATE`) y escribe su `AuditLog` en la MISMA transacción. Lo que se publica pasa
  por `faltantesParaPublicar` al enviar Y al publicar, y la base lo sostiene con `CHECK`.
- **Bloqueo optimista con `version`** en promociones y fichas: el cliente manda la versión que
  leyó; si otra persona guardó, 409. No sustituyas esto por «el último gana».
- **«Visible» se define una vez** (`wherePublica`): publicada, vigente HOY en La Paz
  (`fechaCivilClinica`, columnas `@db.Date`) y en ese canal. Las imágenes públicas pasan por el
  mismo filtro: un banner de un borrador no se sirve aunque se conozca su id.
- **Imágenes públicas**: se validan por sus bytes (`common/storage/imagen-publica.ts`, sin fiarse
  del `mimetype`), van a R2 con un id nuevo por imagen y la API las sirve con
  `Cache-Control: immutable` y CORP `cross-origin`. El archivo anterior se borra de R2 DESPUÉS de
  guardar el nuevo, en segundo plano. No uses URL firmadas para lo público: caducan y la landing
  y Meta las guardan en caché.
- **Lo público nunca lleva** id interno, versión, autor, anuncios, resultados, código de
  FileMaker ni claves de R2. Las pruebas de integración lo comprueban campo por campo.
