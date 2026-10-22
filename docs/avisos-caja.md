# Avisos a caja por WhatsApp

Desde el 22/10/2026. Cuando un comprobante de reserva queda cargado en la agenda
(`para_agendar` en PAGADO), el CRM le escribe a cada número de caja:

> Comprobante nuevo para verificar 🧾
>
> Paciente: Ana Pérez · Carnet: 1234567 · Médico: Juan Carlos Montalvo Doria Medina ·
> Cita: lunes, 2 de noviembre, 15:00 · Monto: Bs 400
>
> El comprobante ya está cargado en la agenda. Revíselo y regístrelo en FileMaker.

## Cuándo sale

En el mismo punto que el aviso de Telegram de siempre (`pagoParaVerificar`, que sigue
saliendo), en `AgendaReservasService`: el comprobante subido desde la web y el que llega
por el chat (Flow o IA) una vez que la IA lo dio por bueno ([lectura](reservas-pago-chat.md#lectura-del-comprobante-con-ia)).
Un comprobante que quedó en revisión no avisa: no está en la agenda.

## Dónde se configura

**Reservas → «Avisos a caja»** (solo administración): nombre y WhatsApp de cada número
(hasta 10) y el estado de la plantilla en Meta. Cada alta y baja queda en `AuditLog` con
solo los cuatro últimos dígitos. Tabla `NumeroCaja`, dueño `AvisosCajaService`
(`modules/agenda`), migración aditiva `20261022180000_numeros_caja`.

## Por qué plantilla, y desde Recepción

A caja se le escribe primero, y Meta solo deja hacerlo fuera de las 24 h con una plantilla
aprobada (`montalvo_comprobante_caja`, Utilidad, `es`, cinco variables; texto en
[plantillas](plantillas-whatsapp.md#5-montalvo_comprobante_caja--aviso-a-caja)). Sale de
**Recepción** (decisión de René, 22/10): es la línea interna y no se mezcla con los
pacientes de Ventas. `AVISO_CAJA_LINEA` y `AVISO_CAJA_PLANTILLA` cambian línea o nombre sin
desplegar; la plantilla tiene que existir en la WABA de esa línea.

## Garantías

- **Sin plantilla aprobada no se intenta**: el estado se pregunta a Meta (10 min de caché si
  está aprobada, 1 min si no; «Actualizar» en la pantalla vuelve a preguntar). Mientras
  tanto queda una línea `Aviso a caja … no está aprobada` en el log.
- **Nunca deshace ni frena el pago**: corre en segundo plano y no lanza.
- Los parámetros nunca van vacíos ni con saltos de línea (Meta rechazaría el mensaje).
- No entra al inbox: es un aviso interno. Si alguien de caja responde, su chat aparece
  en Recepción como el de cualquiera.
- Log: `Aviso a caja de la reserva N: x/y enviados`, sin nombres ni números.
