# Agenda VPS: ampliación SQL verificada

6 de octubre de 2026, alrededor de las 22:14–22:20, America/La_Paz.

Complementa y resuelve los pendientes SQL de la
[auditoría del código ScriptCase](auditoria-agenda-vps-2026-10-06.md).
**La implementación permanece pausada. FileMaker/caja sigue pendiente de
inspección. Los borradores locales no están listos para activarse.**

## Acceso, privacidad y límites

El propietario proporcionó acceso MySQL explícitamente. Se utilizó el cliente
MySQL dentro de una conexión SSH por clave al VPS, no phpMyAdmin por HTTP.
La contraseña se introdujo en el prompt sin eco; no se escribió en archivos,
argumentos de proceso ni configuración. El historial del cliente se deshabilitó.

La primera consulta se ejecutó dentro de una transacción READ ONLY. La sesión
posterior utilizó `SET SESSION TRANSACTION READ ONLY`; se comprobó
`@@session.transaction_read_only = 1` al empezar y al terminar. Las consultas
agregadas tuvieron `MAX_EXECUTION_TIME = 3000` únicamente en esa sesión.
Se cerró el cliente y la conexión SSH al terminar.

Se leyeron definiciones, índices, claves, metadatos y conteos agregados. No se
extrajeron nombres de pacientes, CI, teléfonos, PAC, comprobantes, imágenes,
filas individuales ni textos SQL con valores personales. Los patrones de
escritura se consultaron mediante `DIGEST_TEXT`, con literales normalizados.

Las cifras son una observación de producción en ese momento, mediante varias
consultas, no un snapshot transaccional de toda la aplicación. No se alteraron
registros, vistas, usuarios, permisos, servicios ni configuración global.

## 1. Inventario SQL cerrado

- MySQL **8.0.44**, base **clinica**.
- Zona SQL: `@@session.time_zone = SYSTEM`, `@@system_time_zone = -04`.
  El reloj observado fue `2026-10-06 22:14:27`.
- Siete tablas InnoDB: `medicos`, `horarios`, `para_agendar`, `agenda_med`,
  `pagos_qr`, `promociones`, `resgitros_promos`.
- Dos vistas: **vista_horas_libres** y **v_agenda_web**.
- **0 triggers, 0 rutinas y 0 eventos** en `clinica`.
  Se comprobó que la cuenta tenía privilegios globales TRIGGER y EVENT;
  no es un listado vacío obtenido por una cuenta sin esos permisos.
- **horarios_medico no existe** como tabla o vista en `clinica`.
- Índices y FK coinciden con la lectura SDI previa: siete PK y dos índices
  adicionales en `horarios`; la única FK es
  `horarios.medico_pk → medicos.medico_pk`.
- No hay unicidad declarada de médico/fecha/hora en las tablas de reservas y
  agenda, ni unicidad declarada de `medicos.codigo`.

No se ha encontrado en esta base una entidad independiente de servicio,
especialidad o paciente que sustituya los campos observados. Eso no describe
el modelo interno de FileMaker ni otras aplicaciones externas.

## 2. Cómo calcula HOY los cupos vista_horas_libres

Su definición SQL hace estas operaciones:

1. Genera fechas desde `CURDATE()` hasta `CURDATE() + 29 días`, inclusive.
2. Las une con `horarios` por día semanal textual: Domingo, Lunes, Martes,
   Miercoles, Jueves, Viernes y Sabado.
3. Busca una coincidencia en `agenda_med` por **cod_med + fecha + hora**.
4. Conserva únicamente las combinaciones sin una fila coincidente en
   `agenda_med` (`agendam_pk IS NULL`).
5. Agrupa por fecha, código médico, hora, día, estado del horario y medico_pk.

Devuelve `fecha`, `cod_med`, `hora_disponible`, `dia`, `estado`, `medico_pk`.
El filtro `estado = 'ACTIVO'` lo añade la consulta ScriptCase consumidora;
la vista conserva el estado de `horarios`.

### Lo que no hace esta vista

- **No consulta para_agendar.** Una reserva pública insertada allí no bloquea
  directamente la vista; requiere otro paso que registre la ocupación en
  `agenda_med`. No se conoce todavía quién ejecuta ese paso.
- **No filtra el estado de agenda_med.** Una fila BORRADO o MODIFICADO también
  puede bloquear, igual que una CREADO.
- **No compara la hora con la hora actual.** Puede devolver horas pasadas del
  día de hoy.
- **No distingue sucursal**, ni usa `medico_pk` en la unión de ocupación:
  usa `horarios.cod_med = agenda_med.cod_med`.
- **No consulta medicos.estado**; el catálogo público lo filtra por separado.
- No devuelve un ID de slot, un contador de cupos, duración o información de
  pago. No bloquea registros ni registra una reserva.

### Comprobaciones agregadas de comportamiento

| Comprobación | Resultado observado |
| --- | --- |
| Fechas extremas con horarios ACTIVO | 2026-10-06 a 2026-11-04 |
| Fechas distintas con al menos una hora | 26; el horizonte generado sigue siendo 30 días |
| Horas devueltas con estado ACTIVO | 3.767 |
| Horas de hoy anteriores a CURTIME() todavía devueltas | 132 |
| Combinaciones de los próximos 30 días con horario activo bloqueadas por agenda sin ninguna fila CREADO | 4 |
| Reservas de para_agendar dentro de esos 30 días | 0 |

La ausencia de reservas futuras en esta muestra impide demostrar con una fila
actual una reserva web que siga libre. **La omisión de para_agendar sí está
comprobada por la definición SQL**, independientemente de la muestra.

No se cambió la vista para filtrar BORRADO/MODIFICADO: hace falta verificar qué
representa cada transición y cómo FileMaker reemplaza o anula citas. Tampoco
se amplió el horizonte ni se corrigieron las horas pasadas en producción.

## 3. v_agenda_web es un calendario interno, no un catálogo público

Esta vista lee `agenda_med` con `estado = 'CREADO'` y proyecta:

- ID, código y nombre del médico.
- Inicio formado con fecha y hora.
- Fin calculado sumando **15 minutos a todas las filas**.
- Título con el nombre del paciente; descripción con nombre y teléfono.
- Actividad, seguro, pago y un color según la actividad.

La duración fija del dibujo **no demuestra la duración real de una consulta o
servicio**. Tampoco demuestra qué aplicación está usando hoy esta vista.

No entregar su contenido a la landing anónima. Necesita una proyección y un
control de acceso adecuados si se consume desde una interfaz administrativa.
En esta auditoría se leyó su definición, no sus filas.

## 4. Calidad y correspondencias observadas, sin copiar datos personales

| Comprobación | Resultado |
| --- | --- |
| Médicos / activos / especialidades activas | 90 / 53 / 25 |
| Médicos activos con precio NULL / cero / distinto de cero | 39 / 3 / 11 |
| Códigos de médicos no vacíos duplicados | 0 observados; no existe restricción UNIQUE |
| Horarios / activos | 3.254 / 889 |
| Horarios con día fuera de los siete nombres usados por la vista | 0 |
| Horarios con segundos distintos de cero | 0 |
| Grupos de horarios activos repetidos por medico_pk/día/hora | 0 |
| Horarios cuyo cod_med no coincide con medicos.codigo por su FK medico_pk | 1, contando todos los estados de horario |
| Médicos activos con horario HTML pero sin horarios ACTIVO | 1 |
| Médicos activos sin horario HTML pero con horarios ACTIVO | 0 |
| Reservas / estado ATENDIDO / estado PAGADO | 38 / 35 / 3 |
| Reservas PAGADO sin comprobante | 0 |
| Grupos repetidos de reserva por medico_pk/fecha/hora | 3 grupos; 3 filas adicionales |
| Filas de agenda_med / CREADO / BORRADO / MODIFICADO | 14.456 / 12.200 / 649 / 1.607 |
| Grupos repetidos de agenda por cod_med/fecha/hora, incluyendo todos los estados | 876 grupos; 960 filas adicionales |
| Grupos repetidos de agenda por cod_med/fecha/hora, solo CREADO | 8 grupos; 8 filas adicionales |
| Códigos de agenda CREADO sin correspondencia en medicos.codigo | 12 códigos distintos |
| Reservas con médico inexistente | 0 |
| Médicos no activos/inexistentes con horas ACTIVO en la vista actual | 0 observados; la vista no impone esa condición |
| Médicos activos cuyo banco no nulo no existe en pagos_qr | 3 |
| QR configurados / con vencimiento NULL | 2 / 2 |
| Reservas con sucursal no vacía | 0 |
| Filas de agenda con sucursal no vacía / valores distintos no vacíos | 320 / 1 |

Los grupos repetidos **no prueban pacientes duplicados ni citas fraudulentas**:
pueden existir usos de sobrecupo, varias actividades o historial. Sí demuestran
que no se puede asumir una fila única por ese conjunto de campos ni usarlo
como correlación infalible entre sistemas.

NULL y cero en un precio son casos distintos. No convertir NULL en consulta
gratuita ni asumir que todo cero es una oferta autorizada. Los registros de
catálogo necesitan reglas confirmadas antes de mostrarse como precio final.

## 5. Qué se pudo comprobar del enlace externo

- No hay trigger, rutina o evento en `clinica` que transforme automáticamente
  `para_agendar` en `agenda_med`.
- Los patrones normalizados de Performance Schema registran inserciones en
  `agenda_med` con distintas combinaciones de PAC, actividad, relación y
  sucursal; también actualizaciones de estado por `agendam_pk` y de
  `para_agendar.estado` por `para_age`.
- Son evidencia de que **esas escrituras han ocurrido**, no una identificación
  del programa que las ejecuta ni una traza de una reserva concreta. Los
  contadores de digests son acumulativos y dependen de la retención/reinicio.
- En el momento de lectura había tres conexiones remotas a `clinica` que
  declaraban `libmariadb` 3.4.5 como cliente, además del cliente local de esta
  auditoría. No se copiaron IP, usuarios externos o nombres de equipos.
- Esa biblioteca **no identifica por sí sola FileMaker ni prueba ODBC/ESS**.
  No se realizaron conexiones hacia esos clientes.
- `relacion_pk` está poblado en las 14.456 filas de agenda; ninguno de esos
  valores es exclusivamente numérico. No hubo coincidencias textuales con
  `CAST(para_agendar.para_age AS CHAR)`.
- 22 de las 38 reservas tienen alguna coincidencia de código médico, fecha y
  hora con agenda. Esto no prueba que correspondan al mismo paciente o evento,
  ni autoriza a enlazarlas: ese conjunto no es único.

**Pendiente real:** identificar el equipo y componente FileMaker/caja, su
script/ESS/ODBC o proceso intermedio, la clave de correlación y las transiciones
que aplica. El propietario informó del reflejo en FileMaker; la atribución
técnica exacta todavía no está cerrada.

## 6. Correcciones al diseño local respaldadas por esta lectura

No se editaron ni eliminaron los siete elementos NestJS ni el consumidor Next.
Estas son correcciones documentadas para cuando se autorice retomar:

1. **Horizonte:** el contrato no puede prometer 90 días. La fuente genera hoy
   hasta hoy+29; las fechas fuera de ese rango no significan «sin cupos».
2. **Autoridad de ocupación:** leer la vista existente y reconocer que descuenta
   `agenda_med`. Nunca sustituirla silenciosamente por `para_agendar` o por
   horarios informativos del CRM.
3. **Reservar:** no basta insertar otra fila en para_agendar. Hay que entender
   el escritor externo y su correlación antes de ofrecer confirmación o
   exclusión mutua de cupos en web/WhatsApp.
4. **Estados de lectura:** no implementar el respaldo sobre
   `horarios_medico`, que no existe. La tabla real de horarios y sus días están
   verificados, pero sus reglas de ocupación deben conservarse o cambiarse
   explícitamente, no reinterpretarse por nombres de estados.
5. **Precio:** mantener la posibilidad de precio pendiente y validar banco;
   los datos actuales no permiten ofrecer un precio cerrado a todo médico.
6. **Identidad:** distinguir medico_pk, codigo/cod_med, para_age, agendam_pk y
   relacion_pk. No inventar equivalencias con IDs CRM ni deducirlas por nombre.
7. **Datos públicos:** no usar v_agenda_web como endpoint anónimo de cupos.
8. **Pago:** conservar el hecho comprobado en PHP: PAGADO tras comprobante es
   una etapa previa a la validación humana, no confirmación bancaria.
9. **Transporte:** la lectura SQL verificada no convierte en existente la API
   JSON/Bearer propuesta ni autoriza conectar el navegador a MySQL. El cliente
   remoto del borrador sigue siendo una propuesta sin implementación en VPS.

No se crearon endpoints, migraciones, sincronizaciones, cuentas ni un nuevo
sistema de catálogos. No se ejecutaron envíos ni pruebas de escritura.

## 7. Evidencia reproducible sin datos de pacientes

Consulta de metadatos utilizada: `information_schema.TABLES`, `VIEWS`,
`STATISTICS`, `KEY_COLUMN_USAGE`, `TRIGGERS`, `ROUTINES` y `EVENTS`, acotada a
`TABLE_SCHEMA`/esquema `clinica`; `SHOW CREATE VIEW` de las dos vistas.

SHA-256 de `information_schema.VIEWS.VIEW_DEFINITION`:

```text
v_agenda_web
7deb0bf71fb9ce6add5f663c58bf2e6e9b060a459b12c817a0deae3ccb19c163
vista_horas_libres
d8851987f87f092a074056e300ab13cb138fe68e9249cd71813e8783502f3f44
```

Estos hashes sirven para detectar cambios antes de reanudar; no autentican ni
contienen credenciales. La verificación funcional restante debe usar fixtures
sintéticos y un entorno descartable, una vez conocido el contrato de FileMaker.
