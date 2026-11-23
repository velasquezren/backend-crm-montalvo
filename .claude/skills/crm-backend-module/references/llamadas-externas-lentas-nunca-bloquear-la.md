# Llamadas externas lentas: nunca bloquear la respuesta al cliente

> Parte de la skill `crm-backend-module`: lee antes su [índice](../SKILL.md).

Si un endpoint dispara una llamada a un servicio de terceros que no determina
el resultado que ve el usuario (ej. reenviar un mensaje por WhatsApp Cloud API
tras ya haberlo guardado en la base), **no la esperes (`await`) antes de
responder**. El agente no debería pagar con latencia el round-trip a un
tercero (Meta: 300-900ms típico) por algo que ya ocurrió (el mensaje ya está
guardado). Ver `enviarMensaje()` en `conversaciones.service.ts`.

**Pero no basta con no esperarla: hay que capturar su rechazo.** Node aborta el
proceso ante una promesa rechazada sin manejar, y fuera de una petición no hay
filtro global que la convierta en un 500. Se reprodujo en F06 (2026-09-07): con
la base sin responder, el `findMany` que abría el barrido de recordatorios
tumbaba el proceso, systemd lo relevantaba por `Restart=always` y volvía a pasar
cinco minutos después — un servicio que `systemctl status` muestra `active`
mientras en realidad no atiende. Por eso todo disparo sin `await` va por
`enSegundoPlano` (`common/fiabilidad/en-segundo-plano.ts`).

```ts
// ✅ el agente ve su mensaje enviado en cuanto se guarda en la base
const mensaje = await this.prisma.mensaje.create({ ... });
void enSegundoPlano(`envío del mensaje ${mensaje.id} a Meta`, this.logger, () =>
  this.despachador.texto(destino, contenido),
);
return mensaje;

// ❌ compila, funciona, y tumba el proceso el día que la base no responda
void this.despachador.texto(destino, contenido);
```

**Corolario: si disparas en segundo plano, tu `catch` ya no ve el fallo del
tercero.** Cualquier estado que "deshaga" algo ante un error (una reserva, un
cupo) tiene que reaccionar también al fallo diferido, que llega como
`estadoEnvio = FALLIDO` por el despacho o por el webhook de `statuses`. Pasó en
`ResultadosService.enviar` (2026-09-22): la reserva de `AvisoResultado` solo se
liberaba ante un `throw` síncrono, así que un rechazo real de Meta dejaba el
informe "avisado" para siempre. Y la prueba no lo vio porque simulaba el fallo
con un `throw` en el stub — **un stub de la frontera tiene que fallar como falla
la frontera de verdad.**

El helper recibe una **función**, no una promesa ya construida: así también
atrapa lo que lance antes de que la promesa exista. Y va en el punto donde se
dispara, **nunca dentro del método que hace el trabajo**: ese mismo método puede
tener un controller que sí devuelve su resultado —`sincronizarAutomatico` lo
tiene— y tragarse el fallo adentro convertiría un 500 legítimo en un 200 que
miente.

`check:skills` lo exige: un `void algo.metodo(` en `src/` sin `enSegundoPlano` ni
un `.catch()` propio rompe el build.

**Esto no contradice la regla — distingue red de local.** Antes de ese
`await this.prisma.mensaje.create(...)`, `enviarMensaje()` sí espera
`verificarVentana24h()`: una consulta LOCAL a Postgres (no de red a Meta) que
confirma que el último mensaje ENTRANTE del paciente tiene menos de 24h — la
ventana de servicio al cliente (CSW) de WhatsApp. Fuera de esa ventana Meta
rechaza igual el texto libre, pero tarda un webhook de `statuses` en
avisarlo; adelantar el rechazo con un `BadRequestException` local le ahorra
al agente esperar un tick que nunca llega. Lo que la regla prohíbe bloquear
es la llamada de RED a un tercero, no cualquier `await`. (La ventana de 72h
de Free Entry Point por anuncio es independiente y no entra en este chequeo:
solo habilita plantillas sin costo, nunca texto libre.) Ver
`fueraDeVentana24h` en el frontend — es el mismo cálculo duplicado a
propósito para pintarlo en la UI antes de que la agente escriba; si se toca
uno, se toca el otro.
