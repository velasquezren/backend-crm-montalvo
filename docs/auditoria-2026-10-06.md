# Revisión del CRM y Resultados — 6 de octubre de 2026

## Contexto y alcance

La clínica atiende por WhatsApp, solicita citas y ofrece promociones. Una solicitud
de cita todavía no reserva un horario en la agenda clínica. Los pagos por QR exigen
verificación humana y crean ventas mediante VentasService. FileMaker genera los
informes; Resultados publica el PDF y el CRM permite avisar a la paciente. La misma
referencia de estudio reemplaza su PDF conservando el acceso. Las comisiones se
contrastan con las planillas de la clínica.

Se revisaron los cuatro repositorios y se ejecutaron sus comprobaciones disponibles.
Bases iniciales: backend CRM `3f915b6`, frontend `f6361a6`, Resultados `f02e8bd`,
landing `37f3a47`. Las pruebas se ejecutaron localmente; los transportes externos se
simularon. No se enviaron mensajes ni se crearon ventas en producción para probar.

## Correcciones

1. **QR retomado después de 72 horas.** Antes se reenviaba el QR pero el siguiente
   comprobante ya no se reconocía. Ahora retomar renueva el plazo y conserva el mismo
   pago y monto, incluso si la promoción cambió de precio.
2. **Confirmación interrumpida.** Un pago reclamado sin venta enlazada parecía
   confirmado y podía desaparecer al cumplir 14 días. Ahora permanece visible como
   «Registro pendiente», impide iniciar otro cobro y permite a quien inició la
   confirmación completarla sin duplicar la venta.
3. **Aviso a la paciente.** Si fallaba el envío, por ejemplo por la ventana de 24 h,
   el CRM afirmaba que se le había avisado. Ahora distingue pago guardado de aviso
   preparado o no enviado, tanto al confirmar como al pedir otro comprobante.
4. **CI de Resultados.** La ejecución automática omitía la suite existente de
   adjuntos. Ahora ejecuta unitarias, integración de PDF e integración de adjuntos
   en serie, porque comparten la base de pruebas.

Los tres casos de pagos fallaron primero en pruebas de regresión y pasaron con las
correcciones. No se añadieron dependencias ni migraciones. Los campos nuevos de la
respuesta son aditivos y el frontend admite respuestas anteriores.

## Validación

| Área | Resultado |
| --- | --- |
| Backend CRM | Compilación, contratos/skills, Flows y tipos correctos; 876 unitarias y 808 de integración en PostgreSQL |
| Comisiones | Las 23 comprobaciones de diciembre se ejecutaron además con los Excel reales de 2025/2026 en la base local; no se omitieron por falta de fixtures |
| Frontend CRM | Compilación y tipos correctos; 621 pruebas |
| API Resultados | 72 pruebas de PDF, reemplazo, accesos y adjuntos con PostgreSQL aislado |
| Portal Resultados | Compilación Next y 5 pruebas de política de acceso |
| Landing | Compilación Next, lint, tipos y 17 pruebas |

Las 23 pruebas de comisiones pertenecen a las 808 de integración: no se suman dos
veces. En la primera ejecución de la suite completa faltaba configurar las carpetas
de Excel; la ejecución adicional las configuró y comprobó sus importes reales.
Las compilaciones Next aisladas usaron webpack por el enlace externo a node_modules.

La interfaz se revisó por código, según la guía del proyecto, sin navegador:
con 390 px el bloque conserva el ajuste de línea existente, el título flexible y el
detalle multilínea; la acción de completar aparece solo para la persona autorizada.
El detalle pendiente usa `role="status"` y nunca afirma que ya se registró la venta.

## Límites

Las pruebas no certifican todos los recorridos posibles ni la entrega real de Meta.
No se ejecutó cada presentación de FileMaker; el PDF completo de cada ecografía
sigue dependiendo del guion de exportación y su conjunto de registros correcto.
La restricción de interacciones a la línea de prueba y el catálogo de Flows de prueba
se conservan. Activar otras líneas y conectar una agenda real son tareas distintas.
El despliegue y su verificación deben constar por separado de estas pruebas locales.
