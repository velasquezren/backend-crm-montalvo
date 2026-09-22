# Recepción: atención compartida y actividades

El rol RECEPCION puede leer y responder todos los chats de sus líneas habilitadas, aunque estén asignados a otro usuario. La respuesta conserva al responsable existente del chat y al agente comercial del paciente. En un chat sin responsable se mantiene la asignación a quien responde primero, sin impedir el acceso a las demás recepcionistas de esa línea.

La excepción se aplica en el filtro común del inbox, contadores, resumen, detalle, historial, búsqueda, lectura y envíos. Los destinatarios de WebSocket y push siguen el mismo alcance. Los roles AGENTE, ADMIN y SUPER_ADMIN conservan sus permisos.

Recepción dispone de WhatsApp, Actividades y Perfil. Actividades permite crear, editar, reprogramar, completar y cancelar recordatorios propios, también desde el chat. El buscador devuelve solo identificación y contacto de pacientes con conversaciones accesibles. No modifica su asignación comercial ni permite vincular leads, consultar fichas comerciales completas o crear contactos mediante el alta comercial. Los recordatorios en tiempo real se entregan únicamente al usuario responsable.

No requiere migración de base de datos. Publicar backend y frontend juntos para habilitar las rutas de actividades antes de mostrar el acceso en la interfaz.

## Verificación

- 28 pruebas de integración de líneas y recepción: asignación a distintos roles, lectura y envío, aislamiento por línea, agente sin acceso a chats ajenos, actividades personales, WebSocket y revocación de acceso.
- 169 pruebas de regresión de actividades, series, conversaciones y autorización HTTP.
- 143 pruebas de interfaz: actividades, formulario, selección de pacientes, calendario y permisos de navegación de recepción.
- Compilación de producción de ambos proyectos.
