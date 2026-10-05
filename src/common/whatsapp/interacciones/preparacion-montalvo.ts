import {
  ACCIONES,
  AccionMontalvo,
  INTERACCIONES_ACTIVADAS,
  MensajePreparado,
} from "./mensaje-interactivo";
import { RespuestaPreparada } from "./respuesta-interactiva";

export const bienvenidaDemo: MensajePreparado = {
  tipo: "botones",
  cuerpo: "[DEMO] ¿Cómo podemos ayudarte? También puedes escribir libremente.",
  opciones: [
    { id: "BOOK_APPOINTMENT", titulo: "Solicitar cita" },
    { id: "VIEW_SERVICES", titulo: "Servicios y precios" },
    { id: "TALK_TO_HUMAN", titulo: "Hablar con recepción" },
  ],
};
export const recepcionDemo: MensajePreparado = {
  tipo: "lista",
  cuerpo: "[DEMO] Elige una consulta o escribe a recepción.",
  boton: "Ver opciones",
  secciones: [
    {
      titulo: "Recepción",
      opciones: [
        { id: "VIEW_HOURS", titulo: "Horario de atención" },
        { id: "VIEW_LOCATION", titulo: "Ubicación" },
        { id: "VIEW_REQUIREMENTS", titulo: "Requisitos" },
        { id: "REPORT_GUIDANCE", titulo: "Ayuda con informes" },
        { id: "TALK_TO_HUMAN", titulo: "Hablar con recepción" },
      ],
    },
  ],
};

/** Datos de confianza que deberá resolver Nest, nunca valores autorizantes del Flow. */
export interface ContextoSimulado {
  ahora: number;
  ultimaEntrada: number | null;
  conversacionId: string;
  lineaId: string;
  accesoAutorizado: boolean;
  linea: "recepcion" | "comercial";
  agenteAsignadoId: string | null;
  humanoAtendiendo: boolean;
  cerrada: boolean;
  metaDisponible: boolean;
  enviados: number;
  limite: number;
  bienvenidaOfrecida: boolean;
  asunto: "administrativo" | "clinico" | "desconocido";
  correlacion?: {
    contextoId: string;
    opciones: string[];
    venceEn: number;
    flowToken?: string;
  };
  /** Solo para simulación. La deduplicación real sigue en PostgreSQL. */
  mensajesVistos: readonly string[];
}
type Decision = {
  resultado: string;
  accion?: AccionMontalvo;
  transferencia?: {
    conversacionId: string;
    lineaId: string;
    agenteAsignadoId: string | null;
    mensajeId?: string;
    seleccion?: string;
    motivo: string;
  };
};

/** Ensayo puro y sin efectos. NO es un motor de automatización ni autoriza envíos. */
export function simularRespuesta(
  r: RespuestaPreparada,
  c: ContextoSimulado,
): Decision {
  if (!c.accesoAutorizado) return { resultado: "SIN_ACCESO" };
  if (r.mensajeId && c.mensajesVistos.includes(r.mensajeId))
    return { resultado: "DUPLICADO" };
  const humano = (motivo: string): Decision => ({
    resultado: "TRANSFERENCIA_PROPUESTA",
    transferencia: {
      conversacionId: c.conversacionId,
      lineaId: c.lineaId,
      agenteAsignadoId: c.agenteAsignadoId,
      mensajeId: r.mensajeId,
      seleccion:
        r.seleccion && r.seleccion.tipo !== "nfm_reply"
          ? r.seleccion.id
          : undefined,
      motivo,
    },
  });
  if (c.humanoAtendiendo) return { resultado: "HUMANO_EN_CONTROL" };
  if (c.asunto !== "administrativo") return humano("REQUIERE_REVISION_HUMANA");
  if (r.estado !== "valida" || !r.seleccion)
    return humano("PAYLOAD_NO_INTERPRETABLE");
  if (c.cerrada) return humano("CONVERSACION_CERRADA");
  const seleccion = r.seleccion;
  // Pedir una persona siempre se atiende, incluso desde un menú antiguo.
  if (seleccion.tipo !== "nfm_reply" && seleccion.id === "TALK_TO_HUMAN")
    return humano("SOLICITUD_EXPLICITA");
  const esperado = c.correlacion;
  if (
    !esperado ||
    esperado.venceEn <= c.ahora ||
    r.contextoId !== esperado.contextoId
  )
    return humano("RESPUESTA_TARDIA_O_SIN_CONTEXTO");
  if (seleccion.tipo === "nfm_reply") {
    if (!esperado.flowToken || seleccion.correlacion !== esperado.flowToken)
      return humano("FLOW_NO_CORRELACIONADO");
    // Formulario no confiable: aún falta validación de campos y API transaccional.
    return { resultado: "FORMULARIO_PENDIENTE_VALIDACION" };
  }
  if (!esperado.opciones.includes(seleccion.id))
    return humano("OPCION_NO_OFRECIDA");
  const accion = ACCIONES.find((a) => a === seleccion.id);
  if (!accion) return humano("ACCION_DESCONOCIDA");
  if (
    c.ultimaEntrada === null ||
    !Number.isFinite(c.ultimaEntrada) ||
    c.ultimaEntrada > c.ahora ||
    c.ahora - c.ultimaEntrada >= 86400000
  )
    return { resultado: "REQUIERE_PLANTILLA_APROBADA" };
  if (!c.metaDisponible) return { resultado: "META_NO_DISPONIBLE" };
  if (
    !Number.isInteger(c.enviados) ||
    !Number.isInteger(c.limite) ||
    c.enviados < 0 ||
    c.limite < 1 ||
    c.enviados >= c.limite
  )
    return { resultado: "LIMITE_ALCANZADO" };
  if (
    (accion === "VIEW_PROMOTIONS" || accion === "REGISTER_INTEREST") &&
    c.linea !== "comercial"
  )
    return humano("REQUIERE_ATENCION_COMERCIAL");
  return { resultado: "ACCION_PROPUESTA_SIN_EJECUTAR", accion };
}

export function puedeOfrecerBienvenida(c: ContextoSimulado): boolean {
  return (
    c.accesoAutorizado &&
    !c.bienvenidaOfrecida &&
    !c.humanoAtendiendo &&
    !c.cerrada &&
    c.asunto === "administrativo" &&
    c.metaDisponible &&
    c.enviados < c.limite &&
    c.ultimaEntrada !== null &&
    c.ahora >= c.ultimaEntrada &&
    c.ahora - c.ultimaEntrada < 86400000
  );
}

export interface ContextoHerramienta {
  conversacionId: string;
  lineaId: string;
  usuarioId: string;
  clientMessageId: string;
}
export type ResultadoConsulta<T> =
  | { estado: "disponible"; dato: T; fuente: string; vigenteHasta: string }
  | {
      estado: "no_disponible";
      motivo:
        | "API_PENDIENTE"
        | "SIN_PRECIO"
        | "SIN_DISPONIBILIDAD"
        | "SIN_AUTORIZACION";
    };
export interface ReferenciaCatalogo {
  id: string;
  nombre: string;
}
export interface SolicitudCita {
  especialidadId: string;
  profesionalId: string;
  fechaPreferida: string;
  horarioPreferido: string;
  nombre?: string;
}
/** Contratos futuros internos a Nest. No son endpoints ni DTOs de Prisma. */
export interface HerramientasMontalvo {
  consultarServicio(
    c: ContextoHerramienta,
    busqueda: string,
  ): Promise<ResultadoConsulta<ReferenciaCatalogo[]>>;
  consultarPrecio(
    c: ContextoHerramienta,
    servicioId: string,
  ): Promise<ResultadoConsulta<{ monto: number; moneda: "BOB" }>>;
  consultarEspecialidad(
    c: ContextoHerramienta,
  ): Promise<ResultadoConsulta<ReferenciaCatalogo[]>>;
  consultarProfesional(
    c: ContextoHerramienta,
    especialidadId: string,
  ): Promise<ResultadoConsulta<ReferenciaCatalogo[]>>;
  consultarDisponibilidad(
    c: ContextoHerramienta,
    profesionalId: string,
    fecha: string,
  ): Promise<ResultadoConsulta<string[]>>;
  crearSolicitudCita(
    c: ContextoHerramienta,
    solicitud: SolicitudCita,
  ): Promise<ResultadoConsulta<{ tipo: "SOLICITUD_DE_CITA"; id: string }>>;
  transferirHumano(
    c: ContextoHerramienta,
    motivo: string,
  ): Promise<ResultadoConsulta<{ conversacionId: string }>>;
}
/** Fail-closed: ninguna función simula un precio real, reserva o asignación exitosa. */
export const herramientasSinConexion: HerramientasMontalvo = {
  consultarServicio: async () => ({
    estado: "no_disponible",
    motivo: "API_PENDIENTE",
  }),
  consultarPrecio: async () => ({
    estado: "no_disponible",
    motivo: "SIN_PRECIO",
  }),
  consultarEspecialidad: async () => ({
    estado: "no_disponible",
    motivo: "API_PENDIENTE",
  }),
  consultarProfesional: async () => ({
    estado: "no_disponible",
    motivo: "API_PENDIENTE",
  }),
  consultarDisponibilidad: async () => ({
    estado: "no_disponible",
    motivo: "SIN_DISPONIBILIDAD",
  }),
  crearSolicitudCita: async () => ({
    estado: "no_disponible",
    motivo: "API_PENDIENTE",
  }),
  transferirHumano: async () => ({
    estado: "no_disponible",
    motivo: "API_PENDIENTE",
  }),
};

export function estadoPreparacion() {
  return { habilitada: INTERACCIONES_ACTIVADAS, permiteEnvio: false as const };
}
