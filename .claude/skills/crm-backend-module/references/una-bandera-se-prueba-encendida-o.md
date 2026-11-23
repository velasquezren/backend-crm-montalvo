# Una bandera se prueba ENCENDIDA, o la suite certifica lo que no corre

> Parte de la skill `crm-backend-module`: lee antes su [índice](../SKILL.md).

Toda bandera de este backend parte apagada y se enciende en producción
(`RESERVAS_ACTIVIDADES`, `WHATSAPP_INTERACCIONES`, …). Una prueba que monta el
servicio con la bandera en su valor por defecto está midiendo el camino que
**no** está desplegado: sale verde describiendo un software que no es el que
usa la clínica.

El 2026-10-08 esto costó un bug en producción. El webhook de WhatsApp mandaba
por el camino de interacciones cualquier tipo que no reconociera:

```ts
mensaje.type === 'interactive' || mensaje.type === 'button'
  || (mensaje.type !== 'text' && !media)   // ← el cajón de sastre
```

La intención era prudente —«si no lo entendemos, que lo vea una persona»—, pero
no podía acertar nunca: `parsearRespuesta` solo sabe leer `button` e
`interactive`, así que todo lo demás salía `DESCONOCIDA` y `motivoDeRespuesta`
lo convierte en `REVISION`. En las líneas del piloto, **una paciente poniendo
👍 a un mensaje abría atención humana y pausaba su automatización**. Igual una
ubicación compartida.

Había una prueba que afirmaba lo contrario —«ignora … tipos que el CRM no
registra»— y pasaba en verde: montaba la línea con `WHATSAPP_INTERACCIONES`
apagada, la única configuración en la que el bug no existe. El test no era
incorrecto; cubría el caso que no está en producción. Nadie se enteró durante
todo el piloto.

Dos consecuencias prácticas:

- **Si una rama depende de una bandera, pruébala en los dos estados.** El
  camino encendido primero: es el que ve la clínica.
- **Restaura el valor en un `afterEach`.** `process.env` es global entre
  pruebas del mismo fichero, y una bandera que se queda encendida contamina las
  siguientes de forma dificilísima de leer.

Vale encenderla por entorno (`process.env['X'] = 'on'`) o por configuración
(`new ConfigService({ X: 'on' })`); las dos llegan igual al código.

`check:skills` lo verifica: toda bandera comparada contra `'on'` en
`src/` debe aparecer encendida en al menos un spec, o el build falla.
