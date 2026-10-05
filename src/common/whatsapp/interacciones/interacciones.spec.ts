import {
  botonPlantilla,
  contenidoMeta,
  INTERACCIONES_ACTIVADAS,
  MensajePreparado,
  validarMensaje,
} from "./mensaje-interactivo";
import {
  parsearEstado,
  parsearRespuesta,
  resumenRespuesta,
} from "./respuesta-interactiva";
import {
  bienvenidaDemo,
  ContextoSimulado,
  estadoPreparacion,
  herramientasSinConexion,
  puedeOfrecerBienvenida,
  recepcionDemo,
  simularRespuesta,
} from "./preparacion-montalvo";
import { ContextoCosto, estimarCosto } from "./costo-interaccion";

/** Todo sintético; ningún teléfono, paciente, WABA o credencial real. */
const mensaje = (
  tipo = "button_reply",
  extra: Record<string, unknown> = {},
) => ({
  id: "wamid.synthetic.reply",
  type: "interactive",
  timestamp: "1791115200",
  context: { id: "wamid.synthetic.menu" },
  interactive: {
    type: tipo,
    [tipo]:
      tipo === "nfm_reply"
        ? {
            name: "flow",
            body: "Sent",
            response_json: JSON.stringify({
              flow_token: "synthetic-correlation",
              tipo: "SOLICITUD_DE_CITA",
              demo: true,
            }),
          }
        : { id: "BOOK_APPOINTMENT", title: "Solicitar cita" },
  },
  ...extra,
});
const ahora = Date.parse("2026-10-04T12:00:00Z");
const contexto = (extra: Partial<ContextoSimulado> = {}): ContextoSimulado => ({
  ahora,
  ultimaEntrada: ahora - 1000,
  conversacionId: "synthetic-chat",
  lineaId: "synthetic-reception",
  accesoAutorizado: true,
  linea: "recepcion",
  agenteAsignadoId: null,
  humanoAtendiendo: false,
  cerrada: false,
  metaDisponible: true,
  enviados: 0,
  limite: 3,
  bienvenidaOfrecida: false,
  asunto: "administrativo",
  correlacion: {
    contextoId: "wamid.synthetic.menu",
    opciones: ["BOOK_APPOINTMENT"],
    venceEn: ahora + 1000,
    flowToken: "synthetic-correlation",
  },
  mensajesVistos: [],
  ...extra,
});

describe("mensajes preparados sin transporte", () => {
  it("permanece desactivado y sin permiso de envío", () => {
    expect(INTERACCIONES_ACTIVADAS).toBe(false);
    expect(estadoPreparacion()).toEqual({
      habilitada: false,
      permiteEnvio: false,
    });
  });
  it("construye bienvenida y recepción con IDs estables", () => {
    expect(contenidoMeta(bienvenidaDemo)).toMatchObject({
      type: "interactive",
      interactive: {
        type: "button",
        action: {
          buttons: [
            { type: "reply", reply: { id: "BOOK_APPOINTMENT" } },
            {},
            {},
          ],
        },
      },
    });
    expect(contenidoMeta(recepcionDemo)).toMatchObject({
      interactive: { type: "list" },
    });
    expect(contenidoMeta({ tipo: "texto", cuerpo: "[DEMO] Texto" })).toEqual({
      type: "text",
      text: { body: "[DEMO] Texto" },
    });
  });
  it.each([
    {
      tipo: "botones",
      cuerpo: "x",
      opciones: Array.from({ length: 4 }, (_, i) => ({
        id: String(i),
        titulo: String(i),
      })),
    },
    {
      tipo: "botones",
      cuerpo: "x",
      opciones: [{ id: "x", titulo: "a".repeat(21) }],
    },
    {
      tipo: "botones",
      cuerpo: "x",
      opciones: [
        { id: "x", titulo: "A" },
        { id: "x", titulo: "B" },
      ],
    },
    {
      tipo: "botones",
      cuerpo: "x",
      opciones: [
        { id: "x", titulo: "A" },
        { id: "y", titulo: "A" },
      ],
    },
    { tipo: "botones", cuerpo: "x", opciones: [{ id: "x", titulo: "*A*" }] },
    { tipo: "botones", cuerpo: "x", opciones: [] },
    {
      tipo: "lista",
      cuerpo: "x",
      boton: "Ver",
      secciones: [
        {
          titulo: "A",
          opciones: Array.from({ length: 6 }, (_, i) => ({
            id: String(i),
            titulo: "A",
          })),
        },
        {
          titulo: "B",
          opciones: Array.from({ length: 5 }, (_, i) => ({
            id: `B${i}`,
            titulo: "B",
          })),
        },
      ],
    },
    { tipo: "texto", cuerpo: "x".repeat(4097) },
  ] as MensajePreparado[])("rechaza límites y opciones incompatibles %#", (m) =>
    expect(() => validarMensaje(m)).toThrow(),
  );
  it("límite total de lista y título de fila", () => {
    const m: MensajePreparado = {
      tipo: "lista",
      cuerpo: "x",
      boton: "Ver",
      secciones: [
        {
          titulo: "A",
          opciones: [
            { id: "x", titulo: "A".repeat(24), descripcion: "D".repeat(72) },
          ],
        },
      ],
    };
    expect(() => validarMensaje(m)).not.toThrow();
    m.secciones[0]!.opciones[0]!.titulo += "x";
    expect(() => validarMensaje(m)).toThrow();
  });
  it("Flow navigate y data_exchange son excluyentes", () => {
    const m: MensajePreparado = {
      tipo: "flow",
      cuerpo: "[DEMO]",
      flowId: "123",
      correlacion: "synthetic",
      cta: "Solicitar",
      modo: "draft",
      inicio: { accion: "navigate", pantalla: "ESPECIALIDAD" },
    };
    expect(contenidoMeta(m)).toMatchObject({
      interactive: {
        action: {
          parameters: {
            flow_message_version: "3",
            mode: "draft",
            flow_action_payload: { screen: "ESPECIALIDAD" },
          },
        },
      },
    });
    expect(
      JSON.stringify(
        contenidoMeta({ ...m, inicio: { accion: "data_exchange" } }),
      ),
    ).not.toContain("flow_action_payload");
  });
  it("distingue quick reply de plantilla y Flow de plantilla", () => {
    expect(
      botonPlantilla(1, { tipo: "quick_reply", id: "BOOK_APPOINTMENT" }),
    ).toMatchObject({
      sub_type: "quick_reply",
      index: "1",
      parameters: [{ payload: "BOOK_APPOINTMENT" }],
    });
    expect(
      botonPlantilla(0, { tipo: "flow", correlacion: "synthetic" }),
    ).toMatchObject({ sub_type: "flow", parameters: [{ type: "action" }] });
    expect(() =>
      botonPlantilla(-1, { tipo: "quick_reply", id: "x" }),
    ).toThrow();
  });
});

describe("parsing de respuestas sin perder identidad", () => {
  it.each(["button_reply", "list_reply"])("conserva %s y original", (tipo) => {
    const raw = mensaje(tipo);
    const r = parsearRespuesta(raw);
    expect(r.estado).toBe("valida");
    expect(r.seleccion).toMatchObject({ tipo, id: "BOOK_APPOINTMENT" });
    expect(JSON.parse(r.original!)).toEqual(raw);
    expect(r.contextoId).toBe("wamid.synthetic.menu");
  });
  it("conserva payload de template quick reply independiente de etiqueta", () => {
    const r = parsearRespuesta({
      id: "synthetic",
      type: "button",
      button: { text: "Etiqueta nueva", payload: "TALK_TO_HUMAN" },
    });
    expect(r.seleccion).toMatchObject({
      tipo: "template_reply",
      id: "TALK_TO_HUMAN",
    });
  });
  it("Flow conserva datos y correlación, sin mostrarlos en UI", () => {
    const r = parsearRespuesta(mensaje("nfm_reply"));
    expect(r.seleccion).toMatchObject({
      tipo: "nfm_reply",
      datos: { tipo: "SOLICITUD_DE_CITA" },
    });
    expect(resumenRespuesta(r)).toContain("no confirma una cita");
    expect(resumenRespuesta(r)).not.toContain("synthetic-correlation");
  });
  it.each(["{broken", "[]", "null", "42", '"texto"'])(
    "Flow JSON inválido %s no lanza ni pierde original",
    (response_json) => {
      const r = parsearRespuesta(
        mensaje("nfm_reply", {
          interactive: {
            type: "nfm_reply",
            nfm_reply: { name: "flow", response_json },
          },
        }),
      );
      expect(r.estado).toBe("invalida");
      expect(r.original).not.toBeNull();
    },
  );
  it("preserva desconocidos sin ejecutar y acota tamaño", () => {
    expect(parsearRespuesta(mensaje("future_type")).estado).toBe("desconocida");
    expect(
      parsearRespuesta({ id: "x", contenido: "x".repeat(66000) }),
    ).toMatchObject({ estado: "invalida", original: null });
    expect(parsearRespuesta(null).estado).toBe("invalida");
  });
  it("no convierte título sin ID en acción", () => {
    expect(
      parsearRespuesta(
        mensaje("button_reply", {
          interactive: {
            type: "button_reply",
            button_reply: { title: "BOOK_APPOINTMENT" },
          },
        }),
      ).estado,
    ).toBe("invalida");
  });
  it("conserva pricing y código de error; estados futuros no se inventan", () => {
    expect(
      parsearEstado({
        id: "synthetic",
        status: "delivered",
        pricing: {
          billable: true,
          pricing_model: "PMP",
          type: "regular",
          category: "service",
        },
      }),
    ).toMatchObject({
      reconocido: true,
      pricing: { facturable: true, categoria: "service" },
    });
    expect(
      parsearEstado({
        id: "synthetic",
        status: "failed",
        errors: [{ code: 131049 }],
      })?.codigosError,
    ).toEqual([131049]);
    expect(
      parsearEstado({ id: "synthetic", status: "future" })?.reconocido,
    ).toBe(false);
  });
});

describe("simulador de decisiones: no asigna, no envía, no reserva", () => {
  const r = parsearRespuesta(mensaje());
  it("repetición de evento no propone otra acción", () =>
    expect(
      simularRespuesta(r, contexto({ mensajesVistos: [r.mensajeId!] }))
        .resultado,
    ).toBe("DUPLICADO"));
  it.each([
    [{ accesoAutorizado: false }, "SIN_ACCESO"],
    [{ humanoAtendiendo: true }, "HUMANO_EN_CONTROL"],
    [{ metaDisponible: false }, "META_NO_DISPONIBLE"],
    [{ enviados: 3 }, "LIMITE_ALCANZADO"],
    [{ ultimaEntrada: ahora - 86400000 }, "REQUIERE_PLANTILLA_APROBADA"],
    [{ ultimaEntrada: null }, "REQUIERE_PLANTILLA_APROBADA"],
  ] as [Partial<ContextoSimulado>, string][])(
    "guardas %j",
    (extra, resultado) =>
      expect(simularRespuesta(r, contexto(extra)).resultado).toBe(resultado),
  );
  it.each([
    [{ asunto: "clinico" }, "REQUIERE_REVISION_HUMANA"],
    [{ asunto: "desconocido" }, "REQUIERE_REVISION_HUMANA"],
    [{ cerrada: true }, "CONVERSACION_CERRADA"],
    [{ correlacion: undefined }, "RESPUESTA_TARDIA_O_SIN_CONTEXTO"],
    [
      {
        correlacion: {
          contextoId: "wamid.synthetic.menu",
          opciones: ["BOOK_APPOINTMENT"],
          venceEn: ahora,
        },
      },
      "RESPUESTA_TARDIA_O_SIN_CONTEXTO",
    ],
  ] as [Partial<ContextoSimulado>, string][])(
    "escalamiento conservador %j",
    (extra, motivo) =>
      expect(simularRespuesta(r, contexto(extra)).transferencia?.motivo).toBe(
        motivo,
      ),
  );
  it("una etiqueta nueva no cambia la acción", () => {
    const raw = mensaje();
    raw.interactive.button_reply = {
      id: "BOOK_APPOINTMENT",
      title: "Otra etiqueta",
    };
    expect(simularRespuesta(parsearRespuesta(raw), contexto()).accion).toBe(
      "BOOK_APPOINTMENT",
    );
  });
  it("opciones no ofrecidas no actúan", () =>
    expect(
      simularRespuesta(
        r,
        contexto({
          correlacion: {
            contextoId: r.contextoId!,
            opciones: [],
            venceEn: ahora + 1,
          },
        }),
      ).transferencia?.motivo,
    ).toBe("OPCION_NO_OFRECIDA"));
  it.each(["recepcion", "comercial"] as const)(
    "transferencia conserva contexto y responsable en %s",
    (linea) => {
      const raw = mensaje();
      raw.interactive.button_reply = {
        id: "TALK_TO_HUMAN",
        title: "Recepción",
      };
      const c = contexto({
        linea,
        agenteAsignadoId: linea === "comercial" ? "synthetic-agent" : null,
        correlacion: undefined,
      });
      const previo = structuredClone(c);
      expect(
        simularRespuesta(parsearRespuesta(raw), c).transferencia,
      ).toMatchObject({
        conversacionId: c.conversacionId,
        lineaId: c.lineaId,
        agenteAsignadoId: c.agenteAsignadoId,
        seleccion: "TALK_TO_HUMAN",
      });
      expect(c).toEqual(previo);
    },
  );
  it("Flow completado requiere validación y no puede confirmar", () => {
    const f = parsearRespuesta(mensaje("nfm_reply"));
    expect(simularRespuesta(f, contexto()).resultado).toBe(
      "FORMULARIO_PENDIENTE_VALIDACION",
    );
    expect(
      simularRespuesta(
        f,
        contexto({
          correlacion: {
            contextoId: f.contextoId!,
            opciones: [],
            venceEn: ahora + 1,
            flowToken: "otro",
          },
        }),
      ).transferencia?.motivo,
    ).toBe("FLOW_NO_CORRELACIONADO");
  });
  it("bienvenida se ofrece solo una vez y no interrumpe a la agente", () => {
    expect(puedeOfrecerBienvenida(contexto())).toBe(true);
    expect(puedeOfrecerBienvenida(contexto({ bienvenidaOfrecida: true }))).toBe(
      false,
    );
    expect(puedeOfrecerBienvenida(contexto({ humanoAtendiendo: true }))).toBe(
      false,
    );
  });
  it("falta de precio/disponibilidad y creación nunca fingen éxito", async () => {
    const c = {
      conversacionId: "synthetic",
      lineaId: "synthetic",
      usuarioId: "synthetic",
      clientMessageId: "synthetic",
    };
    expect(
      await herramientasSinConexion.consultarPrecio(c, "synthetic"),
    ).toEqual({ estado: "no_disponible", motivo: "SIN_PRECIO" });
    expect(
      await herramientasSinConexion.consultarDisponibilidad(
        c,
        "synthetic",
        "2026-10-05",
      ),
    ).toEqual({ estado: "no_disponible", motivo: "SIN_DISPONIBILIDAD" });
    expect(
      (
        await herramientasSinConexion.crearSolicitudCita(c, {
          especialidadId: "demo",
          profesionalId: "demo",
          fechaPreferida: "demo",
          horarioPreferido: "demo",
        })
      ).estado,
    ).toBe("no_disponible");
  });
});

describe("estimación sin gratuidad supuesta", () => {
  const c: ContextoCosto = {
    phoneNumberId: "synthetic",
    mercado: "BO",
    categoria: "service",
    ventanaServicioAbierta: true,
    entrega: "entregado",
    fechaEntrega: "2026-10-04T12:00:00Z",
    fepVerificadoHasta: null,
    cuotaGratisRestanteVerificada: null,
    tarifa: null,
  };
  it("ventana abierta no equivale a gratis y sin tarifa devuelve desconocido", () =>
    expect(estimarCosto(c).usd).toBeNull());
  it("solo FEP verificado o cuota verificada reducen la estimación", () => {
    expect(
      estimarCosto({ ...c, fepVerificadoHasta: "2026-10-05T12:00:00Z" }).usd,
    ).toBe(0);
    expect(estimarCosto({ ...c, cuotaGratisRestanteVerificada: 1 }).usd).toBe(
      0,
    );
  });
  it("no factura enviado sin entrega y separa estimado de real", () => {
    expect(estimarCosto({ ...c, entrega: "pendiente" }).usd).toBeNull();
    expect(estimarCosto({ ...c, entrega: "no_entregado" }).usd).toBe(0);
    const tarifa = {
      phoneNumberId: "synthetic",
      mercado: "BO",
      categoria: "service" as const,
      usd: 0.123,
      desde: "2026-10-01",
      hasta: "2026-11-01",
      fuente: "FIXTURE SINTETICO, NO TARIFA META",
    };
    expect(estimarCosto({ ...c, tarifa })).toMatchObject({
      usd: 0.123,
      facturacionReal: false,
    });
    expect(
      estimarCosto({ ...c, tarifa: { ...tarifa, mercado: "AR" } }).usd,
    ).toBeNull();
    expect(
      estimarCosto({ ...c, tarifa: { ...tarifa, hasta: "2026-10-04" } }).usd,
    ).toBeNull();
  });
});
