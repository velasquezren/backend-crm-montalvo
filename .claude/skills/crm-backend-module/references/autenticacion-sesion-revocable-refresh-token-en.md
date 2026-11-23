# Autenticación: sesión revocable + refresh token en cookie cross-site

> Parte de la skill `crm-backend-module`: lee antes su [índice](../SKILL.md).

`AuthService.login()` firma dos JWT distintos. El `access_token` viaja en el
header `Authorization` de cada petición y por eso lleva payload mínimo (`sub`,
`email`, `nombre`, `rol`, `type`, `sid`, `versionSesion`) — la foto del usuario **nunca** va ahí: en base64
llegó a pesar ~2,7 MB y disparaba 431 (Request Header Fields Too Large) en
todo lo autenticado; se devuelve aparte, en el cuerpo de la respuesta. El
`refresh_token` dura 30 días **absolutos desde el login** — no rota ni desliza
con el uso, `refresh()` solo emite un `access_token` nuevo — y viaja en una
cookie `HttpOnly` que arma `opcionesCookieRefresh()` (`auth.controller.ts`);
el controller lo excluye del JSON. Access dura 8 horas y además queda limitado
por la expiración absoluta de `SesionUsuario`.

**Por qué la cookie depende de `NODE_ENV`:** el frontend vive en Vercel y esta
API en otro dominio — es cross-site, no cross-origin del mismo sitio. Con
`SameSite=Lax` el navegador nunca manda la cookie en el POST a `/auth/refresh`
(`Lax` solo la deja viajar en navegaciones de nivel superior), así que el
refresco silencioso queda muerto en producción aunque el endpoint esté bien.
Cross-site exige `SameSite=None`, que a su vez exige `Secure`; en local
(mismo sitio) basta `Lax`.

**`res.cookie()` y `res.clearCookie()` tienen que compartir las mismas
opciones** (`path`, `sameSite`, `secure`): el navegador solo borra una cookie
si esos atributos coinciden byte a byte con los que la crearon. Por eso
`opcionesCookieRefresh()` es una función compartida por login y logout, no dos
literales copiados — si divergen, `logout` responde 204 igual pero la cookie
sigue viva.

**En `refresh()`, solo un problema real de credenciales responde 401.** El
`try` cubre nada más la verificación de la firma; releer al usuario en la
base va fuera de ese `try` (o, si falla por algo que no es "no existe", el
error se relanza tal cual, sin convertirlo en 401). Envolver también la
consulta convertía un parpadeo transitorio de Postgres en "token inválido" —
el interceptor del frontend reacciona a cualquier 401 de `/auth/refresh`
cerrando la sesión, así que una caída de un segundo en la base echaba a
**todas** las agentes conectadas a la vez, en vez de dejar que el fetch se
reintentara con un 500.

**`POST /auth/logout` elimina `SesionUsuario` y borra la cookie correspondiente.**
Si recibe Bearer, revoca ese login y conserva una cookie de otro login; sin Bearer
usa la cookie. Otros dispositivos conservan sus sesiones. Si PostgreSQL falla
devuelve 5xx sin afirmar revocación. Refresh, cuando recibe Bearer, exige que
ambas credenciales pertenezcan a la misma sesión, aunque el access haya expirado.
Los endpoints
`login`, `refresh` y `logout` siguen siendo `@Public()`: logout valida la firma y
estructura incluso con access expirado, sin depender del guard.

`AuthService.validarAcceso()` comparte la validación de HTTP y del handshake:
firma HS256, estructura y tipo access, expiración, sesión existente del usuario,
usuario activo, rol y `versionSesion` actuales. No carga la foto para autorizar.
Cambiar contraseña, rol o activo incrementa `Usuario.versionSesion` en el mismo
UPDATE (también si se vuelve a enviar el mismo rol/activo); reactivar no revive
tokens antiguos. Antes de emitir eventos el gateway comprueba todas las sesiones
en una consulta, y desconecta cada socket cuando expira su access. Un fallo de
base impide la difusión pero no se convierte en credencial inválida.

Los JWT anteriores sin tipo/ID/versión requieren nuevo login. Aplicar la migración
aditiva antes de la aplicación. El rollback de aplicación puede conservar tabla
y columna; no retirar una migración ya aplicada ni sus datos para volver al build anterior.
