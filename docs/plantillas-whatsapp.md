# Plantillas de WhatsApp — preparadas, SIN enviar a Meta

Regla de la clínica: **ninguna plantilla se crea, borra ni edita en Meta sin OK
explícito**. Este documento deja cada una lista para enviarla a revisión con
un solo paso cuando se dé ese OK.

Estado en Meta al 2026-09-24 (línea «Recepción Clínica Montalvo»):

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

## 3. Lo que ninguna plantilla arregla sola: el dominio

El enlace muestra `resultados.107.175.132.15.nip.io`. Con un dominio propio
(p. ej. `resultados.clinicamontalvo.com`) el paciente ve el nombre de la clínica
en el enlace, que es lo que más confianza da. Pasos cuando exista:

1. DNS `A` del subdominio → `107.175.132.15`; certificado en Apache.
2. `PORTAL_ORIGIN` del portal y `PORTAL_RESULTADOS_PUBLICO` del CRM.
3. **Una plantilla nueva**: la URL base del botón está fijada en la plantilla
   aprobada; Meta no deja cambiarla editando.
