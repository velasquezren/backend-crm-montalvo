# Auditoría

> Parte de la skill `crm-backend-module`: lee antes su [índice](../SKILL.md).

Toda mutación crítica (ventas, comisiones, clientes) llama a `AuditService.registrar()`.
Nunca debe tumbar la operación de negocio: ya está envuelto en try/catch.
