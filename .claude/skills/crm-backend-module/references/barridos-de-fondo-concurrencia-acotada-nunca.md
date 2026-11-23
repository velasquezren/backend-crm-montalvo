# Barridos de fondo: concurrencia ACOTADA, nunca `Promise.all` sobre el lote

> Parte de la skill `crm-backend-module`: lee antes su [índice](../SKILL.md).

Un `setInterval` que despacha notificaciones, correos o llamadas externas es la
tentación clásica de cambiar el `for await` por un `Promise.all(lote.map(…))`
"para que vaya más rápido". En este servidor eso es una regresión, no una
optimización:

- la máquina se comparte con Resultados y ClamAV (ver `crm-backend-arquitectura`
  §2), y este patrón nació en un VPS de un núcleo; desde Prisma 7 el adaptador
  `pg` configura diez conexiones y 5 s de espera en `PrismaService`;
- el barrido comparte ese pool con las peticiones de las agentes. Cincuenta
  `update()` a la vez compitiendo por ese pool no
  ralentizan el barrido: hacen fallar el chat que alguien estaba abriendo;
- cada push firma un JWT VAPID (ECDSA), que es CPU en un core que no sobra.

El patrón es tandas pequeñas, con el try/catch **por elemento** de la sección
anterior dentro de cada una:

```ts
for (let i = 0; i < pendientes.length; i += CONCURRENCIA) {
  await Promise.all(pendientes.slice(i, i + CONCURRENCIA).map(x => this.notificarUno(x, ahora)));
}
```

Ver `barrerRecordatoriosPendientes()` en `actividades.service.ts` (CONCURRENCIA 5).
Dos corolarios que costaron lo mismo:

- **`Promise.allSettled` sobre funciones que ya tienen try/catch no aísla nada**
  — ninguna promesa rechaza. Dice una intención que el catch ya cumple, y de paso
  disimula que la concurrencia no está acotada.
- **Un `take: N` en la consulta del barrido es un tope, y un tope que se alcanza
  significa avisos sin mandar.** Loguéalo, o el día que pase se descubre porque
  una agente no recibió el suyo.
