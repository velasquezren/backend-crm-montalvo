/** Preparación local: no transportes, credenciales, destinatarios ni persistencia. */
export const INTERACCIONES_ACTIVADAS = false;

export const ACCIONES = [
  "BOOK_APPOINTMENT",
  "VIEW_SERVICES",
  "TALK_TO_HUMAN",
  "VIEW_HOURS",
  "VIEW_LOCATION",
  "VIEW_REQUIREMENTS",
  "REPORT_GUIDANCE",
  "VIEW_PROMOTIONS",
  "REGISTER_INTEREST",
] as const;
export type AccionMontalvo = (typeof ACCIONES)[number];
export interface Opcion {
  id: string;
  titulo: string;
  descripcion?: string;
}
type Base = { cuerpo: string; cabecera?: string; pie?: string };
export type MensajePreparado =
  | { tipo: "texto"; cuerpo: string }
  | (Base & {
      tipo: "botones";
      opciones: Opcion[];
      /**
       * Imagen de cabecera (URL https que Meta descarga): el banner de una
       * promoción. Solo los botones la admiten; excluye `cabecera` de texto.
       */
      imagenCabecera?: string;
    })
  | (Base & {
      tipo: "lista";
      boton: string;
      secciones: { titulo: string; opciones: Opcion[] }[];
    })
  | (Base & {
      tipo: "flow";
      flowId: string;
      correlacion: string;
      cta: string;
      modo: "draft" | "published";
      inicio:
        { accion: "navigate"; pantalla: string } | { accion: "data_exchange" };
    });

function texto(
  valor: unknown,
  max: number,
  campo: string,
): asserts valor is string {
  if (typeof valor !== "string" || !valor.trim() || valor.length > max) {
    throw new Error(`Campo inválido: ${campo} (máximo ${max}).`);
  }
}
function cantidad(valor: unknown, max: number): asserts valor is unknown[] {
  if (!Array.isArray(valor) || !valor.length || valor.length > max)
    throw new Error("Cantidad de opciones inválida.");
}

/** Subconjunto deliberado de Meta: cabeceras de texto, sin media/productos. */
export function validarMensaje(m: MensajePreparado): void {
  if (!m || !["texto", "botones", "lista", "flow"].includes(m.tipo))
    throw new Error("Tipo no soportado.");
  // Listas: la referencia específica actual admite 4096; botones y Flow 1024.
  texto(
    m.cuerpo,
    m.tipo === "texto" || m.tipo === "lista" ? 4096 : 1024,
    "cuerpo",
  );
  if (m.tipo === "texto") return;
  if (m.cabecera !== undefined) texto(m.cabecera, 60, "cabecera");
  if (m.pie !== undefined) texto(m.pie, 60, "pie");
  if (m.tipo === "botones" && m.imagenCabecera !== undefined) {
    texto(m.imagenCabecera, 2000, "imagen de cabecera");
    if (!/^https:\/\/\S+$/.test(m.imagenCabecera))
      throw new Error("La imagen de cabecera necesita una URL https.");
    if (m.cabecera !== undefined)
      throw new Error("Una cabecera es de texto o de imagen, no las dos.");
  }
  if (m.tipo === "flow") {
    texto(m.flowId, 80, "flowId");
    if (!/^\d+$/.test(m.flowId))
      throw new Error("Se requiere un ID de Flow válido.");
    texto(m.correlacion, 256, "correlación");
    texto(m.cta, 30, "cta"); // Tope conservador local según recomendación de Meta.
    if (/\p{Extended_Pictographic}/u.test(m.cta))
      throw new Error("CTA sin emojis.");
    if (!["draft", "published"].includes(m.modo))
      throw new Error("Modo inválido.");
    if (!m.inicio || !["navigate", "data_exchange"].includes(m.inicio.accion))
      throw new Error("Inicio inválido.");
    if (m.inicio.accion === "navigate")
      texto(m.inicio.pantalla, 80, "pantalla");
    return;
  }
  if (m.tipo === "botones") cantidad(m.opciones, 3);
  else {
    texto(m.boton, 20, "botón de lista");
    cantidad(m.secciones, 10);
    for (const s of m.secciones) {
      texto(s.titulo, 24, "sección");
      cantidad(s.opciones, 10);
    }
  }
  const opciones =
    m.tipo === "botones" ? m.opciones : m.secciones.flatMap((s) => s.opciones);
  cantidad(opciones, m.tipo === "botones" ? 3 : 10);
  const ids = new Set<string>();
  const titulos = new Set<string>();
  for (const o of opciones) {
    texto(o?.id, m.tipo === "botones" ? 256 : 200, "id");
    texto(o.titulo, m.tipo === "botones" ? 20 : 24, "título");
    if (o.id !== o.id.trim() || ids.has(o.id))
      throw new Error("ID repetido o con espacios exteriores.");
    if (
      m.tipo === "botones" &&
      (titulos.has(o.titulo) ||
        /[*_~`]|\p{Extended_Pictographic}/u.test(o.titulo))
    ) {
      throw new Error(
        "Los botones requieren títulos únicos, sin formato ni emojis.",
      );
    }
    if (o.descripcion !== undefined) {
      if (m.tipo === "botones")
        throw new Error("Un botón no admite descripción.");
      texto(o.descripcion, 72, "descripción");
    }
    ids.add(o.id);
    titulos.add(o.titulo);
  }
}

/** Solo construye contenido; NO produce un envío ni puede hacerlo por sí sola. */
export function contenidoMeta(m: MensajePreparado): Record<string, unknown> {
  validarMensaje(m);
  if (m.tipo === "texto") return { type: "text", text: { body: m.cuerpo } };
  const base = {
    body: { text: m.cuerpo },
    ...(m.cabecera ? { header: { type: "text", text: m.cabecera } } : {}),
    ...(m.pie ? { footer: { text: m.pie } } : {}),
  };
  if (m.tipo === "botones")
    return {
      type: "interactive",
      interactive: {
        ...base,
        ...(m.imagenCabecera
          ? { header: { type: "image", image: { link: m.imagenCabecera } } }
          : {}),
        type: "button",
        action: {
          buttons: m.opciones.map((o) => ({
            type: "reply",
            reply: { id: o.id, title: o.titulo },
          })),
        },
      },
    };
  if (m.tipo === "lista")
    return {
      type: "interactive",
      interactive: {
        ...base,
        type: "list",
        action: {
          button: m.boton,
          sections: m.secciones.map((s) => ({
            title: s.titulo,
            rows: s.opciones.map((o) => ({
              id: o.id,
              title: o.titulo,
              ...(o.descripcion ? { description: o.descripcion } : {}),
            })),
          })),
        },
      },
    };
  return {
    type: "interactive",
    interactive: {
      ...base,
      type: "flow",
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_id: m.flowId,
          flow_token: m.correlacion,
          flow_cta: m.cta,
          mode: m.modo,
          flow_action: m.inicio.accion,
          ...(m.inicio.accion === "navigate"
            ? { flow_action_payload: { screen: m.inicio.pantalla } }
            : {}),
        },
      },
    },
  };
}

/** Componentes de envío, no definición/creación de una plantilla remota. */
export function botonPlantilla(
  indice: number,
  boton:
    { tipo: "quick_reply"; id: string } | { tipo: "flow"; correlacion: string },
): Record<string, unknown> {
  if (!Number.isInteger(indice) || indice < 0 || indice > 9)
    throw new Error("Índice inválido.");
  if (boton.tipo === "quick_reply") {
    texto(boton.id, 128, "payload");
    return {
      type: "button",
      sub_type: "quick_reply",
      index: String(indice),
      parameters: [{ type: "payload", payload: boton.id }],
    };
  }
  if (boton.tipo !== "flow")
    throw new Error("Botón de plantilla no soportado.");
  texto(boton.correlacion, 256, "correlación");
  return {
    type: "button",
    sub_type: "flow",
    index: String(indice),
    parameters: [{ type: "action", action: { flow_token: boton.correlacion } }],
  };
}
