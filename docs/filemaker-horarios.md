# Horarios de consulta: FileMaker → agenda → CRM

Decisión de René, 15/10/2026: FileMaker local es el lugar de edición del horario
semanal de CONSULTAS. Son de 30 minutos. La hora final es el inicio de la última
cita: 12:30 significa una consulta de 12:30 a 13:00. Reconsultas de 15 minutos,
otras actividades, reservas pagadas y su pase a agenda quedan fuera de este cambio.

Estado: implementación local y guía preparadas; NO activada en producción ni
instalada en el archivo FileMaker. La aceptación final exige la prueba de §5.

## 1. Preparar FileMaker

Use una copia de seguridad del archivo antes de configurar el guion. No cambie
la conexión ODBC ni los botones de informes/PDF. Este envío va al backend del CRM,
que ya conecta por TLS con `clinica` en `23.95.128.187` (verificado en producción).

En **Archivo → Gestionar → Base de datos → tabla `horario_medicos`**, añada:

| Campo | Tipo | Configuración |
|---|---|---|
| `crm_horario_revision` | Número | Normal, almacenado, inicialmente vacío o 0 |
| `crm_horario_cuerpo` | Texto | Normal, almacenado |
| `crm_horario_estado` | Texto | Normal, almacenado |
| `crm_horario_error` | Texto | Normal, almacenado |
| `crm_horario_sincronizado` | Fecha y hora | Normal, almacenado |

No son campos globales, de cálculo ni de autointroducción. Quien modifica horarios
debe poder escribirlos. Muestre `crm_horario_estado` y `crm_horario_error` en la
presentación para distinguir un guardado local de un cambio ya publicado.

Los campos de las capturas se usan así:

| FileMaker | Contrato |
|---|---|
| `pk.hm` | `registroId`: identidad estable del registro de horario |
| `medico.pk` | `medicoCodigo`: debe coincidir con `medicos.codigo`, no con `medico_pk` numérico |
| `estado` | ACTIVO habilita sus cupos; INACTIVO los deshabilita, sin dar de baja al médico |
| `sucursal` | Etiqueta del origen; no crea una segunda agenda por sucursal |
| `lunes_hi`, `lunes_hf` | Primera y última consulta de mañana del lunes |
| `lunes_hi.t`, `lunes_hf.t` | Primera y última consulta de tarde del lunes |
| Los mismos cuatro campos de martes a sábado | Resto de la semana |

Solo se admite un registro de horario por médico. Otro `pk.hm` para el mismo
médico, o el mismo `pk.hm` para otro médico, devuelve conflicto: no se fusionan
sucursales ni se elige arbitrariamente un registro. No se cambian códigos de médicos.

## 2. Crear el guion

En el espacio de trabajo de guiones cree **`CRM - Sincronizar horario actual`**.
Añada los pasos de [horarios-guion.txt](filemaker/horarios-guion.txt). El archivo
es una guía de pasos, no un XML importable: pegarlo entero no crea un guion.

En el paso **Establecer variable `$datos`**, pegue como valor TODO el cálculo de
[horarios-datos-calculo.txt](filemaker/horarios-datos-calculo.txt).
Utiliza `While`, disponible desde FileMaker 18. Los nombres de funciones son los
de la referencia actual de Claris. El cálculo produce los seis días completos y
lee la ocurrencia actual mediante `Get(LayoutTableName)`, por lo que no depende
de que la ocurrencia tenga exactamente el nombre de la tabla.

La presentación de edición debe estar basada en `horario_medicos`. Si los campos
están dentro de un portal relacionado, el guion requiere adaptarse al contexto;
no se debe conectar al registro padre suponiendo que es el médico editado.

En **Insertar desde URL**:

- Seleccionar todo el contenido: activo; destino: variable `$r`.
- Con diálogo: inactivo; verificar certificados SSL: activo.
- URL: cálculo `$url`, sin comillas alrededor del nombre de la variable.
- Opciones de cURL: el cálculo completo del guion. Conservar `@$cuerpo` literalmente.
- El token de `$token` es exclusivo de horarios, mínimo 32 caracteres; se entrega
  por un canal privado al desplegar. No usar la contraseña MySQL ni el token de informes.

No marque «Desestimar validación» ni «Omitir conflictos de ESS» en los pasos
**Consignar registros/peticiones**. Cada captura de `Get(LastError)` va inmediatamente
después del paso que se comprueba. No introducir pasos entre ambos.

## 3. Conectar el guardado automático

Primero instale el guion sin activar el disparador. Cuando el endpoint esté
desplegado, configurado y se haya comprobado el envío manual de §5:

1. En la presentación de HORARIOS MÉDICOS, entre en **Modo Presentación**.
2. Abra **Presentaciones → Ajustar presentación → Activadores de guiones**.
3. En **OnRecordCommit**, seleccione `CRM - Sincronizar horario actual`, modo Visualizar.
4. Si ya hay un guion en ese activador, incorpore este como subguion solo después
   de que la validación anterior haya aceptado el registro; respete su resultado.
   No sustituya validaciones existentes ni ejecute este guion dos veces.
5. Vuelva a Visualizar. No hace falta cambiar el botón Modificar.

Escribir y pulsar Tab entre campos del mismo registro no siempre lo consigna:
al terminar, haga clic fuera del registro o pase al siguiente médico. Se envía
una vez al confirmar el registro, no con cada tecla.

`OnRecordCommit` se dispara **antes** de la consignación. El guion protege la
reentrada con `$$CRM_HORARIO_EN_CURSO`, consigna primero los datos y el cuerpo
pendiente, comprueba el error y solo entonces hace HTTP. Si la validación local
falla, devuelve 0 y no envía nada. Si falla la red, el registro permanece guardado
y PENDIENTE. No mantiene una transacción local abierta esperando Internet.

El envío se confirma solo si la respuesta dice SINCRONIZADO y coincide en
registro, código y revisión. No basta con que `Get(LastError)` sea 0.

## 4. Reintentos e instalación del servidor

Puede añadir un botón **Reintentar horario** que ejecute el MISMO guion, una sola
vez. Al editar otra vez también se reintenta. El cuerpo guardado conserva la
misma revisión si no cambió el horario; una edición real incrementa la revisión.
No borrar ni reiniciar `crm_horario_revision` en un registro ya integrado.

El servidor guarda primero la revisión aceptada y después aplica MySQL y la ficha
web. Si alguna de estas dos últimas operaciones falla, queda pendiente en el
servidor y se reintenta cada minuto, hasta diez médicos por barrido y en serie.
Si el envío nunca llegó al servidor (por ejemplo, sin Internet), se reintenta desde
FileMaker; no se promete un envío autónomo con FileMaker cerrado. Tras un reintento
del servidor, ejecute el mismo guion para actualizar la confirmación local.

Configuración del backend:

```dotenv
FILEMAKER_HORARIOS_ACTIVO=off
FILEMAKER_HORARIOS_TOKEN=
```

Despliegue siguiendo `crm-backend-arquitectura`: respaldar PostgreSQL, aplicar la
migración aditiva `20261015190000_horarios_filemaker`, generar Prisma, compilar y
verificar salud/autenticación. Requiere `AGENDA_VPS_ADMIN=on` y su cuenta existente.
No requiere cambios de tablas o permisos MySQL. Preparar un respaldo de
`clinica.medicos` y `clinica.horarios` antes de la primera sincronización real.

Mantener `FILEMAKER_HORARIOS_ACTIVO=off` hasta instalar el guion y coordinar la
prueba. Al ponerlo en `on`, los horarios dejan de ser editables desde el CRM;
los demás datos del médico siguen con sus permisos habituales. El frontend muestra
el origen y si falta sincronizar; recibe avisos por el socket existente y refresca
la ficha abierta sin pisar cambios pendientes de otros datos.

Endpoint: `POST /integraciones/filemaker/horarios`, JSON, `Authorization: Bearer …`.
60 peticiones por minuto e IP. Una carga inicial de varios médicos debe ir en serie
y con al menos dos segundos entre envíos. Empezar por un médico comprobado, no por
un envío masivo. No usar `/v1/integraciones/filemaker/informe`: pertenece a otro producto.

Hay una sola instancia del backend hoy. Las revisiones/candados son persistentes
y funcionan con varias instancias; la invalidación del catálogo y los avisos WebSocket
son del proceso actual, como el resto del CRM. Si se amplía a varias réplicas,
conectar ambos al mecanismo compartido antes de prometer refresco inmediato.

## 5. Prueba de aceptación en FileMaker (pendiente)

1. Elegir un médico real cuyo código esté comprobado y comparar su horario
   actual con la ficha del CRM. Registrar el estado anterior para poder restaurarlo.
2. Con guion instalado y servidor habilitado, ejecutarlo manualmente. Primera
   vez puede añadirse temporalmente un diálogo cuyo mensaje sea `$r` inmediatamente
   DESPUÉS de capturar `$errorEnvio`, nunca antes.
3. Verificar respuesta SINCRONIZADO, mismo código/registro/revisión y cupos esperados.
4. Comprobar en CRM: 12:30 aparece como última hora de inicio y no aparece 13:00
   salvo que otro tramo la incluya. Verificar mañana y tarde, días vacíos y descansos.
5. Repetir el envío sin cambiar nada: no deben nacer cupos ni auditorías duplicados.
6. Activar OnRecordCommit. Hacer un cambio acordado, salir del registro y comprobar
   actualización automática; restaurar el horario si el cambio era solo de prueba.
7. Probar sin red: FileMaker debe conservar PENDIENTE y mostrar el motivo. Con red,
   ejecutar Reintentar horario y comprobar la confirmación. Si el servidor ya lo
   había recibido, repetir el envío no retrocede ni duplica el horario.

No se crean, cobran, cancelan ni trasladan citas en esta prueba. Los horarios
recortados no eliminan citas existentes; recepción las gestiona por su flujo habitual.
Esta parte requiere FileMaker abierto: las pruebas automatizadas del backend no
certifican los activadores ni los campos dentro del archivo `.fmp12` real.

## Referencias de Claris

- [OnRecordCommit: se ejecuta antes de consignar](https://help.claris.com/es/pro-help/content/onrecordcommit.html).
- [Consignar registros/peticiones y validación](https://help.claris.com/es/pro-help/content/commit-records-requests.html).
- [While, FileMaker 18 o posterior](https://help.claris.com/en/pro-help/content/while.html).
- [Variables en cURL: `--data-binary @$variable`](https://help.claris.com/en/pro-help/content/curl-options.html).
