# Auditoría de documentación y contexto — 15/10/2026

Alcance: documentación propia, instrucciones de agentes y referencias de los
repos backend/frontend. No se modificaron funcionalidades, schema, tests,
scripts de ejecución ni configuración productiva. Base inicial `62a6777` /
`9b31bb7`; durante la tarea aparecieron `9efdd1f` y `c20e012` del backend:
se conservaron su código y sus notas, incluido el despliegue pendiente.

## Problemas comprobados y consecuencias

| Problema | Evidencia | Consecuencia / corrección |
| --- | --- | --- |
| Entrada circular y lectura obligatoria extensa | AGENTS, AI_GUIDE, GEMINI, Copilot y Cursor reenviaban a varias entradas; CLAUDE exigía estado completo y manifiesto | Una entrada operativa por repo; adaptadores de seis líneas y consulta por tarea |
| Estado mezclado con historial | 3.234 líneas al inicio, 3.243 tras la nota simultánea; «sin desplegar», «detenerse» y «siguiente paso» de meses anteriores | Estado breve, historial conservado en dos archivos con advertencia de alcance temporal |
| Fases que ya estaban implementadas | `promociones-y-directorio.md` proponía pantallas, reservas e IA; existen features Angular, `AgendaReservasService` y módulo Asistente | Sustituidas por ubicación de implementación, contratos y pruebas |
| IA e informes presentados como apagados o inexistentes | PANORAMA, preparación IA, pendientes de audio; commits `d990347`, `2d70cd4`, `7daea1f`, `ed7f204`; `prueba-conexion.ts` incluye AUDIO | Guías actualizadas; antecedentes marcados como históricos; distinguir configuración nueva de activación registrada |
| Ejemplos frontend contradictorios | Manifiesto §2.8 exigía petición en service/recurso en vista; §2.9 mostraba recurso dentro del service. `new FormField` contradecía la referencia local; `app.config.ts` usa interceptores funcionales | Se quitaron ejemplos duplicados y se remitió a la skill, código y API instalada; se preservaron principios |
| Autoridad de documentación exagerada | «build es la verdad», «skills siempre mandan», «todo se verifica» | Los validadores inspeccionados verifican rutas, roles y reglas específicas, no toda la prosa. Contradicciones requieren evidencia y no cambios automáticos de comportamiento |
| Confusión entre dominios | Agenda clínica, Actividades, directorio informativo, reservas/pagos y FileMaker mezclados en una fila extensa | Guía de Agenda con dueños y límites; dependencias contrastadas con `*.module.ts`; mapa resumido |
| Infraestructura de épocas distintas | Skill decía servidor exclusivo y compartido a la vez, PostgreSQL solo CRM y también Resultados | Se corrigieron esas contradicciones y se fecharon medidas; receta de backup/despliegue y expand/contract preservadas |
| Trabajo cerrado presentado como deuda | R3/último mensaje y MIME en cierre/revisión final; `lectura-mensajes-inbox.ts` ya usa `LATERAL … LIMIT 1`, despachador usa `contenidoAdjunto` | Registro de trabajo cerrado con pruebas y encabezados de contexto en informes históricos |
| Permisos y operación desactualizados | Línea de recepción descrita como solo chats propios; `ROLES_OPERATIVOS` da atención compartida. Agenda clínica tiene capacidades distintas de rango | Corregidas guías de líneas, panorama y manual, conservando las restricciones comerciales |
| Manual prometía comportamientos inexistentes | `VentasService` registra venta y origen; planilla usa importación/motor separado. `ActividadesService` barre cada cinco minutos | Quitada comisión automática al guardar venta y promesa de aviso al segundo; corregido editor de horario FileMaker |
| Referencias no portables | Alias `B/` y `F/` usados como enlaces, rutas a `/tmp` o documentos fuera de Git | Enlaces a rutas reales; referencias históricas ausentes identificadas como tales, sin inventar evidencia |

## Qué se conserva y qué se consolida

- **No se eliminó ningún documento histórico ni evidencia adjunta.** Se retiró
  prosa duplicada de entradas y manifiesto; la instalación del backend pasó a
  su README. Las guías de terceros no se alteraron.
- Se conservaron **103 encabezados y 520 párrafos** del estado previo a la
  limpieza, incluidos los añadidos simultáneamente. La comparación ignora solo
  formato de enlaces reubicados y espacios. No es una validación de la veracidad
  de cada afirmación histórica.
- Se mantuvieron nombres/rutas de skills para no romper consumidores ni debilitar
  `check:skills`. Se añadieron rutas de lectura por sección; no se fragmentaron
  sus contratos en archivos que el validador actual no inspecciona.
- La ruta inicial del backend, sin skills de dominio, pasó de aproximadamente
  **40.260 a 2.250 palabras** contando entrada, estado e índice completos.
  Es reducción de contexto prescrito, no un benchmark de latencia o exactitud de IA.

## Fuentes y recorrido de una sesión

[CLAUDE](../CLAUDE.md) → [estado breve](ESTADO_ACTUAL.md) → fila del
[índice por responsabilidad](README.md) → código, tests y sección de la guía.
El manifiesto mantiene principios; PANORAMA responsabilidades; Git y los
informes fechados conservan decisiones y evidencia. Un «pendiente» del archivo
histórico no basta para autorizar ni justificar una implementación.

## Comprobaciones de esta entrega

- `npm run check:skills` aprobado en ambos repos; no se modificaron validadores.
- Validación de las cuatro skills editadas con `skill-creator/quick_validate.py`.
- Enlaces y anclas locales de documentación propia comprobados, incluidos nuevos
  archivos y rutas cruzadas; las referencias de terceros no se reescribieron.
- Conservación del historial y `git diff --check` comprobados.
- El diff contra los HEAD actuales contiene solo Markdown y reglas Markdown de
  Cursor. No se ejecutaron migraciones, integración con bases, llamadas al
  proveedor IA, navegador ni despliegues para verificar cambios de prosa.

## Límites y pendientes

La auditoría no certifica producción, cuentas/permisos Meta, precios, retiro de
modelos, vulnerabilidades actuales ni resultados de pruebas históricas. Esas
afirmaciones quedan fechadas o sujetas a comprobación específica. No se recuperó
evidencia temporal ausente ni se fabricaron reemplazos. FileMaker mantiene su
aceptación pendiente y la IA a solicitud su despliegue pendiente según registro.
El estado breve recoge esos límites; este informe no crea otro backlog.

> Nota posterior (15/10, noche): la IA a solicitud (`9efdd1f`) sí estaba desplegada
> a las 19:46; el registro que leyó esta auditoría aún no lo decía. Corregido en el estado breve.
