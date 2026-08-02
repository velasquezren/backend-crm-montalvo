-- Búsqueda por texto: hacer indexable el `ILIKE '%texto%'`.
--
-- El listado de pacientes ordenado por fecha ya volaba (0,2 ms con el índice de
-- `updatedAt`), pero en cuanto alguien escribía en el buscador la misma consulta
-- pasaba a Seq Scan sobre las 15.311 filas: un índice B-tree no sirve cuando el
-- patrón empieza por comodín. Medido sobre datos reales:
--
--   búsqueda sin resultados   40,9 ms  →  0,2 ms
--   conteo que la acompaña    29,0 ms  →  0,2 ms
--
-- Y el coste crece con la tabla: a 50.000 pacientes serían ~150 ms por tecleo.
--
-- `gin_trgm_ops` parte el texto en trigramas ("MARIA" → MAR, ARI, RIA) y los
-- indexa, que es lo que permite buscar por el medio de la palabra. Con términos
-- muy comunes el planificador seguirá eligiendo Seq Scan, y hace bien: si media
-- tabla coincide, recorrerla es más barato que el índice.
--
-- pg_trgm es una extensión "trusted" desde PostgreSQL 13, así que el usuario de
-- la aplicación puede instalarla sin ser superusuario (verificado en el servidor,
-- PostgreSQL 16.14).
--
-- Estos índices NO se pueden declarar en schema.prisma: el lenguaje de Prisma no
-- expresa GIN ni clases de operador. Viven solo aquí, igual que el índice parcial
-- de `saldoTotal`. Prisma no los ve y por eso tampoco intenta borrarlos.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Pacientes: es el buscador que más se usa y la tabla que más crece.
CREATE INDEX "Cliente_nombre_trgm_idx"   ON "Cliente" USING gin (nombre   gin_trgm_ops);
CREATE INDEX "Cliente_email_trgm_idx"    ON "Cliente" USING gin (email    gin_trgm_ops);
CREATE INDEX "Cliente_telefono_trgm_idx" ON "Cliente" USING gin (telefono gin_trgm_ops);

-- Filas del Excel de comisiones: se buscan al revisar la clasificación de un mes,
-- y la tabla suma unas 400-3.000 filas por planilla importada.
CREATE INDEX "VentaImportada_detalle_trgm_idx"  ON "VentaImportada" USING gin (detalle  gin_trgm_ops);
CREATE INDEX "VentaImportada_paciente_trgm_idx" ON "VentaImportada" USING gin (paciente gin_trgm_ops);
