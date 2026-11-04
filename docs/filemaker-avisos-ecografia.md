# Ecografía: FileMaker publica y avisa por WhatsApp

Decisiones de René, 04/11/2026: la asistente envía la ecografía desde
FileMaker y el WhatsApp sale **en la misma pulsación**, a cualquier hora, con
una cuenta fija del CRM («FileMaker») como remitente. Quién pulsó queda en la
auditoría del CRM y en los campos `_envio` del registro de FileMaker.

El CRM sigue siendo el único emisor: FileMaker no habla con Meta. El envío es el
mismo código que el botón «Enviar aviso» de Resultados (`ResultadosService.entregar`):
revalida el informe en el portal, cruza la ficha, reserva contra el doble envío
(`AvisoResultado.informeId` único) y audita `RESULTADO_ENVIADO`.

## Recorrido

1. Botón de WhatsApp de la ecografía → guion `Print … 2` con parámetro `"PORTAL"`
   → genera el PDF → `ENVIAR PDF AL PORTAL` (archivo Ecografía, ServidorFM19).
2. `ENVIAR PDF AL PORTAL` sube y publica el PDF en Resultados
   (`POST /v1/integraciones/filemaker/informe`, referencia `FM-Ecografia-<RecordID>`).
3. Si su variable `$tokenCRM` tiene la credencial, pregunta al CRM a quién iría
   el aviso (`…/<informeId>/destino`) y se lo muestra a la asistente: nombre de
   la ficha del CRM, número y nombre de la ecografía. Solo si pulsa «Enviar» pide
   el aviso (`…/<informeId>/avisar`) con ese número en `telefonoConfirmado`.
   Base: `https://crm.107.175.132.15.nip.io/integraciones/filemaker/resultados`.
   Guion completo en texto: [filemaker/enviar-pdf-al-portal.txt](filemaker/enviar-pdf-al-portal.txt).
4. Llena `estado`, `fecha_envio`, `hora_envio`, `usu_envio` y `telefono_envio`
   y le dice a la asistente qué pasó.

Con `$tokenCRM` vacío el guion hace lo de antes (publicar) y además llena los
campos con `estado = PUBLICADO`; el aviso se manda desde Resultados del CRM.

## Contrato del CRM

```
POST /integraciones/filemaker/resultados/:informeId/avisar
Authorization: Bearer <FILEMAKER_AVISOS_TOKEN>
Content-Type: application/json

{ "usuario": "<Get ( AccountName )>", "telefonoConfirmado": "<lo que dio /destino>" }
```

`telefonoConfirmado` es opcional (un guion viejo no lo manda). Con él, si la
ficha tiene otro número que el confirmado, responde `NO_ENVIADO` («El número de
la ficha cambió después de la confirmación») y no envía. Vacío = la ficha no
tenía teléfono, solo usuario de WhatsApp.

### Antes de enviar: `…/destino`

```
POST /integraciones/filemaker/resultados/:informeId/destino
Authorization: Bearer <FILEMAKER_AVISOS_TOKEN>
```

Mismas comprobaciones que `avisar` (cuenta, línea, informe publicado y vigente,
ficha por PAC exacto, aviso previo) sin reservar ni enviar nada. Responde 200:

| `codigo` | `puedeEnviar` | Trae |
| --- | --- | --- |
| `LISTO` | `true` | `paciente` (nombre de la FICHA del CRM, para ver si el número es de otra persona), `telefono` (nulo si solo usuario de WhatsApp), `estudio` |
| `YA_ENVIADO` | `false` | `mensaje`, `telefono` y `enviadoEn` del aviso anterior. Un aviso FALLIDO no cuenta |
| `NO_ENVIADO` | `false` | `mensaje`: sin ficha, CI repetido, solo por CI, enlace vencido o no publicado. `sinFicha: true` si el paciente no tiene ficha (FileMaker ofrece crearla) |

### «Cambiar número»: `…/telefono`

```
POST /integraciones/filemaker/resultados/:informeId/telefono
Authorization: Bearer <FILEMAKER_AVISOS_TOKEN>
Content-Type: application/json

{ "usuario": "<Get ( AccountName )>", "telefono": "70012345" }
```

Corrige el teléfono de la ficha del paciente del informe (por PAC exacto) o, si
no tiene ficha, la crea con nombre y PAC del portal: lo mismo que «Corregir
teléfono» y «Crear ficha» de Resultados. `70012345` se entiende como Bolivia.
No envía nada. Responde 200 `{ actualizado: true, accion: TELEFONO_CORREGIDO |
FICHA_CREADA, paciente, telefono }` o `{ actualizado: false, mensaje }`: número
inválido, número de otra ficha (un familiar; no se toma), número de una ficha sin
PAC (hay que «Vincular» en el CRM, viendo el nombre), CI repetido o solo por CI.
Auditoría: `TELEFONO_DESDE_FILEMAKER` o `FICHA_DESDE_RESULTADOS` con
`usuarioFilemaker`.

Agregado el 04/11/2026 a pedido de René: el botón enviaba sin mostrar el número,
y un aviso que llega a un número equivocado no se puede reenviar (la reserva
única lo impide). La pregunta tiene tres botones: «Enviar», «Cambiar número»
(escribe el número, el CRM corrige la ficha y vuelve a preguntar) y «No enviar».
Sin ficha en el CRM ofrece «Escribir número» para crearla. El número se escribe
en `telefono_envio`; si el CRM no lo acepta, el campo vuelve a su valor.

Responde **200** también cuando no envía, para que el guion lea un solo JSON:

| `codigo` | `enviado` | Significado |
| --- | --- | --- |
| `ENVIADO` | `true` | Meta aceptó la plantilla y no la rechazó en los 5 s siguientes. `entregado: true` si además ya llegó al teléfono. `telefono` es el número de la ficha (nulo si solo tiene usuario de WhatsApp) |
| `YA_ENVIADO` | `false` | Ya tenía aviso (desde FileMaker o el CRM). Trae `enviadoEn` y `telefono` del anterior. No sale otro |
| `NO_ENVIADO` | `false` | `mensaje` explica: sin ficha, CI repetido, reconocido solo por CI, enlace vencido, no publicado, **Meta lo rechazó** (p. ej. 131026, número sin WhatsApp) o **Meta no confirmó a tiempo** |

**El CRM espera a Meta antes de contestar** (desde el 04/11/2026). La plantilla
sale a Meta en segundo plano, así que el registro del aviso no prueba que salió:
antes FileMaker anotaba ENVIADO aunque Meta lo rechazara después. Ahora el CRM
lee el mensaje hasta que Meta lo acepta (y espera 5 s más un rechazo, que llega
por el webhook) o lo rechaza, con un tope de 15 s; el guion corta a los 60 s.
La respuesta tarda unos 5 s. Un rechazo deja el aviso FALLIDO en la cola del CRM
con «Reintentar aviso», y volver a pulsar en FileMaker lo reenvía. Si Meta no
confirma en 15 s, responde `NO_ENVIADO` diciendo que pudo haber salido: volver a
pulsar devuelve `YA_ENVIADO`, nunca un segundo WhatsApp. Lógica en
`modules/resultados/confirmacion-aviso.ts`.

Desde FileMaker solo se avisa por **PAC exacto**. Si el CRM reconoce al
paciente solo por CI, responde `NO_ENVIADO`: en la pantalla del CRM la
asistente compara los dos nombres; en FileMaker no los ve.

Errores reales: `401` credencial, `400` informe o cuerpo inválido, `503`
integración apagada, cuenta FileMaker sin configurar, desactivada o sin la
línea, o portal caído. Límite: 30 llamadas por minuto.

Código: `modules/resultados/resultados-filemaker.controller.ts`,
`avisos-filemaker.guard.ts`, `ResultadosService.avisarDesdeFilemaker`,
`destinoParaFilemaker` y `cambiarTelefonoDesdeFilemaker`.
Pruebas: `resultados.integracion.spec.ts` («aviso pedido desde FileMaker»,
contra Postgres real) y `avisos-filemaker.guard.spec.ts`.

## Campos `_envio` del registro de FileMaker

| Resultado | `estado` | `fecha_envio`, `hora_envio`, `usu_envio` | `telefono_envio` |
| --- | --- | --- | --- |
| WhatsApp enviado | `ENVIADO` | ahora y quien pulsó | número usado por el CRM |
| Ya estaba enviado | `ENVIADO` | no cambian (se llenan si estaban vacíos) | número del aviso anterior |
| Solo publicado | `PUBLICADO` | ahora y quien pulsó | no cambia |
| Republicar uno ya `ENVIADO` | sigue `ENVIADO` | no cambian | no cambia |

`Eco.Intro.New` crea el registro con `estado = CREADO` y `telefono_envio` del
teléfono del paciente en FileMaker. Si otra persona tiene abierto el registro,
los campos no se guardan: el envío ya está hecho y el guion lo advierte.
Con el WhatsApp enviado (o ya enviado) el guion también llena `envio_pdf`,
`envio_pdf_hr` y `envio_pdf_usu` si estaban vacíos: es la marca que muestra
`lista_eco_envios` y la misma que pone a mano el botón `btn_enviado`.

Cada presentación de ecografía muestra en la cabecera, junto al botón de
WhatsApp, el texto combinado `WhatsApp: <<estado>> <<fecha_envio>>
<<hora_envio>> <<usu_envio>> <<telefono_envio>>` (blanco, negrita, 9 pt).
Puesto el 04/11 en Obst 15-40, Obst 15-40 Gemelar, eco.Abdominal y eco.renal;
René completa las demás.

## Activación (la hace René; producción)

1. Desplegar el backend del CRM con este cambio y arrancar su `dist` en local
   antes (`PORT=3009 NODE_ENV=development node dist/main.js`).
2. En el CRM, crear el usuario **FileMaker**, rol ASISTENTE, con una contraseña
   larga que nadie use, y darle acceso a la línea de `RESULTADOS_LINEA_ID`
   (Recepción). Su id va en `RESULTADOS_FILEMAKER_USUARIO_ID`.
3. En `/opt/crm-backend/.env`: `FILEMAKER_AVISOS_TOKEN` (`openssl rand -hex 32`,
   propio), `FILEMAKER_AVISOS_ACTIVO=on`, `RESULTADOS_FILEMAKER_USUARIO_ID`.
   Reiniciar `crm_backend.service` y esperar `/health` en 200.
4. En FileMaker, guion `ENVIAR PDF AL PORTAL`, paso
   `Establecer variable [ $tokenCRM ]`: pegar la credencial entre comillas.
5. Probar con la paciente de prueba (PAC sintético con el número de René): la
   primera pulsación dice «WhatsApp enviado al …»; la segunda, «Ya estaba enviado».

Apagar: `FILEMAKER_AVISOS_ACTIVO=off` (FileMaker sigue publicando y avisa que no
pudo pedir el WhatsApp) o vaciar `$tokenCRM` (vuelve exactamente al flujo
manual). Los guiones anteriores quedaron como `ENVIAR PDF AL PORTAL Copia` y
`Print mama.nueva.ver Copia 2 Copia`.

### Confirmación del número: orden de puesta en marcha

1. Desplegar el backend del CRM con `…/destino` y `…/telefono` (antes de esto
   las rutas dan 404). `…/destino` está desplegada desde `97f700c`.
2. Recién entonces pegar en FileMaker la versión del guion con la pregunta
   ([texto](filemaker/enviar-pdf-al-portal.txt)). Pegarla antes deja el botón
   sin enviar: diría «no se pudo consultar al CRM» en cada ecografía.
3. Probar con la ficha de prueba: la pregunta muestra nombre y número; «No
   enviar» deja `PUBLICADO`; «Enviar» deja `ENVIADO`; «Cambiar número» vuelve a
   preguntar con el número nuevo.

Estado al 04/11: en FileMaker está pegada la versión con la pregunta (Enviar /
No enviar). La de «Cambiar número» se pega cuando esté desplegado `…/telefono`.

## Revisión de los guiones de CARPETA ECOGRAFIA (04/11/2026)

Los 11 guiones `Print … 2` generan el PDF en `Escritorio/digital/<PAC>-<Nombre>.pdf`
y, con `"PORTAL"`, llaman a `ENVIAR PDF AL PORTAL`. Corregido en FileMaker:

- `ENVIAR PDF AL PORTAL` verificaba sin certificados SSL (ahora sí: los dos
  servidores tienen certificado válido), mostraba el JSON crudo de respuesta a
  la asistente y no tenía tiempo máximo de espera.
- `Print mama.nueva.ver Copia 2` buscaba con `$$PK` dentro de una petición de
  búsqueda guardada; ahora usa `Establecer campo` en modo Buscar, como cadera.

Corregido también el 04/11, a pedido de René:

- `MANDAR API` (prueba anterior rota, con la credencial del portal escrita)
  quedó eliminado; nadie lo llamaba.
- `imp eco cadera pediatrica Digital 2` guardaba el PDF dos veces en la misma
  ruta y solo comprobaba el error del primero; ahora lo guarda una vez.
- La credencial del CRM está en `$tokenCRM` de `ENVIAR PDF AL PORTAL`.

Credenciales en los guiones: se quedan ahí a propósito. Solo las ven las cuentas
con acceso total y la de dirección (`dir`); los demás conjuntos de privilegios
(`asi`, `rec`, `med`, `enf`, `caj`, `adm`, `inv`, `lab`, `coo`) tienen los
guiones como «solo ejecutables». Esos mismos conjuntos leen todos los registros
de todas las tablas, así que una tabla de configuración las expondría a cientos
de cuentas salvo que se rehagan nueve conjuntos de privilegios.

Sin cambiar, a decidir:

- Rotar la credencial del portal (`FILEMAKER_API_TOKEN`): estuvo escrita en
  `MANDAR API`. La del CRM se pegó en un chat al pasarla; conviene rotarla también.
- No se manda `medico`: el portal tiene una sola cuenta de médico y con otro
  correo la subida fallaría (404) y no se publicaría. Hace falta crear antes las
  cuentas de los médicos en el portal.
- La referencia es `Get ( RecordID )`. Es estable mientras no se reimporte la
  tabla; cambiarla a `Ecografia::pk` duplicaría los ~225 informes ya enviados.
- `Print Ginecologico SAVE 2` y `Print Obstet 15-40 SAVE 2` escriben `"Si"` en
  `imp.con imagen` cada vez que imprimen.
- Si la ecografía no tiene datos medidos, el guion muestra su aviso y después
  «No se puede / Error de FileMaker:» vacío; no envía nada.
- Falta `Require ip` en la ruta de FileMaker de Resultados en Apache.
- Respaldos que conservan la versión anterior (y la credencial vieja del
  portal): `ENVIAR PDF AL PORTAL Copia` y `Print mama.nueva.ver Copia 2 Copia`.
  Borrarlos después de la prueba con el número de René.
