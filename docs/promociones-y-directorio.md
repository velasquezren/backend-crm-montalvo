# Promociones y directorio médico

Diseño del 2026-10-05. Dos módulos nuevos que convierten al CRM en la **única fuente
de verdad** de lo que la clínica ofrece y de quién atiende:

- `modules/promociones`: la oferta, sus banners, sus precios, su vigencia y los
  anuncios de Meta que la publicitan.
- `modules/directorio`: especialidades, la ficha pública de cada médico y su horario.

Los consumen el CRM (agentes y recepción), la **landing** (`landing-montalvo`, Next.js
en Vercel) por una API pública de solo lectura, y más adelante el menú de WhatsApp
y una IA. Nada de esto toca la mensajería ni las comisiones.

## Decisiones (y por qué)

| Decisión | Motivo |
|---|---|
| El panel va en el **mismo frontend del CRM**; la cara pública es la landing | Las agentes ya trabajan ahí, con su sesión, roles y sistema de diseño. Otro frontend sería otra app que asegurar y mantener |
| **La agente redacta, un ADMIN publica** (decisión del propietario) | Un precio o una condición mal escrita queda a la vista de pacientes |
| El horario del médico es **informativo**, no una agenda con cupos | Las citas reales siguen en el sistema de la clínica (ScriptCase/FileMaker). Integrar reservas es una fase aparte |
| La ficha pública se **enlaza** al `Medico` de comisiones, no lo reemplaza | Es la misma persona (código de FileMaker) para la planilla, las ventas y el directorio. `Medico` sigue siendo de comisiones; el directorio no lo escribe |
| Atribución por **id de anuncio**, sin Marketing API | El referral de Click-to-WhatsApp ya trae el `source_id` y el CRM lo guarda (`Lead.anuncioId`). La Marketing API exige un acceso que todavía no está demostrado (ver CAMP-0) |
| Banners en **R2**, servidos por la API con URL inmutable | R2 ya está en producción. Una URL firmada caduca y la landing y Meta guardan la imagen en caché; por eso la API la sirve, con `Cache-Control: immutable` y un id que cambia con cada imagen nueva |
| Sin `sharp` ni dependencias nuevas | `image-size` ya estaba: se valida tipo (por los bytes), medidas y proporción. Next/Image de la landing redimensiona en Vercel |

## Promociones

### Ciclo de vida (`TRANSICIONES` en `promocion-reglas.ts`)

```
BORRADOR ──enviar (AGENTE)──▶ EN_REVISION ──publicar (ADMIN)──▶ PUBLICADA ◀──publicar── PAUSADA
    ▲                              │                                │    └──pausar (ADMIN)──▲
    └──────devolver (ADMIN, con motivo)                             │
                    archivar (ADMIN) desde cualquiera ──▶ ARCHIVADA (terminal)
```

- Un ADMIN puede publicar un borrador suyo sin pasar por revisión.
- **Editar**: una agente, solo borradores. Un admin, todo menos lo archivado; si edita
  una publicada, el resultado tiene que seguir siendo publicable.
- **Bloqueo optimista**: cada edición manda la `version` que leyó; si otra persona guardó
  entretanto, 409.
- Cada transición bloquea la fila (`FOR NO KEY UPDATE`), comprueba el estado y escribe su
  constancia en `AuditLog` **en la misma transacción**: un precio que llegó a pacientes
  siempre tiene quién lo aprobó.

### Para publicar (`faltantesParaPublicar`; se exige al enviar y al publicar)

Título, resumen, banner **cuadrado**; si hay precio u oferta, condiciones; el promocional
menor que el regular; la vigencia no terminada; al menos un canal (landing o WhatsApp).
La base sostiene lo mismo con `CHECK` (precios ≥ 0, promocional < regular, vigencia ordenada).

### Banners (`FORMATOS_BANNER`)

| Formato | Mínimo | Para qué |
|---|---|---|
| `CUADRADO` 1:1 (obligatorio) | 1080×1080 | WhatsApp, tarjetas de la landing, feed |
| `VERTICAL` 4:5 | 1080×1350 | Feed de Instagram/Facebook en el teléfono |
| `HISTORIA` 9:16 | 1080×1920 | Historias y Reels |
| `HORIZONTAL` 1,91:1 | 1200×628 | Cabecera en la landing y enlaces compartidos |

JPG, PNG o WebP de hasta 5 MB; la proporción con 2 % de holgura y el texto alternativo,
obligatorio. Reemplazar un formato crea otra fila (otra URL); el archivo anterior se borra de
R2 **después** de guardar el nuevo.

### Vigencia

Días de calendario de La Paz, inclusive (`@db.Date`). «Hoy» sale de `fechaCivilClinica`:
el VPS está en Estados Unidos y sin eso, entre las 20:00 y la medianoche ya sería mañana.

### Meta: de qué promoción viene una paciente

1. Cada promoción tiene sus anuncios (`PromocionAnuncio`: un anuncio, una promoción).
2. `GET /promociones/anuncios/sin-promocion` lista los anuncios que **ya trajeron
   pacientes** y nadie enlazó, con el titular y la imagen tal como llegaron en el referral.
3. `GET /promociones/atribucion/:anuncioId` responde «vino por la promo X, Bs Y, vigente
   hasta Z» para el chat.
4. El detalle de cada promoción cuenta los **leads** y las **ventas ganadas** de sus anuncios.
   Es atribución por anuncio, no causalidad.
5. Cada promoción tiene un **código** (`PRM-7K3QX`) y un `mensajeWhatsapp` que lo incluye: la
   landing lo pone en el enlace de WhatsApp. Reconocer ese código en la ingesta es el paso
   siguiente (abajo).

## Directorio médico

- **Especialidades**: nombre, slug estable, descripción, orden, activa. No se borran.
- **Ficha** (`PerfilMedico`): nombre público, slug estable, resumen, biografía, matrícula,
  precio de consulta en Bs, foto (R2), especialidades, publicada o no. Publicar exige al menos
  una especialidad activa. Bloqueo optimista igual que las promociones.
- **Horario** (`HorarioMedico`): bloques «día ISO + desde + hasta» en minutos de La Paz, hasta 4
  por día y sin solapes (`erroresDelHorario`). Se guarda entero. `resumenDelHorario` lo dice en
  una frase («Lunes a viernes, 08:00–12:00 · sábado, 09:00–12:00»); vacío = «Con cita a solicitud».
- **Ausencias**: rangos de fechas con un motivo público («Vacaciones»), sin detalles personales.

## API pública (la landing)

Sin sesión, solo lectura, con el rate-limit general y `Cache-Control: public, max-age=60,
stale-while-revalidate=300`. Solo sale lo **publicado** (y, en promociones, **vigente hoy**);
nunca versión, autor, anuncios, resultados, código de FileMaker ni claves de R2.

| Ruta | Devuelve |
|---|---|
| `GET /publico/promociones?especialidad=&canal=landing\|whatsapp` | Promociones visibles, destacadas primero y las que vencen antes |
| `GET /publico/promociones/:slug` | Una, si está visible |
| `GET /publico/promociones/imagenes/:id` | El banner, solo si su promoción está visible |
| `GET /publico/directorio/especialidades` | Activas, con cuántos médicos publicados tiene cada una |
| `GET /publico/directorio/medicos?especialidad=` | Fichas publicadas con horario y resumen |
| `GET /publico/directorio/medicos/:slug` | Una ficha con biografía y próximas ausencias |
| `GET /publico/directorio/fotos/:id` | La foto, solo si la ficha está publicada |

Las URL de imágenes son absolutas con `CRM_URL_PUBLICA` (la que ya usan las cabeceras de
plantillas); sin ella, relativas.

**Encaje con la reserva de la landing** (`booking/types.ts`): `Specialty` ← especialidad
(`slug`, `nombre`, `descripcion`); `Doctor` ← ficha (`slug`, primera especialidad, `nombre`,
`fotoUrl`, `resumenHorario`, `precioConsulta`). `getDays`/`getAvailability` siguen sin backend:
no hay cupos reales hasta integrar la agenda de la clínica.

## Pasos siguientes (no hechos)

1. **Pantallas del CRM** (Angular): Promociones (lista por estado, editor con banners,
   revisión) y Directorio (especialidades, fichas, horario).
2. **Landing**: leer esta API con revalidación (ISR) y, al publicar, avisarle para que se
   revalide al instante. Usar el skill oficial `next-best-practices` de Vercel en ese repo.
3. **Menú de WhatsApp**: que la opción «Promociones» del menú de atención lea las promociones
   publicadas para WhatsApp en vez de una lista escrita a mano (una sola fuente).
4. **Ingesta**: reconocer el código `PRM-…` en el primer mensaje y atribuir la promoción
   cuando no vino por un anuncio.
5. **Reservas reales**: integrar la agenda de la clínica (ScriptCase/FileMaker) para cupos.
6. **IA**: tendrá datos estructurados (promoción vigente, precio, condiciones, médicos,
   horario) en vez de texto suelto. No se programa todavía.
