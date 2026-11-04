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
3. Si su variable `$tokenCRM` tiene la credencial, pide el aviso al CRM:
   `POST https://crm.107.175.132.15.nip.io/integraciones/filemaker/resultados/<informeId>/avisar`.
4. Llena `estado`, `fecha_envio`, `hora_envio`, `usu_envio` y `telefono_envio`
   y le dice a la asistente qué pasó.

Con `$tokenCRM` vacío el guion hace lo de antes (publicar) y además llena los
campos con `estado = PUBLICADO`; el aviso se manda desde Resultados del CRM.

## Contrato del CRM

```
POST /integraciones/filemaker/resultados/:informeId/avisar
Authorization: Bearer <FILEMAKER_AVISOS_TOKEN>
Content-Type: application/json

{ "usuario": "<Get ( AccountName )>" }
```

Responde **200** también cuando no envía, para que el guion lea un solo JSON:

| `codigo` | `enviado` | Significado |
| --- | --- | --- |
| `ENVIADO` | `true` | Salió la plantilla. `telefono` es el número de la ficha (nulo si solo tiene usuario de WhatsApp) |
| `YA_ENVIADO` | `false` | Ya tenía aviso (desde FileMaker o el CRM). Trae `enviadoEn` y `telefono` del anterior. No sale otro |
| `NO_ENVIADO` | `false` | `mensaje` explica: sin ficha, CI repetido, reconocido solo por CI, enlace vencido o no publicado |

Desde FileMaker solo se avisa por **PAC exacto**. Si el CRM reconoce al
paciente solo por CI, responde `NO_ENVIADO`: en la pantalla del CRM la
asistente compara los dos nombres; en FileMaker no los ve.

Errores reales: `401` credencial, `400` informe o cuerpo inválido, `503`
integración apagada, cuenta FileMaker sin configurar, desactivada o sin la
línea, o portal caído. Límite: 30 llamadas por minuto.

Código: `modules/resultados/resultados-filemaker.controller.ts`,
`avisos-filemaker.guard.ts`, `ResultadosService.avisarDesdeFilemaker`.
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
`envio_pdf`, `envio_pdf_hr` y `envio_pdf_usu` (botón `btn_enviado` de
`lista_eco_envios`) no se tocan.

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

## Revisión de los guiones de CARPETA ECOGRAFIA (04/11/2026)

Los 11 guiones `Print … 2` generan el PDF en `Escritorio/digital/<PAC>-<Nombre>.pdf`
y, con `"PORTAL"`, llaman a `ENVIAR PDF AL PORTAL`. Corregido en FileMaker:

- `ENVIAR PDF AL PORTAL` verificaba sin certificados SSL (ahora sí: los dos
  servidores tienen certificado válido), mostraba el JSON crudo de respuesta a
  la asistente y no tenía tiempo máximo de espera.
- `Print mama.nueva.ver Copia 2` buscaba con `$$PK` dentro de una petición de
  búsqueda guardada; ahora usa `Establecer campo` en modo Buscar, como cadera.

Sin cambiar, a decidir:

- La credencial del portal está escrita en `ENVIAR PDF AL PORTAL` y también en
  `MANDAR API`, un guion de prueba anterior que no funciona (cálculos comentados,
  presentación vacía) y nadie llama. Conviene borrarlo y rotar la credencial.
- La referencia es `Get ( RecordID )`. Es estable mientras no se reimporte la
  tabla; cambiarla a `Ecografia::pk` duplicaría los ~225 informes ya enviados.
- No se manda `medico`: todos los informes caen en `FILEMAKER_MEDICO_POR_DEFECTO`.
- `imp eco cadera pediatrica Digital 2` guarda el PDF dos veces seguidas en la
  misma ruta; solo comprueba el error del primero.
- `Print Ginecologico SAVE 2` y `Print Obstet 15-40 SAVE 2` escriben `"Si"` en
  `imp.con imagen` cada vez que imprimen.
- Si la ecografía no tiene datos medidos, el guion muestra su aviso y después
  «No se puede / Error de FileMaker:» vacío; no envía nada.
- Falta `Require ip` en la ruta de FileMaker de Resultados en Apache.
