# Líneas de WhatsApp, recepción y asistente (2026-09-13 · rol ASISTENTE 2026-09-22)

> Parte de la skill `crm-backend-module`: lee antes su [índice](../SKILL.md).

**Entregar resultados es una capacidad, no un rango ni solo una membresía:**
`ResultadosService` exige `puedeEntregarResultados(rol)` (ASISTENTE, o ADMIN para arriba) **y**
acceso a la línea de resultados. Con solo la membresía, cualquiera que atienda la línea de
Recepción entregaba informes médicos — medido en producción el 2026-09-22 con un AGENTE de
ventas. Si otra función necesita "este rol sí, aquel no" a través de la jerarquía, añade una
lista junto a `ROLES_OPERATIVOS` en `common/auth/roles.ts`; no la escribas en el service.

**La asistente corrige fichas desde el INFORME, nunca por `/clientes`** (2026-09-29).
`/clientes` exige rango de agente: la cola llamaba ahí para cambiar el teléfono o dar de alta
una ficha, y la asistente —la persona para la que existe— recibía 403. Abrirle Clientes le
daría las 15.000 fichas con sus datos comerciales. Por eso existen
`PATCH /resultados/:informeId/telefono` y `POST /resultados/:informeId/ficha`: el servidor
decide qué ficha es con el mismo cruce por PAC o CI de la cola, y en el alta nombre, PAC y CI
salen del portal; del navegador solo viaja el teléfono. `ClientesService` ofrece para eso
`telefonoDesdeResultados` y `altaDesdeResultados`, con visor `ninguno` (el 409 no nombra a
nadie). Lo fija `resultados-roles.spec.ts` con el guard real.

**Plantillas con imagen de cabecera: `assets/cabeceras/<nombre de la plantilla>.jpg`**
(2026-09-30). Meta exige la imagen en CADA envío. `resumirPlantilla` solo marca `enviable`
una plantilla con cabecera de imagen si el CRM tiene ese archivo, y `prepararPlantilla` la
adjunta sola. Se sirve en `GET /publico/cabeceras/<plantilla>.jpg` (pública: Meta la
descarga) bajo `CRM_URL_PUBLICA`; sin esa variable, ninguna plantilla con imagen se ofrece.
Esa ruta responde `Cross-Origin-Resource-Policy: cross-origin`: el `same-origin` de Helmet
hacía que el navegador del CRM (otro dominio, Vercel) bloqueara la imagen en la vista previa
—a la paciente le llegaba bien— (2026-10-01). Cualquier recurso que el frontend muestre con
`<img>` directo desde esta API necesita lo mismo.
Añadir otra es dejar su archivo con el nombre exacto. Nunca edites una plantilla aprobada
para ponerle imagen antes de tener su archivo aquí: dejaría de poder enviarse.

**«No me interesa» da de baja de las promociones** (`Cliente.bajaPromocionesEn`). Solo el
TOQUE de un botón (`esRespuestaBoton`), nunca el texto escrito. La ingesta confirma la baja
y **no manda nada más** —ni el acuse fuera de horario ni el pedido de nombre y edad—. Con
baja, el servidor rechaza con 409 las plantillas de Marketing (Utilidad sigue). Se reactiva
con `recibePromociones: true` en la ficha, y solo si ella lo pide.

**Las otras dos puertas de la baja son de Meta** (2026-09-30). La paciente puede parar las
promociones desde «Ofertas y anuncios» de WhatsApp sin escribir nada:
- **Webhook `user_preferences`** (`stop`/`resume`, categoría `marketing_messages`) →
  `ClientesService.preferenciaPromocionesDesdeWhatsapp`. La preferencia es de la persona,
  no de la línea, así que no resuelve la línea receptora. Si el número no tiene ficha, no
  crea una. `resume` borra la baja aunque la hubiera dado con el botón. Hay que tener el
  campo suscrito en la app de Meta.
- **Estado `failed` con 131050** (Meta no entregó una plantilla porque ella las paró) →
  `procesarEstadoMensaje` registra la baja. Es la red si el webhook se perdió.

Ni 131050 ni 131049 (el tope diario de marketing por persona) se reintentan: están en
`ERRORES_WHATSAPP_PERMANENTES`. Los reintentos del despachador son de minutos, y Meta pide
no reintentar 131049 enseguida.

**La cola de resultados se filtra donde se corta la página** (2026-09-30). Pestañas
`POR_AVISAR` / `ESPERANDO` / `VENCIDOS` / `ABIERTOS` / `TODOS` (`ESTADOS_COLA`). Las tres
últimas las pagina el portal (sus filtros `abierto`, `vigente`, `buscar`). Las dos primeras
dependen de si se avisó —dato del CRM—, así que el portal da el conjunto de trabajo ENTERO
(`GET …/informes/panorama`: ids vigentes y sin abrir, acotado por los 30 días del enlace, con
`truncado` si supera el tope) y el CRM lo parte con `AvisoResultado` y pagina sobre esa lista.
**Nunca filtres en el CRM una página que ya cortó el portal**: la pestaña diría «no hay más»
con informes en la siguiente (la cicatriz del inbox, «un corte se lee como un dato»). Un aviso
FALLIDO cuenta como no avisado. Los contadores van sin la búsqueda. Cada fila trae
`conversacionId`: el chat de (ficha, línea de resultados), no «el chat por teléfono».

**Un número que ya tiene ficha sin PAC se VINCULA, no se duplica** (2026-09-30). La paciente
que escribió por WhatsApp antes de ir a la clínica tiene ficha sin PAC; su informe llega con PAC
y queda «sin vincular». `ClientesService.fichaDelTelefono` clasifica el número frente al
paciente (`LIBRE` / `VINCULABLE` / `OCUPADO`); `crearFicha` responde 409 con `vinculable` y la
pantalla pregunta «¿es la misma paciente?» mostrando el nombre; `POST /resultados/:id/vincular`
le pone el PAC (y el CI si no tenía; el nombre solo si era el provisional). **Nunca en
automático**: madre e hija comparten WhatsApp, y vincular por teléfono le pegaría el informe de
la hija a la ficha de la madre. Otro PAC u otro CI = `OCUPADO`, no se toca.

**Un 409 de dato repetido nombra al dueño solo si quien pregunta podría ver esa ficha**
(`VisorFichas` en `clientes.service.ts`): alcance global, todas; una agente, su cartera; quien
no entra en Clientes, ninguna. Sin eso, teclear un número le decía a una agente el nombre de
una paciente de otra.

Para una consulta, los roles globales son `ROLES_ALCANCE_GLOBAL` (derivada del rango), no
`['ADMIN', 'SUPER_ADMIN']` escrito a mano.

`RECEPCION` tiene acceso a conversaciones, perfil, push y recursos propios. Las rutas sin `@Roles` requieren `AGENTE`; los endpoints públicos conservan `@Public`. `ADMIN` y `SUPER_ADMIN` tienen alcance global. Las demás cuentas necesitan membresía explícita `AccesoLineaWhatsapp` además del alcance de asignación. Recepción no admite membresía comercial. La identidad de un chat es `(clienteId, lineaId)`. No usar solo clienteId ni credenciales globales para enviar. El webhook resuelve `metadata.phone_number_id` y confirma HTTP después de persistir, devolviendo 503 si falla un elemento para permitir reintento — **salvo que el número receptor no esté registrado, que se descarta con 200** (ver «Un 503 solo vale para fallos transitorios»). Reasignar un chat no cambia el cliente ni los leads.

**Ver una línea y que te suene son dos cosas (2026-09-29).** Una fila en `SilencioLinea`
dice que los mensajes de esa línea NO le suenan a esa persona —ni push ni aviso en la
pestaña—; no toca qué ve. Es una tabla propia y no una columna del acceso a propósito: los
admins ven todas las líneas por su rol, sin fila de acceso donde guardarlo, y la edición de
agentes reescribe los accesos (una primera versión con la columna en el acceso se retiró el
mismo día por esas dos razones). `LineasWhatsappService.audiencia()` devuelve las dos listas: `ven` (refresco de
bandeja por socket) y `avisar` (marca `entrante` + push). **Nunca silencies recortando `ven`**:
el socket es también lo que refresca la bandeja, y quien silenció Recepción tiene que seguir
viendo llegar esos chats. Lo suyo avisa aunque la línea calle: el chat asignado a ella, o en la
comercial la paciente de su cartera. **Cada persona lo decide para sí** en Perfil
(`GET /lineas-whatsapp/avisos`, `PUT /lineas-whatsapp/:id/avisos` — el usuario sale del token,
nunca de la URL), y SUPER_ADMIN también lo fija en Agentes con `lineasSilenciadas` en
`PATCH /usuarios/:id`. Ausente, se conserva: que un admin guarde la ficha no pisa lo que la
persona eligió en su perfil. Solo sobre líneas que ve; al perderla se borra su silencio.
Cambiar el silencio **no** incrementa `versionSesion` (no toca permisos); cambiar el conjunto
de líneas sí.

Los avisos salen con TTL, `Topic` y `Urgency` explícitos (`opcionesEntrega` en
`common/push/cuerpo-push.ts`). Sin opciones, `web-push` guarda cada aviso **cuatro semanas**:
un teléfono apagado el fin de semana recibía el lunes uno por cada mensaje viejo.
