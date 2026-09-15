# F06 — Revisión de la recepción de WhatsApp

> Diagnóstico histórico aceptado. F06-R1 se implementó posteriormente:
> [contrato y regresiones PostgreSQL](auditoria-f06-r1.md). F06-R2 sigue abierto.
> El reproductor actual conserva únicamente los dos escenarios de F06-R2;
> los resultados de cuatro casos citados aquí corresponden a la auditoría inicial.

14 de septiembre de 2026. Backend `c793a33`; frontend de referencia `2af3575`.
Ambos sincronizados con sus upstream al comenzar. Auditoría local, sin cambios
funcionales, migraciones, consultas a producción ni despliegue.

## Resultado

**F06 sigue abierto, pero el diagnóstico anterior quedó desactualizado.** Desde
`8ef88c1`, el controlador espera la persistencia antes de confirmar el webhook.
Lo pendiente es recuperar efectos incompletos, incluso cuando el mensaje existe.

| Prioridad | Hallazgo abierto | Evidencia local |
| --- | --- | --- |
| Alta · F06-R1 | Adjunto perdido tras un fallo transitorio o reinicio; no se conserva su identificador de origen para recuperarlo. | Servicios reales con dependencias simuladas: `mediaKey` permanece `null` tras repetir el mensaje. |
| Media · F06-R2 | Primer contacto sin lead si falla su INSERT o el mensaje después de crear la conversación. | Dos reproducciones: el mensaje se conserva/recupera y quedan cero leads. |

Son modos de fallo reproducidos localmente; **no acreditan incidentes ni su
frecuencia en producción**. La prioridad refleja contenido de la paciente
inaccesible y oportunidades ausentes del seguimiento comercial.

## Garantías actuales

- `recibir()` espera `procesarWebhook()` antes del HTTP 200.
- Los fallos se aíslan por elemento; el resto del lote continúa y se responde
  503 si hubo fallos de persistencia.
- Un receptor desconocido se descarta con 200; un error al consultar la línea
  conserva el 503. Mantener la distinción introducida en `ead8c16`.
- Crear el mensaje y actualizar el inbox comparten transacción.
- Un reenvío secuencial del mismo `whatsappMsgId` devuelve el mensaje existente
  sin otro mensaje ni aviso. El esquema tiene índice único; esta pasada no
  prueba carreras de PostgreSQL.

Referencias: [controlador](../src/modules/conversaciones/webhooks/whatsapp-webhook.controller.ts),
[suite del controlador](../src/modules/conversaciones/webhooks/whatsapp-webhook.controller.spec.ts),
[ingesta](../src/modules/conversaciones/ingesta-whatsapp.service.ts),
[esquema](../prisma/schema.prisma).

## F06-R1 — La deduplicación impide recuperar el adjunto

1. La ingesta guarda tipo, MIME y nombre en `Mensaje`. El `mediaId` de Meta
   permanece solo en el argumento en memoria.
2. Dispara `MediaEntranteService.traer()` mediante `enSegundoPlano`.
3. Si obtener URL, descargar, subir a R2 o guardar la clave falla, `traer()`
   captura el error o retorna sin resultado. El webhook puede confirmar 200.
4. Repetir el mensaje retorna por `whatsappMsgId` antes de la descarga. Después
   de un reinicio tampoco hay un trabajo persistido que retomar.

La reproducción hace fallar la primera obtención de URL. La segunda llamada al
doble funcionaría, pero nunca ocurre: `mediaKey` permanece `null`. El vacío de
recuperación también existe si R2 está deshabilitado al recibir.

Referencias: [media entrante](../src/modules/conversaciones/media-entrante.service.ts),
[tareas de fondo](../src/common/fiabilidad/en-segundo-plano.ts).

**Entrega propuesta:** persistir referencia de media y trabajo pendiente junto
al mensaje; reclamación exclusiva, concurrencia acotada y reintentos. Conservar
la clave determinista `wa/<conversacionId>/<mensajeId>`. Separar configuración
incompleta, fallo transitorio y descarte permanente, como tamaño excesivo.
Recuperar tras reiniciar sin necesitar otro webhook.

## F06-R2 — Crear el chat no garantiza crear el lead

La conversación se crea antes de la transacción del mensaje. El lead se crea
después y solo si `esNueva` es verdadero. Dos cortes reproducidos:

- **Falla el INSERT del lead:** se captura y se conserva el aviso a la agente,
  lo cual es correcto. No queda trabajo pendiente y repetir el mensaje sale
  por deduplicación sin volver al INSERT.
- **Falla la transacción del mensaje:** la conversación ya existe. El primer
  intento rechaza; el segundo guarda el mensaje, pero `esNueva = false` omite
  el lead aunque nunca se haya creado uno.

503 + reenvío puede recuperar el texto y dejar incompleto el primer contacto.

**Entrega propuesta:** identidad persistente del alta de primer contacto y
estado atómico o recuperable. Conservar varios leads por paciente y las líneas
no comerciales sin autoalta. No cambiar `esNueva` por `findFirst → create` sin
exclusión: reabriría el duplicado bajo concurrencia que motivó la regla actual.

## Guardar y repetir el webhook entero no basta

Un worker que vuelve a llamar a la ingesta tras guardar `Mensaje` retorna por
`whatsappMsgId` y conserva estos huecos. Hay que distinguir mensaje persistido
de efectos terminados. Además, `esNueva` no sobrevive al primer intento.

Push y acuses automáticos también se disparan sin tarea durable de recepción.
Se confirmó por lectura, **sin reproducir aquí un reinicio en ese punto**.
Reproducir todos los efectos en cada duplicado podría repetir avisos y respuestas
automáticas. Se mantiene la decisión de no reenviar salientes `INCIERTO`.
Los avisos de plataforma y `statuses` se esperan en el controlador, pero esta
pasada no demuestra entrega completa extremo a extremo de todos sus efectos.

## Reproducción y validación

Desde la raíz del backend, con las dependencias instaladas:

```bash
npm run build
npm test -- --runInBand
node --test docs/auditoria-f06/recepcion.repro.cjs
```

| Comprobación | Resultado observado |
| --- | --- |
| Build con `check:skills`, compilación y `check:build` | Correcto |
| Suite unitaria habitual | 33 suites, 516 pruebas aprobadas |
| Reproductor de defectos abiertos | 4 casos: 1 control aprobado, 3 fallos esperados; exit 1 |

El [reproductor](auditoria-f06/recepcion.repro.cjs) ejecuta los servicios
compilados con dobles de persistencia, red y notificaciones. Sus aserciones
exigen recuperación y fallan en el código auditado. Está fuera de `src/` y de
la suite habitual: **no contarlo como regresiones aprobadas**. Cuando se corrija,
llevar estos escenarios a regresión y añadir integración con PostgreSQL real.

No se ejecutaron integraciones con PostgreSQL, Meta/R2 reales ni navegador.
No se modificaron lógica de negocio o esquema.

## Criterios para cerrar la siguiente entrega

1. Adjunto recuperado tras reconstruir el servicio/proceso, sin nuevo webhook
   y conservando su referencia de origen.
2. Fallos antes/después del mensaje: un lead de primer contacto, conservando
   otras oportunidades y el aislamiento por línea.
3. Dos workers y reenvíos simultáneos: sin duplicar mensajes, leads ni envíos
   automáticos. Verificar con PostgreSQL real.
4. Fallo de media/lead no bloquea el lote ni elimina el aviso entrante; fallo al
   persistir el trabajo pendiente sí impide confirmar 200.
5. Reintentos observables, consumo acotado, migración aditiva revisada y rollback
   que conserve los pendientes.

F08 y F10 permanecen pendientes; no se revalidaron ni cerraron en esta pasada.
