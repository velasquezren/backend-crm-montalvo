/** Comparación reproducible del SQL de mensajes, solo con fixtures sintéticos. */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const { PrismaService } = require('../dist/prisma/prisma.service.js');
const { Prisma } = require('../dist/prisma/prisma-client.js');
const { ultimosMensajesDeInbox } = require('../dist/modules/conversaciones/lectura-mensajes-inbox.js');
const url = process.env.CRM_TEST_DATABASE_URL;
const destino = url ? new URL(url) : null;
if (!destino || destino.pathname !== '/crm_test' || !['localhost', '127.0.0.1'].includes(destino.hostname)) {
  throw new Error('Requiere CRM_TEST_DATABASE_URL apuntando a crm_test en loopback. No lee .env.');
}
const prisma = new PrismaService(url);
const clientes = Array.from({ length: 50 }, () => randomUUID());
const chats = clientes.map(() => randomUUID());
const marca = randomUUID().slice(0, 8);
let consultaNueva;
const lector = { $queryRaw: consulta => { consultaNueva = consulta; return prisma.$queryRaw(consulta); } };
const antes = Prisma.sql`
  SELECT "conversacionId", id, contenido, direccion, "estadoEnvio", "codigoErrorEnvio",
    tipo, automatico, "createdAt", "mediaNombre"
  FROM "Mensaje" WHERE "conversacionId" IN (${Prisma.join(chats)}) ORDER BY "createdAt" DESC`;

async function medir(consulta) {
  const tiempos = [];
  let filas;
  for (let i = 0; i < 6; i++) {
    const inicio = performance.now();
    filas = await prisma.$queryRaw(consulta);
    if (i) tiempos.push(performance.now() - inicio); // descartar calentamiento
  }
  tiempos.sort((a, b) => a - b);
  const [explain] = await prisma.$queryRaw(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${consulta}`);
  return { filas: filas.length, bytesJson: Buffer.byteLength(JSON.stringify(filas)),
    medianaMs: Number(tiempos[2].toFixed(2)), plan: explain['QUERY PLAN'][0] };
}
try {
  await prisma.$connect();
  await prisma.cliente.createMany({ data: clientes.map((id, i) => ({ id, nombre: `Fixture inbox ${marca} ${i}`, telefono: `fixture-${marca}-${i}` })) });
  await prisma.conversacion.createMany({ data: chats.map((id, i) => ({ id, clienteId: clientes[i] })) });
  for (const conversacionId of chats) {
    await prisma.mensaje.createMany({ data: Array.from({ length: 500 }, (_, i) => ({
      conversacionId, direccion: 'ENTRANTE', contenido: `Mensaje sintético ${i}`,
      createdAt: new Date(Date.UTC(2026, 8, 1, 0, i)),
    })) });
  }
  const seleccion = await ultimosMensajesDeInbox(lector, chats);
  if (seleccion.size !== 50) throw new Error('No se recuperaron los 50 últimos mensajes');
  console.log(JSON.stringify({ escenario: '50 chats × 500 mensajes; loopback; cinco lecturas calientes',
    antes: await medir(antes), despues: await medir(consultaNueva) }, null, 2));
} finally {
  // Solo nuestras filas; nunca trunca ni borra tablas enteras.
  await prisma.cliente.deleteMany({ where: { id: { in: clientes } } });
  await prisma.$disconnect();
}
