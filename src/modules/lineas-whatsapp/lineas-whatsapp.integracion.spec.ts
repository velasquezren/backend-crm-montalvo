import { ActividadesController } from '../actividades/actividades.controller';
import { ActividadesService } from '../actividades/actividades.service';
import { PrimerContactoService } from '../leads/primer-contacto.service';
import { createHmac } from "node:crypto";
import { INestApplication, Module, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../../prisma/prisma.service";
import { Rol } from "../../prisma/prisma-client";
import { AuditService } from "../../common/audit/audit.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { MetaSignatureGuard } from "../../common/guards/meta-signature.guard";
import { AllExceptionsFilter } from "../../common/filters/all-exceptions.filter";
import { R2Service } from "../../common/storage/r2.service";
import { PushService } from "../../common/push/push.service";
import { WhatsappCloudService } from "../../common/whatsapp/whatsapp-cloud.service";
import { AlertasWhatsappService } from "../../common/whatsapp/alertas-whatsapp.service";
import { AuthService } from "../auth/auth.service";
import { AuthController } from "../auth/auth.controller";
import { UsuariosService } from "../usuarios/usuarios.service";
import { UsuariosController } from "../usuarios/usuarios.controller";
import { ClientesService } from "../clientes/clientes.service";
import { ClientesController } from "../clientes/clientes.controller";
import { ServiciosService } from "../servicios/servicios.service";
import { MemoriaAgenteService } from "../memoria-agente/memoria-agente.service";
import { ConversacionesService } from "../conversaciones/conversaciones.service";
import { ConversacionesController } from "../conversaciones/conversaciones.controller";
import { ConversacionesGateway } from "../conversaciones/conversaciones.gateway";
import { DespachadorSalienteService } from "../conversaciones/despachador-saliente.service";
import { MediaEntranteService } from "../conversaciones/media-entrante.service";
import { IngestaWhatsappService } from "../conversaciones/ingesta-whatsapp.service";
import { AcuseAutomaticoService } from "../conversaciones/acuse-automatico.service";
import { WhatsappWebhookController } from "../conversaciones/webhooks/whatsapp-webhook.controller";
import { LineasWhatsappController } from "./lineas-whatsapp.controller";
import { LineasWhatsappService } from "./lineas-whatsapp.service";

const prisma = new PrismaService(
  "postgresql://crm_app:crm_dev_local@127.0.0.1:5433/crm_test",
);
const VENTAS = "00000000-0000-4000-8000-000000000001";
const CLIMON = "00000000-0000-4000-8000-000000000002";
const RECEPCION = "00000000-0000-4000-8000-000000000003";
const password = "Lineas-prueba-local!";
const secreto = "firma-ficticia-solo-test";
const config = new ConfigService({
  META_APP_SECRET: secreto,
  WHATSAPP_CLIMON_TOKEN: "token-climon",
  WHATSAPP_TOKEN: "token-ventas",
  WHATSAPP_PHONE_ID: "101",
  WHATSAPP_WABA_ID: "1001",
});
const push = { enviarAUsuario: jest.fn().mockResolvedValue(undefined) };
const r2 = {
  urlFirmada: jest.fn(async (key: string) => `https://archivos.test/${key}`),
};
@Module({
  imports: [
    JwtModule.register({
      secret: "jwt-ficticio-lineas",
      signOptions: { expiresIn: "15m" },
    }),
  ],
  controllers: [
    AuthController,
    UsuariosController,
    ClientesController,
    ActividadesController,
    ConversacionesController,
    LineasWhatsappController,
    WhatsappWebhookController,
  ],
  providers: [
    AuthService,
    UsuariosService,
    ClientesService,
    ActividadesService,
    ServiciosService,
    AuditService,
    MemoriaAgenteService,
    ConversacionesService,
    ConversacionesGateway,
    DespachadorSalienteService,
    MediaEntranteService,
    IngestaWhatsappService,
    PrimerContactoService,
    AcuseAutomaticoService,
    WhatsappCloudService,
    AlertasWhatsappService,
    LineasWhatsappService,
    MetaSignatureGuard,
    { provide: PrismaService, useValue: prisma },
    { provide: ConfigService, useValue: config },
    { provide: R2Service, useValue: r2 },
    { provide: PushService, useValue: push },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
class AplicacionLineas {}
let app: INestApplication;
let base: string;
let hash: string;
let comercial: string;
let clinico: string;
let paciente: string;
let usuarios: Record<string, { id: string; token: string }>;
const fetchReal = global.fetch;
const salidas: Array<{
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}> = [];
async function http(
  actor: string,
  ruta: string,
  method = "GET",
  body?: unknown,
) {
  const r = await fetchReal(base + ruta, {
    method,
    headers: {
      Authorization: `Bearer ${usuarios[actor].token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: r.status,
    body: (await r.json()) as Record<string, unknown>,
  };
}
async function alta(nombre: string, rol: Rol, lineas: string[]) {
  const u = await prisma.usuario.create({
    data: {
      nombre,
      email: `${nombre}@lineas.test`,
      passwordHash: hash,
      rol,
      lineasWhatsapp: { create: lineas.map((lineaId) => ({ lineaId })) },
    },
  });
  const login = await app.get(AuthService).login({ email: u.email, password });
  return { id: u.id, token: login.access_token };
}
async function limpiar() {
  await prisma.actividad.deleteMany({ where: { agente: { email: { endsWith: '@lineas.test' } } } });
  await prisma.cliente.deleteMany({
    where: { telefono: { startsWith: "+59179991" } },
  });
  await prisma.auditLog.deleteMany({
    where: {
      usuarioId: {
        in: (
          await prisma.usuario.findMany({
            where: { email: { endsWith: "@lineas.test" } },
            select: { id: true },
          })
        ).map((u) => u.id),
      },
    },
  });
  await prisma.usuario.deleteMany({
    where: { email: { endsWith: "@lineas.test" } },
  });
}
async function esperar(condicion: () => boolean) {
  const fin = Date.now() + 2500;
  while (!condicion() && Date.now() < fin)
    await new Promise((r) => setTimeout(r, 10));
  expect(condicion()).toBe(true);
}
async function webhook(phoneId: string | undefined, id: string) {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: phoneId ? { phone_number_id: phoneId } : undefined,
              contacts: [
                {
                  wa_id: "59179991999",
                  profile: { name: "Paciente multicanal" },
                },
              ],
              messages: [
                {
                  from: "59179991999",
                  id,
                  type: "text",
                  text: { body: "Consulta de prueba" },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  return fetchReal(base + "/webhooks/whatsapp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256":
        "sha256=" + createHmac("sha256", secreto).update(body).digest("hex"),
    },
    body,
  });
}
beforeAll(async () => {
  hash = await bcrypt.hash(password, 4);
  app = await NestFactory.create(AplicacionLineas, {
    logger: false,
    abortOnError: false,
    rawBody: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
});
beforeEach(async () => {
  await limpiar();
  salidas.length = 0;
  push.enviarAUsuario.mockClear();
  jest.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    salidas.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {},
    });
    return new Response(
      JSON.stringify({
        messages: [{ id: `wamid.salida.${salidas.length}` }],
        /* Las plantillas aprobadas de cualquier WABA: el envío las consulta
           antes de salir para validar variables y componer el texto. */
        data: String(input).includes("/message_templates")
          ? [
              { name: "saludo", status: "APPROVED", category: "UTILITY", language: "es", components: [{ type: "BODY", text: "Hola" }] },
              { name: "recordatorio_cita", status: "APPROVED", category: "UTILITY", language: "es", components: [{ type: "BODY", text: "Recordatorio de cita" }] },
            ]
          : [],
      }),
      { status: 200 },
    );
  });
  await prisma.lineaWhatsapp.update({
    where: { id: CLIMON },
    data: { phoneNumberId: "102", wabaId: "1002", activa: true },
  });
  usuarios = {
    recepcion: await alta("recepcion", "RECEPCION", [CLIMON]),
    otra: await alta("otra", "RECEPCION", [RECEPCION]),
    ventas: await alta("ventas", "AGENTE", [VENTAS]),
    vacio: await alta("vacio", "AGENTE", []),
    admin: await alta("admin", "ADMIN", []),
    super: await alta("super", "SUPER_ADMIN", []),
  };
  const c = await prisma.cliente.create({
    data: {
      nombre: "Paciente compartido",
      telefono: "+59179991001",
      agenteId: usuarios.ventas.id,
      datosExtra: { referral: { titular: "Promoción privada ventas" } },
    },
  });
  paciente = c.id;
  const crear = async (lineaId: string, contenido: string) =>
    (
      await prisma.conversacion.create({
        data: {
          clienteId: paciente,
          lineaId,
          esperandoRespuesta: true,
          mensajes: {
            create: {
              direccion: "ENTRANTE",
              contenido,
              whatsappMsgId: `wamid.${lineaId}`,
            },
          },
        },
      })
    ).id;
  comercial = await crear(VENTAS, "Promoción solo ventas");
  clinico = await crear(CLIMON, "Consulta de laboratorio");
});
afterEach(async () => {
  jest.restoreAllMocks();
  await prisma.lineaWhatsapp.update({
    where: { id: CLIMON },
    data: { phoneNumberId: null, wabaId: null, activa: false },
  });
});
afterAll(async () => {
  await limpiar();
  await app?.close();
  await prisma.$disconnect();
});

it("recepción ve su número; ventas, otra recepción y usuarios sin líneas no heredan el pool", async () => {
  for (const [actor, ids] of [
    ["recepcion", [clinico]],
    ["ventas", [comercial]],
    ["otra", []],
    ["vacio", []],
    ["admin", [comercial, clinico]],
  ] as const) {
    const r = await http(actor, "/conversaciones");
    expect(r.status).toBe(200);
    expect(
      (r.body.datos as Array<{ id: string }>)
        .map((c) => c.id)
        .filter((id) => [comercial, clinico].includes(id))
        .sort(),
    ).toEqual([...ids].sort());
    expect(
      (r.body.contadores as { total: number }).total,
    ).toBeGreaterThanOrEqual(ids.length);
  }
  const catalogo = await http("recepcion", "/lineas-whatsapp");
  expect(catalogo.body.datos).toEqual([
    expect.objectContaining({ id: CLIMON, telefono: "+59162140323" }),
  ]);
  expect(JSON.stringify(catalogo.body)).not.toMatch(
    /tokenEnv|phoneNumberId|token-climon/,
  );
});
it("filtros, búsqueda y resumen no amplían el permiso de línea", async () => {
  const r = await http(
    "recepcion",
    `/conversaciones?lineaId=${VENTAS}&busqueda=Promoción`,
  );
  expect(r.body.total).toBe(0);
  expect((r.body.contadores as { total: number }).total).toBe(0);
  expect(
    (await http("recepcion", `/conversaciones/${comercial}/resumen`)).body
      .conversacion,
  ).toBeNull();
});
it.each([
  "",
  "/mensajes-anteriores?antesDe=2030-01-01T00:00:00Z",
  "/buscar-mensajes?query=Promoción",
])("recepción no lee el chat comercial por enlace %s", async (sufijo) => {
  expect(
    (await http("recepcion", `/conversaciones/${comercial}${sufijo}`)).status,
  ).toBe(404);
});
it.each([
  ["/mensajes", { contenido: "Intrusión" }],
  ["/leido", {}],
  [
    "/plantilla",
    {
      plantilla: "saludo",
      idioma: "es",
      contenido: "Intrusión",
      parametros: [],
    },
  ],
])("recepción no muta el chat de ventas: %s", async (ruta, body) => {
  const antes = await prisma.mensaje.count();
  expect(
    (
      await http(
        "recepcion",
        `/conversaciones/${comercial}${ruta}`,
        "POST",
        body,
      )
    ).status,
  ).toBe(404);
  expect(await prisma.mensaje.count()).toBe(antes);
  expect(salidas).toHaveLength(0);
});
it("la ficha clínica no revela campaña ni dueño comercial y recepción no entra en clientes", async () => {
  const c = (await http("recepcion", `/conversaciones/${clinico}`)).body
    .cliente as Record<string, unknown>;
  expect(c.datosExtra).toBeNull();
  expect(c.agenteId).toBeNull();
  expect((await http("recepcion", "/clientes")).status).toBe(403);
  expect((await http("recepcion", "/usuarios")).status).toBe(403);
});
it("envía y marca leído desde CLIMON sin cambiar la atribución de ventas", async () => {
  expect(
    (
      await http("recepcion", `/conversaciones/${clinico}/mensajes`, "POST", {
        contenido: "Respuesta clínica",
      })
    ).status,
  ).toBe(201);
  await esperar(() => salidas.length === 1);
  expect(salidas[0].url).toContain("/102/messages");
  expect(salidas[0].headers.get("Authorization")).toBe("Bearer token-climon");
  expect(
    (await prisma.cliente.findUniqueOrThrow({ where: { id: paciente } }))
      .agenteId,
  ).toBe(usuarios.ventas.id);
  expect(
    (await http("recepcion", `/conversaciones/${clinico}/leido`, "POST", {}))
      .status,
  ).toBe(201);
  await esperar(() => salidas.length === 2);
  expect(salidas[1].url).toContain("/102/messages");
});
it("no reutiliza un archivo del canal comercial en recepción", async () => {
  await prisma.mensaje.create({
    data: {
      conversacionId: comercial,
      direccion: "ENTRANTE",
      contenido: "",
      mediaKey: "wa/ventas/privado.pdf",
      mediaMime: "application/pdf",
    },
  });
  expect(
    (
      await http("recepcion", `/conversaciones/${clinico}/mensajes`, "POST", {
        contenido: "",
        mediaKey: "wa/ventas/privado.pdf",
        mediaMime: "application/pdf",
      })
    ).status,
  ).toBe(404);
  expect(salidas).toHaveLength(0);
});
it("plantillas se consultan por WABA autorizada, nunca por la cuenta global", async () => {
  expect(
    (
      await http(
        "recepcion",
        `/conversaciones/meta/plantillas?lineaId=${VENTAS}`,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await http(
        "recepcion",
        `/conversaciones/meta/plantillas?lineaId=${CLIMON}&refresh=true`,
      )
    ).status,
  ).toBe(200);
  expect(salidas[0].url).toContain("/1002/message_templates");
  expect(salidas[0].headers.get("Authorization")).toBe("Bearer token-climon");
});
it("la reasignación exige acceso a esa línea y conserva otras conversaciones", async () => {
  expect(
    (
      await http("admin", `/conversaciones/${clinico}/agente`, "PATCH", {
        agenteId: usuarios.ventas.id,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await http("admin", `/conversaciones/${clinico}/agente`, "PATCH", {
        agenteId: usuarios.recepcion.id,
      })
    ).status,
  ).toBe(200);
  expect(
    (await prisma.conversacion.findUniqueOrThrow({ where: { id: comercial } }))
      .agenteId,
  ).toBeNull();
});
it("solo superadmin asigna líneas; recepción no admite la comercial y el perfil no permite elevar permisos", async () => {
  const ruta = `/usuarios/${usuarios.recepcion.id}`;
  expect(
    (await http("admin", ruta, "PATCH", { lineaIds: [RECEPCION] })).status,
  ).toBe(403);
  expect(
    (await http("super", ruta, "PATCH", { lineaIds: [VENTAS] })).status,
  ).toBe(400);
  expect(
    (
      await http("recepcion", "/auth/perfil", "PATCH", {
        nombre: "Recepción",
        lineaIds: [VENTAS],
        rol: "SUPER_ADMIN",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await prisma.accesoLineaWhatsapp.findMany({
        where: { usuarioId: usuarios.recepcion.id },
      })
    ).map((a) => a.lineaId),
  ).toEqual([CLIMON]);
});
it("cambiar líneas revoca el JWT anterior y no deja conversaciones asignadas fuera de alcance", async () => {
  await prisma.conversacion.update({
    where: { id: clinico },
    data: { agenteId: usuarios.recepcion.id },
  });
  expect(
    (
      await http("super", `/usuarios/${usuarios.recepcion.id}`, "PATCH", {
        lineaIds: [RECEPCION],
      })
    ).status,
  ).toBe(200);
  expect((await http("recepcion", "/conversaciones")).status).toBe(401);
  expect(
    (await prisma.conversacion.findUniqueOrThrow({ where: { id: clinico } }))
      .agenteId,
  ).toBeNull();
});
it("webhook firmado conserva metadata, separa dos líneas del mismo paciente y deduplica reintentos", async () => {
  expect((await webhook("102", "wamid.multi.climon")).status).toBe(200);
  expect((await webhook("101", "wamid.multi.ventas")).status).toBe(200);
  expect((await webhook("102", "wamid.multi.climon")).status).toBe(200);
  const chats = await prisma.conversacion.findMany({
    where: { cliente: { telefono: "+59179991999" } },
    include: { mensajes: true },
  });
  expect(chats).toHaveLength(2);
  expect(new Set(chats.map((c) => c.clienteId)).size).toBe(1);
  expect(
    chats
      .find((c) => c.lineaId === CLIMON)
      ?.mensajes.map((m) => m.whatsappMsgId),
  ).toEqual(["wamid.multi.climon"]);
  expect(
    await prisma.lead.count({ where: { clienteId: chats[0].clienteId } }),
  ).toBe(1);
});
/* Responde 200, no 503, ADREDE: un número sin registrar es un fallo permanente
   y el reintento que pide un 503 nunca podría entrar — Meta acabaría
   desactivando la suscripción de la app, que es la misma para las cuatro
   líneas. Lo que NO cambia y es lo que de verdad protege esta prueba: no se
   persiste nada y nada cae en ventas. */
it.each([undefined, "999999"])(
  "webhook con línea desconocida %s se descarta con 200 y no cae en ventas",
  async (phoneId) => {
    const antes = await prisma.mensaje.count();
    const chatsAntes = await prisma.conversacion.count();
    expect((await webhook(phoneId, "wamid.no-registrado")).status).toBe(200);
    expect(await prisma.mensaje.count()).toBe(antes);
    expect(await prisma.conversacion.count()).toBe(chatsAntes);
  },
);
it("status de otra línea no adopta ni modifica un mensaje saliente", async () => {
  const m = await prisma.mensaje.create({
    data: {
      conversacionId: comercial,
      direccion: "SALIENTE",
      contenido: "Ventas",
      whatsappMsgId: "wamid.estado",
      estadoEnvio: "INCIERTO",
    },
  });
  await app
    .get(ConversacionesService)
    .procesarEstadoMensaje("wamid.estado", "read", m.id, CLIMON);
  expect(
    (await prisma.mensaje.findUniqueOrThrow({ where: { id: m.id } }))
      .estadoEnvio,
  ).toBe("INCIERTO");
});
it("push usa el mismo alcance que REST y no avisa de ventas a recepción", async () => {
  app
    .get(ConversacionesGateway)
    .notificarEntrante(comercial, { texto: "Promoción privada" });
  const admins = (
    await prisma.usuario.findMany({
      where: { activo: true, rol: { in: ["ADMIN", "SUPER_ADMIN"] } },
      select: { id: true },
    })
  ).map((u) => u.id);

  /* Se miran SOLO los avisos de ESTE chat (por su `tag`) y SOLO los usuarios de
     esta suite. Antes se exigía un total exacto de llamadas al mock y eso la
     hacía flaky —2 de cada 4 corridas de la suite completa, nunca al correrla
     sola—: `crm_test` es compartido y otras tres suites (`autorizacion-http`,
     `inbox-escala`, `conversaciones`) crean usuarios CON acceso a la línea
     comercial. Si alguna corre antes —el orden de archivos de jest no es
     estable entre corridas— esos usuarios son destinatarios LEGÍTIMOS de un
     chat comercial sin asignar, y el conteo exacto se rompe. No era un fallo
     del producto: era una prueba afirmando aislamiento de fixtures en vez de
     permisos. Lo que de verdad protege —quién entra y quién no— se afirma
     ahora explícitamente, y por eso es más fuerte que el conteo que sustituye. */
  const avisosDelChat = () =>
    push.enviarAUsuario.mock.calls
      .filter((c) => (c[1] as { tag?: string })?.tag === `chat-${comercial}`)
      .map((c) => c[0] as string);

  await esperar(() =>
    [usuarios.ventas.id, ...admins].every((id) => avisosDelChat().includes(id)),
  );
  /* Y a quien no le toca no le llega: recepción de otra línea, recepción sin la
     comercial y un agente sin ninguna línea. */
  for (const ajeno of [
    usuarios.recepcion.id,
    usuarios.otra.id,
    usuarios.vacio.id,
  ])
    expect(avisosDelChat()).not.toContain(ajeno);

  expect(
    (await app.get(LineasWhatsappService).destinatarios(clinico)).sort(),
  ).toEqual([usuarios.recepcion.id, ...admins].sort());
});

it("solo superadmin configura; no permite activar sin credenciales ni duplicar números", async () => {
  expect(
    (
      await http("admin", `/lineas-whatsapp/${RECEPCION}`, "PATCH", {
        activa: true,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await http("super", `/lineas-whatsapp/${RECEPCION}`, "PATCH", {
        activa: true,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await http("super", `/lineas-whatsapp/${RECEPCION}`, "PATCH", {
        phoneNumberId: "102",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await http("super", `/lineas-whatsapp/${CLIMON}`, "PATCH", {
        phoneNumberId: "103",
      })
    ).status,
  ).toBe(400);
});

it("el socket de recepción recibe chats asignados y sus recordatorios, sin avisos ajenos", async () => {
  await prisma.conversacion.update({ where: { id: clinico }, data: { agenteId: usuarios.admin.id } });
  const ws = new WebSocket(
    base.replace("http:", "ws:") + "/socket.io/?EIO=4&transport=websocket",
  );
  const paquetes: string[] = [];
  try {
    ws.addEventListener("message", (e) => {
      const p = String(e.data);
      paquetes.push(p);
      if (p.startsWith("0"))
        ws.send(
          "40/realtime," + JSON.stringify({ token: usuarios.recepcion.token }),
        );
      if (p === "2") ws.send("3");
    });
    await esperar(() => paquetes.some((p) => p.startsWith("40/realtime,")));
    const gateway = app.get(ConversacionesGateway);
    gateway.emitirActividad(comercial);
    gateway.emitirActividad(clinico);
    await esperar(() => paquetes.some((p) => p.includes(clinico)));
    expect(paquetes.some((p) => p.includes(comercial))).toBe(false);
    gateway.emitirRecordatorioActividad('recordatorio-ajeno', usuarios.ventas.id);
    gateway.emitirRecordatorioActividad('recordatorio-propio', usuarios.recepcion.id);
    await esperar(() => paquetes.some(p => p.includes('recordatorio-propio')));
    expect(paquetes.some(p => p.includes('recordatorio-ajeno'))).toBe(false);
    await app
      .get(UsuariosService)
      .update(usuarios.recepcion.id, { lineaIds: [] });
    gateway.emitirActividad(clinico);
    await esperar(() => paquetes.some((p) => p === "41/realtime,"));
    expect(paquetes.filter((p) => p.includes(clinico))).toHaveLength(1);
  } finally {
    ws.close();
  }
});


it.each(['ventas', 'otra', 'admin', 'super'])(
  'recepción lee y responde el chat asignado a %s sin cambiar su responsable',
  async responsable => {
    await prisma.conversacion.update({ where: { id: clinico }, data: { agenteId: usuarios[responsable].id } });
    const lista = await http('recepcion', '/conversaciones');
    expect(lista.status).toBe(200);
    expect(lista.body.datos).toEqual(expect.arrayContaining([expect.objectContaining({ id: clinico })]));
    expect((await http('recepcion', `/conversaciones/${clinico}/resumen`)).body.conversacion).toEqual(expect.objectContaining({ id: clinico }));
    for (const sufijo of ['', '/mensajes-anteriores?antesDe=2099-01-01T00:00:00.000Z', '/buscar-mensajes?query=laboratorio']) {
      expect((await http('recepcion', `/conversaciones/${clinico}${sufijo}`)).status).toBe(200);
    }
    expect((await http('recepcion', `/conversaciones/${clinico}/leido`, 'POST', {})).status).toBe(201);
    expect((await http('recepcion', `/conversaciones/${clinico}/mensajes`, 'POST', { contenido: 'Te atiende recepción' })).status).toBe(201);
    expect((await http('recepcion', `/conversaciones/${clinico}/plantilla`, 'POST', {
      plantilla: 'recordatorio_cita', idioma: 'es',
    })).status).toBe(201);
    /* leído + texto + consulta de plantillas + plantilla. */
    await esperar(() => salidas.filter(s => !s.url.includes('/message_templates')).length >= 3);
    expect((await prisma.conversacion.findUniqueOrThrow({ where: { id: clinico } })).agenteId).toBe(usuarios[responsable].id);
    expect((await prisma.cliente.findUniqueOrThrow({ where: { id: paciente } })).agenteId).toBe(usuarios.ventas.id);
    expect((await http('recepcion', '/conversaciones')).body.datos).toEqual(expect.arrayContaining([expect.objectContaining({ id: clinico })]));
    const destinatarios = await app.get(LineasWhatsappService).destinatarios(clinico);
    expect(destinatarios).toContain(usuarios.recepcion.id);
    expect(destinatarios).not.toContain(usuarios.otra.id);
  },
);

it('un agente con la misma línea conserva la restricción por responsable', async () => {
  await prisma.accesoLineaWhatsapp.create({ data: { usuarioId: usuarios.ventas.id, lineaId: CLIMON } });
  await prisma.conversacion.update({ where: { id: clinico }, data: { agenteId: usuarios.admin.id } });
  expect((await http('ventas', `/conversaciones/${clinico}`)).status).toBe(404);
  expect((await http('ventas', `/conversaciones/${clinico}/mensajes`, 'POST', { contenido: 'No permitido' })).status).toBe(404);
  expect((await http('ventas', '/conversaciones')).body.datos).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: clinico })]));
  expect(await app.get(LineasWhatsappService).destinatarios(clinico)).not.toContain(usuarios.ventas.id);
});

it('recepción agenda pacientes de sus líneas, con actividades personales y sin acceso comercial', async () => {
  await prisma.conversacion.update({ where: { id: clinico }, data: { agenteId: usuarios.admin.id } });
  const contactos = await http('recepcion', '/actividades/pacientes?q=compartido');
  expect(contactos.status).toBe(200);
  expect(contactos.body.datos).toEqual([{ id: paciente, nombre: 'Paciente compartido', telefono: '+59179991001', pac: null }]);
  expect((await http('otra', '/actividades/pacientes?q=compartido')).body.datos).toEqual([]);
  const datos = { clienteId: paciente, tipo: 'REUNION', titulo: 'Confirmar asistencia', fechaProgramada: new Date(Date.now() + 3600000).toISOString(), agenteId: usuarios.ventas.id };
  const creada = await http('recepcion', '/actividades', 'POST', datos);
  expect(creada.status).toBe(201);
  expect(creada.body.agenteId).toBe(usuarios.recepcion.id);
  const id = creada.body.id;
  expect((await http('recepcion', '/actividades')).body.datos).toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
  expect((await http('recepcion', '/actividades/resumen')).status).toBe(200);
  expect((await http('recepcion', `/actividades/${id}`, 'PATCH', { clienteId: paciente, titulo: 'Confirmación pendiente' })).status).toBe(200);
  expect((await http('otra', `/actividades/${id}`)).status).toBe(404);
  expect((await http('otra', `/actividades/${id}/estado`, 'PATCH', { estado: 'COMPLETADA' })).status).toBe(404);
  expect((await http('otra', '/actividades', 'POST', datos)).status).toBe(404);
  expect((await http('recepcion', '/actividades', 'POST', { ...datos, leadId: 'lead-ajeno' })).status).toBe(400);
  expect((await http('recepcion', `/actividades/${id}/estado`, 'PATCH', { estado: 'COMPLETADA' })).status).toBe(200);
  for (const ruta of ['/clientes', '/usuarios']) expect((await http('recepcion', ruta)).status).toBe(403);
});
