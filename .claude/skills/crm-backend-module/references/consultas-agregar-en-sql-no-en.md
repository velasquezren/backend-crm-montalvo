# Consultas: agregar en SQL, no en JS

> Parte de la skill `crm-backend-module`: lee antes su [índice](../SKILL.md).

Prohibido traer filas para contarlas o sumarlas en memoria:

```ts
// ❌ carga todas las ventas del cliente
const ventas = await this.prisma.venta.findMany({ where: { clienteId } });
const total = ventas.reduce((s, v) => s + Number(v.monto), 0);

// ✅ la base devuelve solo el número
const { _sum, _count } = await this.prisma.venta.aggregate({
  where: { clienteId, estado: 'GANADA' },
  _sum: { monto: true },
  _count: true,
});
```

Usa `$transaction([...])` para lanzar en paralelo las consultas independientes (típico: página + total).
