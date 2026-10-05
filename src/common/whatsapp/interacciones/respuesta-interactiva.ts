export function objeto(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}
function cadena(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.trim() && v.length <= max ? v : undefined;
}
export type Seleccion =
  | {
      tipo: "button_reply" | "list_reply" | "template_reply";
      id: string;
      titulo: string;
      descripcion?: string;
    }
  | { tipo: "nfm_reply"; datos: Record<string, unknown>; correlacion?: string };
export interface RespuestaPreparada {
  estado: "valida" | "invalida" | "desconocida";
  mensajeId?: string;
  contextoId?: string;
  timestamp?: string;
  seleccion?: Seleccion;
  /** Snapshot íntegro del MENSAJE, acotado. Privado: nunca logs, UI ni métricas. */
  original: string | null;
  motivo?: string;
}

/** Invocar en el futuro tras la firma y ANTES del whitelist del DTO actual.
 * No interpreta texto ni ejecuta acciones. Flow no incluye flow_id: correlacionar en servidor.
 */
export function parsearRespuesta(entrada: unknown): RespuestaPreparada {
  let original: string | undefined;
  try {
    original = JSON.stringify(entrada);
  } catch {
    /* Entrada no JSON. */
  }
  if (!original || original.length > 65536)
    return {
      estado: "invalida",
      original: null,
      motivo: "Tamaño o serialización inválidos",
    };
  const m = objeto(JSON.parse(original));
  const base = {
    original,
    mensajeId: cadena(m?.["id"], 512),
    contextoId: cadena(objeto(m?.["context"])?.["id"], 512),
    timestamp: cadena(m?.["timestamp"], 20),
  };
  const invalida = (): RespuestaPreparada => ({
    ...base,
    estado: "invalida",
    motivo: "Respuesta incompleta o inválida",
  });
  if (!m || !base.mensajeId) return invalida();
  const interactivo = objeto(m["interactive"]);
  const tipo =
    m["type"] === "button"
      ? "template_reply"
      : m["type"] === "interactive"
        ? interactivo?.["type"]
        : undefined;
  if (tipo === "nfm_reply") {
    const reply = objeto(interactivo?.["nfm_reply"]);
    const json = cadena(reply?.["response_json"], 16384);
    if (reply?.["name"] !== "flow" || !json) return invalida();
    try {
      const datos = objeto(JSON.parse(json));
      if (!datos) return invalida();
      const correlacion = cadena(datos["flow_token"], 256);
      if (datos["flow_token"] !== undefined && !correlacion) return invalida();
      return {
        ...base,
        estado: "valida",
        seleccion: { tipo, datos, correlacion },
      };
    } catch {
      return invalida();
    }
  }
  if (
    tipo === "button_reply" ||
    tipo === "list_reply" ||
    tipo === "template_reply"
  ) {
    const reply = objeto(
      tipo === "template_reply" ? m["button"] : interactivo?.[tipo],
    );
    const id = cadena(
      reply?.[tipo === "template_reply" ? "payload" : "id"],
      tipo === "list_reply" ? 200 : 256,
    );
    const titulo = cadena(
      reply?.[tipo === "template_reply" ? "text" : "title"],
      1024,
    );
    if (!id || !titulo) return invalida();
    return {
      ...base,
      estado: "valida",
      seleccion: {
        tipo,
        id,
        titulo,
        descripcion: cadena(reply?.["description"], 1024),
      },
    };
  }
  return {
    ...base,
    estado: "desconocida",
    motivo: "Tipo no soportado; requiere revisión humana",
  };
}

/** Proyección segura para UI. Nunca expandir response_json arbitrario ni flow_token. */
export function resumenRespuesta(r: RespuestaPreparada): string {
  if (r.estado !== "valida" || !r.seleccion)
    return "Interacción no interpretable. Revisar con la persona.";
  return r.seleccion.tipo === "nfm_reply"
    ? "Formulario recibido. Pendiente de validación; no confirma una cita."
    : r.seleccion.titulo;
}

/** Lectura local de estados: conserva pricing/error sin alterar conciliación existente. */
export function parsearEstado(entrada: unknown) {
  const s = objeto(entrada);
  const id = cadena(s?.["id"], 512);
  const estado = cadena(s?.["status"], 40);
  if (!id || !estado) return null;
  const p = objeto(s?.["pricing"]);
  return {
    id,
    estado,
    reconocido: ["sent", "delivered", "read", "failed"].includes(estado),
    correlacion: cadena(s?.["biz_opaque_callback_data"], 512),
    pricing: p
      ? {
          categoria: cadena(p["category"], 80),
          modelo: cadena(p["pricing_model"], 40),
          tipo: cadena(p["type"], 80),
          facturable: typeof p["billable"] === "boolean" ? p["billable"] : null,
        }
      : null,
    codigosError: Array.isArray(s?.["errors"])
      ? s["errors"].flatMap((e) => {
          const code = objeto(e)?.["code"];
          return typeof code === "number" && Number.isInteger(code)
            ? [code]
            : [];
        })
      : [],
  };
}
