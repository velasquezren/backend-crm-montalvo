/* Solo fixture de integración: PostgreSQL descartable, ningún cliente de red Meta. */
const { PrismaService } = require('../dist/prisma/prisma.service');
const { DespachadorSalienteService } = require('../dist/modules/conversaciones/despachador-saliente.service');
const { randomUUID } = require('node:crypto');
global.fetch = () => { throw new Error('Red externa prohibida en fixture'); };
async function main() {
  if (process.env.NODE_ENV !== 'test') throw new Error('Solo test');
  const prisma = new PrismaService('postgresql://crm_app@127.0.0.1:5433/crm_test');
  let envios = 0;
  try {
    const m = await prisma.mensaje.findUniqueOrThrow({ where: { id: process.argv[2] }, include: { conversacion: { include: { cliente: true } } } });
    const servicio = new DespachadorSalienteService(prisma, { emitirActividad() {} }, {}, {
      async enviar(_telefono, contenido) {
        if (contenido.type !== 'interactive') throw new Error('Se perdió la intención');
        if (process.argv[3] === 'interrumpir') { console.log('INTERRUMPIDO'); process.exit(0); }
        envios++;
        return { estado: 'ENVIADO', metaMsgId: `wamid.test.${randomUUID()}` };
      },
    }, { async cuentaDeConversacion() { return undefined; } });
    await servicio.interaccion({ mensajeId: m.id, conversacionId: m.conversacionId, telefono: m.conversacion.cliente.telefono });
    console.log(`ENVIOS:${envios}`);
  } finally { await prisma.$disconnect(); }
}
main().catch(() => { console.error('Falló fixture local'); process.exitCode = 1; });
