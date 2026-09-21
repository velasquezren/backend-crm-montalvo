# WhatsApp, agenda y modales · 2026-09-21

## Alcance

Continuación de A1–A5 de Actividades y corrección del hallazgo Temporal registrado
en ESTADO_ACTUAL.md. No se dan A6/A7 por terminadas: no se implementan envíos
programados ni arrastre de eventos. No se modifica lógica financiera.

## Mensajería

- Persiste el código de rechazo de Meta en Mensaje. El webhook y el despacho
  HTTP lo conservan; un HTTP de aceptación tardío no tapa un webhook fallido.
- Clasifica rechazos permanentes, incluidos 130497 (restricción de país),
  131042 (facturación) y 131047 (ventana). No se confunden causas.
- Tope de tres reintentos; eventos repetidos no reinician su espera. Las
  plantillas fallidas no se reenvían como texto libre.
- Migración aditiva: codigoErrorEnvio y permiteReintento. Un fallo consultando
  plantillas sin caché produce 503, no una lista vacía falsa.
- Frontend: causa legible del fallo, refresco explícito desde Meta, línea y
  destinatario visibles, aviso de posible cobro antes de confirmar una plantilla.

## Agenda y estética

- Schedule-X usa Temporal global y valida instancias; importar únicamente el
  módulo local no basta y mezclarlo con Temporal nativo tampoco. La ruta instala
  la misma versión 0.3.0 (dependencia directa) utilizada al construir los eventos.
- Publica el primer rango al montar, libera CalendarApp al salir y utiliza
  America/La_Paz. Prueba del calendario real, sin sustituir el motor por un doble.
- Enlaces desde lista y detalle al inbox; filtros de visitas anteriores se
  limpian al llegar por búsqueda. Si hay varias coincidencias se elige la línea.
  Permisos del servidor intactos; navegar no envía mensajes.
- Drawer compartido: altura de viewport dinámica, scroll contenido, zonas
  seguras, cabecera legible y alto=contenido para formularios breves en escritorio.
  En móvil mantiene pantalla completa. Servicios conserva sus fichas amplias.
- Plantillas oficiales y respuestas rápidas adoptan el mismo Drawer con trampa
  de foco y cierre por Escape. La agenda identifica sus recordatorios como internos.

## Verificación

- Backend: 566 pruebas unitarias; 519 integraciones en la corrida completa,
  más dos casos posteriores cubiertos por la repetición de Conversaciones
  (72 casos). Build y nueve pruebas del verificador de build correctos.
- Frontend: 374 pruebas en 38 archivos; build y validadores correctos.
- Regresión de Temporal: ReferenceError reproducido antes de la corrección;
  después se insertan/retiran eventos y se publica el rango del montaje real.
- No se enviaron mensajes de prueba a pacientes. Sin inspección visual en
  navegador, conforme a CLAUDE.md; compilación y pruebas no sustituyen esa revisión.

## Límites

La aprobación de plantillas depende de Meta y no levanta por sí sola un 130497.
No se certifica que toda la cuenta esté libre de restricciones. El calendario
conserva su límite visible de 100 actividades por rango y avisa si lo supera.
No se inventa una tarifa por mensaje ni se activa mensajería programada.
