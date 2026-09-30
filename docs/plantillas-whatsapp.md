# Plantillas de WhatsApp — preparadas, SIN enviar a Meta

Regla de la clínica: **ninguna plantilla se crea, borra ni edita en Meta sin OK
explícito**. Este documento deja cada una lista para enviarla a revisión con
un solo paso cuando se dé ese OK.

Estado en Meta al 2026-09-24 (línea «Recepción Clínica Montalvo»; comprobado sin cambios el 2026-09-30):

| Plantilla | Estado | Uso |
| --- | --- | --- |
| `montalvo_informe_disponible` | **Aprobada** — **la única de resultados** | Aviso de resultado, sin imagen: «tu informe médico ya está disponible. Toca el botón de abajo para verlo y descargarlo. Si necesitas ayuda, responde a este mensaje.» |
| `montalvo_recordatorio_cita`, `montalvo_confirmacion_cita`, `montalvo_seguimiento_solicitud_cita` | Aprobadas | Selector del chat y «Nuevo chat» |

## 1. `montalvo_informe_listo` — aviso de resultado con imagen y «Agendar consulta»

La versión definitiva del aviso. Mejora sobre las anteriores:
- **Encabezado con imagen** de la marca (`docs/plantillas/cabecera-informe.png`,
  servida en `https://resultados.107.175.132.15.nip.io/resultados/imagen-aviso`).
- **Botón de respuesta rápida «Agendar consulta»**: el toque llega al chat de
  Recepción como un mensaje «Agendar consulta» (el webhook ya lo lee), así que
  cada resultado puede terminar en una cita.
- Sin mencionar códigos. Sin variables en el cuerpo: se aprueba más rápido y no
  expone datos del paciente en la vista previa de la notificación.

- **Categoría:** Utility · **Idioma:** `es`
- **Encabezado:** Imagen
- **Cuerpo:**
  > Clínica Montalvo: tu informe médico ya está disponible.
  >
  > Toca «Ver mi informe» para abrirlo de forma privada, sin códigos.
  >
  > Si quieres revisarlo con tu médico, toca «Agendar consulta» y te escribimos.
- **Pie:** `Enlace personal. No lo reenvíes.`
- **Botones** (en este orden; el CRM manda la variable al botón de índice 0):
  1. URL · «Ver mi informe» · `https://resultados.107.175.132.15.nip.io/resultados/{{1}}`
     — ejemplo: `…/resultados/3d300296-db32-4238-85e4-58d02aeb534a`
  2. Respuesta rápida · «Agendar consulta»

Carga para la API (`POST /{WABA_ID}/message_templates`). El `header_handle` se
obtiene subiendo `cabecera-informe.png` con la *Resumable Upload API* de Meta:

```json
{
  "name": "montalvo_informe_listo",
  "language": "es",
  "category": "UTILITY",
  "components": [
    { "type": "HEADER", "format": "IMAGE", "example": { "header_handle": ["<handle>"] } },
    { "type": "BODY", "text": "Clínica Montalvo: tu informe médico ya está disponible.\n\nToca «Ver mi informe» para abrirlo de forma privada, sin códigos.\n\nSi quieres revisarlo con tu médico, toca «Agendar consulta» y te escribimos." },
    { "type": "FOOTER", "text": "Enlace personal. No lo reenvíes." },
    { "type": "BUTTONS", "buttons": [
      { "type": "URL", "text": "Ver mi informe", "url": "https://resultados.107.175.132.15.nip.io/resultados/{{1}}",
        "example": ["https://resultados.107.175.132.15.nip.io/resultados/3d300296-db32-4238-85e4-58d02aeb534a"] },
      { "type": "QUICK_REPLY", "text": "Agendar consulta" }
    ] }
  ]
}
```

**Al aprobarse**, en `/opt/crm-backend/.env` y `systemctl restart crm_backend`:

```
RESULTADOS_PLANTILLA=montalvo_informe_listo
RESULTADOS_PLANTILLA_IMAGEN=https://resultados.107.175.132.15.nip.io/resultados/imagen-aviso
```

Sin código que tocar: `componentesPlantilla` ya manda la cabecera cuando
`RESULTADOS_PLANTILLA_IMAGEN` existe (probado en `componentes-plantilla.spec.ts`
y `resultados.integracion.spec.ts`). **No poner esa variable con una plantilla
sin imagen**: Meta rechaza un encabezado que la plantilla no tiene.

Hasta entonces el puente es `montalvo_informe_disponible` (activa desde el
24-09): solo `RESULTADOS_PLANTILLA=montalvo_informe_disponible`, sin la
variable de imagen.

## 2. `montalvo_primer_contacto` — escribirle primero a alguien («Nuevo chat»)

Para iniciar conversación con un número nuevo o retomar a una paciente. Hoy
«Nuevo chat» solo tiene plantillas de citas, que no encajan con un primer
saludo.

- **Categoría:** Marketing (un primer saludo no es transaccional; Meta
  rechaza o recategoriza si se envía como Utility) · **Idioma:** `es`
- **Cuerpo** (1 variable, el nombre; el formulario la pide):
  > Hola {{1}}, te escribimos de Clínica Montalvo.
  >
  > ¿Te ayudamos a agendar una consulta o resolver alguna duda? Responde a este mensaje y te atendemos.
  - ejemplo de `{{1}}`: `María`
- **Pie:** `Clínica Montalvo`
- **Botones:** Respuesta rápida «Agendar consulta» · Respuesta rápida «Más información»

No requiere cambios: el selector del chat ya soporta variables y botones de
respuesta rápida.

## 3. Ventas y publicidad — revisión del 2026-09-30

Estado en Meta (WABA `1011426071679964`, solo lectura): `promo_especialidad`,
`reactivacion_paciente` y `bienvenida_contacto` aprobadas como **Marketing**,
ninguna con imagen, calidad aún sin medir. Uso real en 60 días: 9 envíos,
5 leídos, 1 respuesta. Lo que mueve la factura no son estas plantillas: son
los ~2.900 mensajes libres al mes de las agentes, que **Meta cobra por mensaje
desde el 1 de octubre de 2026** (antes eran gratis dentro de las 24 h).

Reglas de Meta que mandan sobre cualquier diseño (documentación oficial,
«Template categorization» y «Pricing»):

- **No mezclar publicidad en una plantilla de Utilidad.** El contenido mixto
  es Marketing; hacerlo de forma reiterada lleva a que Meta pase TODAS las
  plantillas de Utilidad a Marketing durante 7–30 días. El aviso de resultado
  se queda como Utilidad, con imagen de marca neutra (§1), nunca con una oferta.
- **Marketing siempre se cobra**, y Meta limita cuántas plantillas de marketing
  recibe cada persona. Mejor pocas y buenas que muchas.
- **Lo gratis que queda:** 72 h de mensajes (plantillas incluidas) cuando la
  paciente llega por un anuncio «Clic a WhatsApp» y se le responde dentro de
  24 h. Para ventas, es la palanca más barata.

### 3a. `montalvo_consulta_especialidad` — campaña con imagen (propuesta)

Sustituye a `promo_especialidad`. **Una sola plantilla para todas las campañas**:
la imagen de la cabecera se manda en cada envío, así que cambiar de especialidad
es cambiar la foto y la variable, no aprobar otra plantilla.

- **Categoría:** Marketing · **Idioma:** `es`
- **Encabezado:** Imagen (1,91:1, p. ej. 1200×628; foto real de la clínica o
  de la especialidad, logo pequeño; sin texto largo encima)
- **Cuerpo** (2 variables):
  > Hola {{1}}, en Clínica Montalvo tenemos turnos este mes para *{{2}}*.
  >
  > Atención con especialistas y tus resultados llegan directo a tu WhatsApp.
  >
  > Tocá «Agendar consulta» y te reservamos el horario que prefieras.
  - ejemplos: `{{1}}` = `María`, `{{2}}` = `Ecografía`
- **Pie:** `Clínica Montalvo · Santa Cruz`
- **Botones:** Respuesta rápida «Agendar consulta» · Teléfono «Llamar a la
  clínica» (`+59133581919`) · Respuesta rápida «No me interesa»

«No me interesa» no es cortesía: una persona que no quiere promociones y no
tiene cómo decirlo **bloquea o reporta**, y eso baja la calidad del número y
puede pausar la plantilla. Falta en el CRM tratar esa respuesta como baja.

Pendiente de código para usarla: el selector de plantillas del chat todavía no
pide una imagen de cabecera por envío (hoy solo la manda Resultados).

### 3b. `reactivacion_con_foto` — reactivación con la foto de la clínica (propuesta)

Versión con imagen de `reactivacion_paciente` (hoy con cabecera de texto «Te
extrañamos en Clínica Montalvo»). Misma voz que las plantillas de Ventas
(voseo).

- **Imagen elegida:** la fachada al atardecer, recortada a 1,91:1
  (`docs/plantillas/reactivacion-clinica.jpg`, 980×513, 117 KB). Original en
  `CRM/Imagenes Clinica Meta PLantillas/Foto de la Clincia.jpeg`.
  - **Por qué la foto y no el logotipo:** «te extrañamos, volvé a tu control»
    se dice mejor con el edificio que la paciente reconoce, y la luz cálida da
    cercanía. El logotipo es un rótulo sobre blanco: en la cabecera queda chico
    y el blanco se funde con la burbuja del chat. La marca ya está en la foto:
    el letrero de la fachada.
  - **Por qué el recorte:** a ~360 px (el ancho real en un teléfono) el original
    pierde el letrero entre cielo, cables y autos; cerrado sobre el edificio se
    lee, y se conserva la bandera.
- **Categoría:** Marketing · **Idioma:** `es`
- **Encabezado:** Imagen
- **Cuerpo** (1 variable, el nombre):
  > Hola {{1}}, te extrañamos en Clínica Montalvo.
  >
  > Hace un tiempo que no te vemos y queremos seguir acompañándote en tu salud.
  > Si querés retomar tu control o consulta, tocá «Agendar consulta» y te
  > buscamos el horario.
  - ejemplo de `{{1}}`: `María`
- **Pie:** `Clínica Montalvo · Santa Cruz`
- **Botones:** Respuesta rápida «Agendar consulta» · Respuesta rápida «No me
  interesa» (más claro que el «Baja» actual; ver §3a sobre por qué importa).

**Nueva, no editando la actual.** Una plantilla con cabecera de imagen exige
mandar la imagen en CADA envío; si se editara `reactivacion_paciente`, el CRM
—que hoy no manda imagen desde el chat— fallaría al enviarla hasta tener ese
código. La actual se retira cuando la nueva esté aprobada y el CRM la mande.

### 3c. `bienvenida_contacto` es Marketing y no debería usarse para responder

Su texto es un acuse («Un asesor te atenderá»). Si alguien acaba de escribir,
la ventana de 24 h está abierta y un mensaje libre basta: usar esta plantilla
ahí es pagar tarifa de marketing por un acuse. El acuse fuera de horario del
CRM ya va como mensaje libre.

## 4. Lo que ninguna plantilla arregla sola: el dominio

El enlace muestra `resultados.107.175.132.15.nip.io`. Con un dominio propio
(p. ej. `resultados.clinicamontalvo.com`) el paciente ve el nombre de la clínica
en el enlace, que es lo que más confianza da. Pasos cuando exista:

1. DNS `A` del subdominio → `107.175.132.15`; certificado en Apache.
2. `PORTAL_ORIGIN` del portal y `PORTAL_RESULTADOS_PUBLICO` del CRM.
3. **Una plantilla nueva**: la URL base del botón está fijada en la plantilla
   aprobada; Meta no deja cambiarla editando.
