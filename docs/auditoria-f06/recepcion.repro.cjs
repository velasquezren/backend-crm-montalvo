/**
 * Reproducción de F06-R2 ABIERTO, fuera de la suite de regresión.
 * F06-R1 pasó a media-entrante.integracion.spec.ts (PostgreSQL real).
 * Desde la raíz del backend: npm run build
 * node --test docs/auditoria-f06/recepcion.repro.cjs
 *
 * Las aserciones expresan la recuperación deseada: se espera exit 1 mientras
 * persistan los defectos. Ejecuta los servicios compilados con dobles locales;
 * no abre PostgreSQL, no carga .env y no llama a Meta/R2 ni manda avisos.
 * No demuestra atomicidad ni concurrencia de PostgreSQL.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Logger } = require('../../node_modules/@nestjs/common');
const { IngestaWhatsappService } = require('../../dist/modules/conversaciones/ingesta-whatsapp.service');

Logger.overrideLogger(false);

function montar({ falloMensaje = false, falloLead = false, conMedia = false } = {}) {
  const estado = { conversacion: null, mensaje: null, leads: [], descargas: 0, avisos: 0 };
  const cliente = { id: 'cliente-sintetico', nombre: 'Paciente ficticia', telefono: '+59170000001', agenteId: null };
  const prisma = {
    lineaWhatsapp: { findUniqueOrThrow: async () => ({ comercial: true }) },
    conversacion: {
      findUnique: async () => estado.conversacion,
      create: async () => (estado.conversacion = { id: 'chat-sintetico', agenteId: null }),
      update: () => () => estado.conversacion,
    },
    mensaje: {
      findUnique: async () => estado.mensaje,
      // Prisma difiere estas operaciones hasta $transaction; el doble también.
      create: ({ data }) => () => (estado.mensaje = { id: 'mensaje-sintetico', mediaKey: null, ...data }),
      update: async ({ data }) => Object.assign(estado.mensaje, data),
    },
    lead: {
      create: async ({ data }) => {
        if (falloLead) {
          falloLead = false;
          throw new Error('fallo transitorio de lead simulado');
        }
        estado.leads.push(data);
        return data;
      },
    },
    $transaction: async operaciones => {
      if (falloMensaje) {
        falloMensaje = false;
        throw new Error('fallo transitorio de mensaje simulado');
      }
      return operaciones.map(ejecutar => ejecutar());
    },
  };
  const gateway = {
    notificarEntrante: () => { estado.avisos++; },
    emitirActividad: () => {},
  };
  const media = { despertar: () => {} };
  const servicio = new IngestaWhatsappService(
    prisma, { obtenerOCrearPorTelefono: async () => cliente }, gateway,
    { decidir: () => null }, {}, media,
  );
  const recibir = () => servicio.procesarEntrante(
    cliente.telefono, 'mensaje ficticio', 'wamid.sintetico', cliente.nombre,
    conMedia ? { tipo: 'IMAGEN', mediaId: 'media-sintetica', mime: 'image/jpeg' } : undefined,
  );
  return { estado, recibir };
}

test('control: repetir un texto ya persistido conserva un mensaje, un lead y un aviso', async () => {
  const { estado, recibir } = montar();
  const primero = await recibir();
  const repetido = await recibir();
  assert.equal(repetido, primero);
  assert.equal(estado.leads.length, 1);
  assert.equal(estado.avisos, 1);
});

test('F06-R2a: un reintento debe recuperar el lead cuyo INSERT falló', async () => {
  const { estado, recibir } = montar({ falloLead: true });
  await recibir();
  assert.ok(estado.mensaje);
  assert.equal(estado.avisos, 1, 'El fallo del lead conserva el aviso a la agente');
  await recibir();
  assert.equal(estado.leads.length, 1,
    'El INSERT fallido se captura y el mensaje duplicado impide volver a intentarlo');
});

test('F06-R2b: un reintento debe crear el lead si el primer mensaje falló después de crear el chat', async () => {
  const { estado, recibir } = montar({ falloMensaje: true });
  await assert.rejects(recibir, /fallo transitorio de mensaje/);
  assert.ok(estado.conversacion);
  assert.equal(estado.mensaje, null);
  await recibir();
  assert.ok(estado.mensaje, 'El mensaje sí se recupera en el segundo intento');
  assert.equal(estado.leads.length, 1,
    'El chat ya existe: esNueva=false deja el primer contacto sin lead');
});
