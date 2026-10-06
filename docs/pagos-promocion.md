# Cobrar una promoción por WhatsApp

Diseño del 2026-10-06 (decisiones de René: pago por WhatsApp con QR y comprobante, un
QR por línea, y el CRM responde solo con la tarjeta de la promoción). Se construye sobre
[promociones](promociones-y-directorio.md), el [menú de atención](menu-atencion.md) y la
[atención humana](atencion-humana.md): no hay pasarela de pago ni otra bandeja.

## El recorrido

```
Landing (banner de la promoción) ─ «La quiero» ─▶ WhatsApp con «… (PRM-7K3QX).»
   │
   ▼  el CRM reconoce el código
Tarjeta: banner · título · precio (con el anterior) · vigencia · condiciones
         [Pagar ahora]  [Hablar con alguien]          + la promoción queda en su lead
   │
   ▼  Pagar ahora
QR de la línea + «Para pagar «X»: Bs 280. Escanea este QR (Banco, a nombre de …)
               y envíanos aquí la foto o el PDF del comprobante.»   → pago PENDIENTE
   │
   ▼  manda una foto o un PDF
«Recibimos tu comprobante…»   → pago COMPROBANTE_ENVIADO + «Atención»: Comprobante por verificar
   │
   ▼  una persona lo revisa en el chat
Confirmar → nace la VENTA (ligada a la promoción y a su lead, con el comprobante)
            → pago CONFIRMADO → «Confirmamos tu pago de Bs 280…» (como mensaje de esa persona)
Pedir otro (con motivo) → vuelve a PENDIENTE → «No pudimos verificar el comprobante: …»
Anular → ANULADO, sin venta
```

La misma tarjeta sale cuando la paciente elige una promoción en la opción
«Promociones» del menú de atención, que ahora **lee las promociones publicadas para
WhatsApp en el CRM** (una sola fuente con la landing; antes era una lista escrita a mano
dentro del menú, que nunca llegó a producción).

## Por qué así

| Decisión | Motivo |
|---|---|
| El pago va por WhatsApp, no por un formulario en la landing | En el chat se sabe quién es la paciente, la persona verifica en el mismo sitio y la venta queda atribuida. Un formulario público para subir comprobantes exige protegerse de spam y deja datos sueltos sin identidad |
| «Pagado» solo cuando una persona lo verifica | El sistema anterior (ScriptCase) marcaba PAGADO al subir el comprobante. Aquí los estados dicen la verdad: pendiente, comprobante enviado, confirmado |
| Un QR por línea, en el CRM (`modules/cobros`) | Como `pagos_qr` del sistema anterior, pero con banco, titular y vencimiento visibles. Un QR vencido no se envía y no se puede activar |
| El QR sale de R2 como cualquier adjunto (URL firmada) | No hace falta una ruta pública para el QR: menos superficie expuesta |
| El monto se congela al pedir el QR | Un cambio de precio después no cambia lo que ella ya pagó |
| La confirmación sale como mensaje de la persona que confirmó | Es una respuesta humana, no un automático: cuenta como «respondida» y no la calla la pausa |
| La venta nace por `VentasService` | Conversaciones no escribe la tabla de ventas: la categoría de la paciente y el cierre de leads siguen su regla. `clientRequestId` por pago: confirmar dos veces no cuenta dos ventas |

## Reglas que no se pueden olvidar

- **El código** (`codigoEnTexto`, alfabeto de `generarCodigo`) solo cuenta si su promoción
  está visible hoy (publicada y vigente). Atribuye la promoción al **lead abierto más
  reciente sin anuncio** (un anuncio de Meta manda sobre el código) y responde con la
  tarjeta si `WHATSAPP_INTERACCIONES` está encendida. Si la tarjeta sale, no salen además
  el menú ni el acuse fuera de horario.
- **La tarjeta** es una oferta con `origen: 'PROMOCION'` y su `promocionId` (cifrado con
  la oferta): solo un toque VIGENTE a NUESTRA tarjeta dispara «Pagar ahora»; uno a una tarjeta
  caducada pasa a «Atención» como revisión. Ofrece pagar solo si
  la promoción tiene precio y la línea tiene un QR listo hoy.
- **«Pagar ahora»** responde aunque la conversación esté pausada (es lo que ella pidió).
  Si hoy no se puede cobrar (promoción pausada o vencida, sin precio, QR vencido), no se
  manda nada inventado: la conversación pasa a «Atención» como revisión.
- **Un pago abierto por conversación**, bajo el candado de automáticos. Elegir otra
  promoción anula el pendiente; si ya mandó comprobante de otra, lo resuelve una persona.
- **El comprobante** es la primera imagen o documento que llega con un pago PENDIENTE de
  hace menos de 72 h (`HORAS_ESPERA_COMPROBANTE`; compare-and-set: dos fotos simultáneas no
  marcan dos). Volver a tocar «Pagar ahora» retoma el mismo pago con su monto y renueva
  las 72 h para recibir el comprobante; si su
  comprobante ya está en revisión, no se le manda otro QR. Sube a «Atención» con motivo
  `COMPROBANTE_PAGO` (prioridad normal, antes de `REVISION` en el orden).
- **Confirmar** exige rango de agente (registra una venta) y que la descarga del
  comprobante haya terminado (si no, 409). Primero **reclama** el pago (compare-and-set a
  `CONFIRMADO` sin venta), después crea la venta y la enlaza; si la venta falla, el pago vuelve
  a «por verificar». Un reclamo a medias solo lo completa quien lo hizo: el chat muestra
  «Registro pendiente» y «Completar registro», conserva el pago visible aunque hayan pasado
  14 días y bloquea otro QR mientras se termina (`PAGO_EN_CURSO`). Al completar, renueva
  la fecha de cierre y mantiene la misma clave de venta para no duplicarla. Copia el archivo a `comprobantes/<agente>/` (la
  carpeta que `VentasService` acepta como respaldo propio). Resuelve la solicitud de
  atención solo si es la de ESE comprobante; otra (pidió una persona, una emergencia) sigue.
- **Fuera de la ventana de 24 h** el aviso de confirmación no puede salir como texto libre:
  el pago queda resuelto igual y el CRM muestra una advertencia; la persona le escribe con
  una plantilla. Confirmar y pedir otro devuelven `avisoPaciente: ENCOLADO | NO_ENVIADO`.
  Preparar un aviso no acredita su entrega: esta se consulta en el mensaje del chat.

## Datos

- `CobroLinea` (uno por línea): activo, banco, titular, instrucciones, vence el, imagen
  del QR en R2 (`cobros/<lineaId>/<id>.<ext>`). Lo escribe `CobrosService`.
- `PagoPromocion`: conversación, línea, promoción, monto congelado, estado, comprobante,
  motivo del último rechazo, venta, quién y cuándo lo cerró. Lo escribe
  `PromocionesChatService`; cada transición deja constancia en `AuditLog`.
- `Lead.promocionId`: la promoción por la que llegó por su código.
- Los resultados de cada promoción cuentan ahora los leads por anuncio **o** por código,
  las ventas de esos leads **o** de sus pagos, y los pagos pendientes y por verificar.

## Lo que queda para después

- **Pago sin intervención humana**: un QR dinámico del banco con confirmación automática
  (por ejemplo, «QR Simple» de BNB o BCP) confirmaría el pago solo y permitiría pagar en la
  landing. Requiere contrato con el banco; el estado `CONFIRMADO` y la venta ya existen.
- **Reservas reales**: la agenda vive en el sistema anterior (ScriptCase + MySQL `clinica`,
  con paso a FileMaker). Cuando se integre, «Pagar ahora» de una promoción con cita puede
  llevar a elegir un horario real antes del QR.
- **IA**: tendrá datos estructurados (promoción, precio, condiciones, estado del pago) en
  vez de texto suelto; sigue sin poder escribir en un chat pausado.
- El Flow `interes-promocion` queda **superado** por la tarjeta con botones (menos pasos
  para la paciente). Se deja el borrador en Meta, sin publicar.
