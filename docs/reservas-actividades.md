# Reservas, Actividades y campanita

Publicado y activo desde el 8/10/2026. Versiones y comprobaciones en
[ESTADO_ACTUAL](ESTADO_ACTUAL.md). Ventas y Recepción se activaron por petición
expresa posterior de René; la línea de prueba permanece habilitada.

## Comportamiento

La agenda MySQL de ScriptCase sigue siendo la fuente. `ReservasActividadesService`
crea una tarea compartida de gestión por `para_age`, tanto para reservas de la
web/ScriptCase como para las del Flow de WhatsApp. Descubre reservas con fecha
desde hoy en La Paz; no importa automáticamente el histórico anterior.

| Estado de la agenda | Actividad | Seguimiento del QR |
| --- | --- | --- |
| PENDIENTE | Gestionar reserva, pendiente | Conserva la espera existente |
| PAGADO | Verificar comprobante, pendiente | PAGO_REGISTRADO si existe comprobante |
| ATENDIDO | Gestionada, completada | GESTIONADA; termina la espera |
| Fila retirada | Cancelada | Revisión humana |

`PAGADO` significa comprobante registrado, no verificado. `ATENDIDO` indica gestión
administrativa; no prueba atención médica, cobro ni existencia de la cita en
`agenda_med`. FileMaker conserva su circuito habitual. Si una gestionada vuelve
a pendiente, el seguimiento del chat pasa a revisión sin reactivar el QR viejo.
Un error al consultar MySQL conserva el estado previo; no simula una cancelación.

La campanita muestra las tareas pendientes y abre su detalle exacto en Actividades.
Desde allí se abre la reserva (con fecha y número) o la conversación vinculada.
El cierre es automático desde la agenda: editar, completar, cancelar, repetir o
borrar una tarea automática se rechaza también en la API. Las tareas manuales
conservan sus acciones, responsables y recordatorios.

## Permisos y entrega

- Una reserva vinculada a un chat hereda su acceso actual y la preferencia de
  silencio de la línea. Una reserva externa corresponde a los roles autorizados
  para consultar la agenda clínica. No se crea una ficha ni se cruza a un paciente
  por coincidencia de nombre o teléfono.
- REST verifica el alcance; WebSocket usa las sesiones autorizadas. Las alertas
  push solo incluyen el número y la tarea, sin nombre, teléfono ni comprobante.
- Una restricción única evita tareas duplicadas por reserva. La actualización de
  Actividad y la conciliación del QR comparten transacción PostgreSQL y candado
  por reserva. Una lectura anterior no puede sobrescribir otra más reciente.
- Cada 30 segundos se descubren hasta 50 filas por cursor y se revisan hasta 50
  conocidas, priorizando las menos recientes. Se revisan pendientes y reservas
  de los últimos siete días en adelante. No es una garantía de latencia de 30 s:
  con mayor volumen hacen falta varias pasadas. No se escribe en MySQL.
- Hasta diez avisos por pasada; reclamación persistente de 120 segundos. Una caída
  permite reintentar. La entrega externa es al menos una vez: un corte después
  del envío puede repetir el aviso, con la misma etiqueta push. La tarea durable
  en la campana sigue siendo única. El cliente agrupa refrescos y tiene recarga
  de respaldo mientras la pestaña está visible.

## Operación

1. Respaldo PostgreSQL verificado y respaldo del artefacto anterior, siguiendo
   `crm-backend-arquitectura`. Publicar backend con la migración aditiva
   `20261008160000_reservas_actividades`, generar Prisma y compilar antes de reiniciar.
2. Mantener `RESERVAS_ACTIVIDADES` apagado mientras se publica el frontend que
   admite actividades sin ficha/responsable y el estado `GESTIONADA`.
3. Con frontend verificado, activar `RESERVAS_ACTIVIDADES=on`; requiere también
   `AGENDA_VPS_CONSULTA=on`. Reiniciar solo `crm_backend` y verificar health, acceso,
   conteos y tareas. El primer barrido crea completadas para las ya gestionadas,
   sin avisarlas; las pendientes iniciales sí generan avisos internos.
4. Conservar la lista explícita de interacciones WhatsApp y los activos Meta.
   El seguimiento de Actividades no envía WhatsApps a pacientes. Los menús de
   Ventas y Recepción están activos por la autorización del 8/10, además de prueba;
   no extender la lista a otras líneas como parte de un despliegue de reservas.

Para detener sincronización y avisos, apagar `RESERVAS_ACTIVIDADES` y reiniciar
el backend. Conserva las tareas y sus fechas de última consulta; no las borra.
**No volver al frontend antiguo** una vez creadas tareas automáticas: no admite
las relaciones opcionales. Corregir hacia adelante; no revertir el esquema ni
eliminar datos para volver a una versión anterior.

## Verificación

Pruebas PostgreSQL: concurrencia, lectura atrasada, estados, desaparición/fallo
externo, permisos revocados, silencio, cursor de más de 50 filas, reintento de
avisos y bandera apagada. Pruebas UI: campana ante error, enlace exacto, silencio,
acción de reserva sin confirmación ficticia, día de La Paz y detalle por rol.
Se agregaron pruebas MySQL del cursor y consulta por IDs; requieren el fixture
aislado de `scripts/probar-agenda-mysql.sh`, no la base de producción.
