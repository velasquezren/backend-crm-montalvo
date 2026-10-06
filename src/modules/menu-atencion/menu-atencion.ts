import { acortar } from '../../common/texto/acortar';
import type { MensajePreparado, Opcion } from '../../common/whatsapp/interacciones/mensaje-interactivo';

/*
 * Menú de atención de una línea: lo que la paciente ve al escribir, con botones
 * para decir qué necesita. Diseño en docs/menu-atencion.md.
 *
 * Aquí vive solo la DECISIÓN —qué se puede configurar, cómo se arma el mensaje y
 * qué significa cada opción—, sin base ni red, como `acuse-automatico.service.ts`.
 * El efecto (guardar, despachar, pedir a una persona) es de la ingesta.
 *
 * Los TIPOS de opción son código; el CONTENIDO es de la clínica. Ningún texto
 * dirigido a la paciente tiene valor por defecto: una promoción, un horario o
 * una orientación de emergencia inventados serían peores que no tenerlos.
 */

/** Qué hace cada opción. El orden es el del catálogo en la pantalla. */
export const TIPOS_OPCION = ['PERSONA', 'EMERGENCIA', 'CITA', 'RESPUESTA', 'UBICACION', 'PROMOCIONES'] as const;
export type TipoOpcion = (typeof TIPOS_OPCION)[number];

export interface OpcionMenu {
  tipo: TipoOpcion;
  titulo: string;
  descripcion?: string;
  /** Su uso depende del tipo: ver `REGLAS`. */
  respuesta?: string;
  /** Identidad estable de una opción `RESPUESTA` (puede haber varias). */
  clave?: string;
}

export interface MenuAtencion {
  activo: boolean;
  saludo: string;
  opciones: OpcionMenu[];
}

/** Lo que muestra la lista de promociones: las publicadas para WhatsApp en el CRM (módulo Promociones). */
export interface PromocionDeMenu {
  id: string;
  titulo: string;
  resumen: string;
}

/**
 * Límites de Meta para un mensaje interactivo de lista (los más estrictos de los
 * que usa el menú): título de fila 24, descripción 72. El cuerpo admite 1024 en
 * botones y 4096 en listas; se usa 1024 para que el mismo texto valga en ambos.
 */
export const LIMITES = {
  opciones: 10,
  titulo: 24,
  /** Un botón de respuesta rápida admite 20: por encima, el menú sale como lista. */
  tituloBoton: 20,
  descripcion: 72,
  texto: 1024,
} as const;

/** Lo que pide cada tipo. `respuesta` es el único texto que la clínica escribe por opción. */
export const REGLAS: Readonly<Record<TipoOpcion, { unica: boolean; respuesta: 'obligatoria' | 'opcional' }>> = {
  /** Pide una persona: prioridad alta. `respuesta` = confirmación que recibe ella. */
  PERSONA: { unica: true, respuesta: 'opcional' },
  /** Dice que es una emergencia: prioridad crítica. `respuesta` = la orientación aprobada por la clínica. */
  EMERGENCIA: { unica: true, respuesta: 'obligatoria' },
  /** Pide una cita: solicitud pendiente, nunca una reserva. `respuesta` = confirmación. */
  CITA: { unica: true, respuesta: 'opcional' },
  /** Información fija (horarios, requisitos…): se contesta sola. `respuesta` = la información. */
  RESPUESTA: { unica: false, respuesta: 'obligatoria' },
  /** El mapa de la clínica. `respuesta` = una línea antes del mapa. */
  UBICACION: { unica: true, respuesta: 'opcional' },
  /**
   * La lista de promociones publicadas para WhatsApp en el CRM (una sola fuente con
   * la landing). `respuesta` = el texto que la acompaña. Sin ninguna publicada, la
   * opción no se muestra.
   */
  PROMOCIONES: { unica: true, respuesta: 'obligatoria' },
};

/**
 * El identificador que viaja a Meta y vuelve en la respuesta. Los de PERSONA y
 * CITA son los que la atención humana ya reconoce (`motivoDeRespuesta`). Solo
 * cuenta si `guardarRespuesta` lo encontró en NUESTRA oferta: un id escrito a
 * mano no llega correlacionado.
 */
const ID_FIJO: Readonly<Record<Exclude<TipoOpcion, 'RESPUESTA'>, string>> = {
  PERSONA: 'TALK_TO_HUMAN',
  EMERGENCIA: 'EMERGENCY',
  CITA: 'BOOK_APPOINTMENT',
  UBICACION: 'VIEW_LOCATION',
  PROMOCIONES: 'VIEW_PROMOTIONS',
};
const PREFIJO_INFO = 'INFO_';
const PREFIJO_PROMO = 'PROMO_';
/** Identidad estable de una respuesta o una promoción (la usa también el DTO). */
export const CLAVE = /^[a-z0-9]{4,16}$/;
/** Lo que Meta no admite en el título de un botón: formato y emojis. */
const NO_BOTON = /[*_~`]|\p{Extended_Pictographic}/u;

export function idDeOpcion(o: OpcionMenu): string {
  return o.tipo === 'RESPUESTA' ? `${PREFIJO_INFO}${o.clave}` : ID_FIJO[o.tipo];
}
export function idDePromocion(p: { id: string }): string {
  return `${PREFIJO_PROMO}${p.id}`;
}

/* ── Validación: la misma al guardar y al leer ──────────────────────── */

function textoValido(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max && v === v.trim();
}

/**
 * Los errores de un menú, en palabras para quien lo configura. Vacío = válido.
 * Corre al guardar (400 con estos mensajes) y al leer (`leerMenu`): un menú que
 * dejó de ser válido —una regla nueva, un dato tocado a mano— no se envía.
 */
export function erroresDelMenu(menu: MenuAtencion): string[] {
  const errores: string[] = [];
  if (!textoValido(menu.saludo, LIMITES.texto)) errores.push(`El saludo es obligatorio y tiene hasta ${LIMITES.texto} caracteres.`);
  if (!Array.isArray(menu.opciones) || menu.opciones.length === 0 || menu.opciones.length > LIMITES.opciones)
    return [...errores, `El menú lleva entre 1 y ${LIMITES.opciones} opciones.`];

  const titulos = new Set<string>();
  const claves = new Set<string>();
  for (const [i, o] of menu.opciones.entries()) {
    const n = `Opción ${i + 1}`;
    const reglas = REGLAS[o.tipo];
    if (!reglas) { errores.push(`${n}: tipo desconocido.`); continue; }
    if (!textoValido(o.titulo, LIMITES.titulo)) errores.push(`${n}: el título es obligatorio y tiene hasta ${LIMITES.titulo} caracteres.`);
    else if (titulos.has(o.titulo.toLowerCase())) errores.push(`${n}: hay otra opción con el título «${o.titulo}».`);
    else titulos.add(o.titulo.toLowerCase());
    if (o.descripcion !== undefined && !textoValido(o.descripcion, LIMITES.descripcion))
      errores.push(`${n}: la descripción tiene hasta ${LIMITES.descripcion} caracteres.`);
    if (reglas.respuesta === 'obligatoria' && !textoValido(o.respuesta, LIMITES.texto))
      errores.push(`${n}: falta el texto que se le responde (hasta ${LIMITES.texto} caracteres).`);
    if (reglas.respuesta === 'opcional' && o.respuesta !== undefined && !textoValido(o.respuesta, LIMITES.texto))
      errores.push(`${n}: el texto de respuesta tiene hasta ${LIMITES.texto} caracteres.`);
    if (o.tipo === 'RESPUESTA') {
      if (!o.clave || !CLAVE.test(o.clave) || claves.has(o.clave)) errores.push(`${n}: identificador interno inválido.`);
      else claves.add(o.clave);
    } else if (o.clave !== undefined) errores.push(`${n}: solo una respuesta informativa lleva identificador.`);
  }
  for (const tipo of TIPOS_OPCION)
    if (REGLAS[tipo].unica && menu.opciones.filter(o => o.tipo === tipo).length > 1) errores.push(`Solo puede haber una opción de tipo ${tipo}.`);
  /* Siempre hay una salida hacia una persona: un menú sin ella deja a la paciente
     hablando con una máquina. */
  if (!menu.opciones.some(o => o.tipo === 'PERSONA')) errores.push('El menú siempre ofrece hablar con una persona.');

  return errores;
}

/** Copia solo los campos conocidos: lo que se guarda y se lee no arrastra claves extra. */
function limpiarOpcion(o: OpcionMenu): OpcionMenu {
  return {
    tipo: o.tipo,
    titulo: o.titulo,
    ...(o.descripcion !== undefined ? { descripcion: o.descripcion } : {}),
    ...(o.respuesta !== undefined ? { respuesta: o.respuesta } : {}),
    ...(o.clave !== undefined ? { clave: o.clave } : {}),
  };
}
export function normalizarMenu(menu: MenuAtencion): MenuAtencion {
  return { activo: menu.activo, saludo: menu.saludo, opciones: menu.opciones.map(limpiarOpcion) };
}

function esObjeto(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * El menú guardado, o `null` si no es válido. Fail-closed: lo que no pase la
 * validación no se le envía a nadie.
 */
export function leerMenu(fila: { activo: boolean; saludo: string; opciones: unknown }): MenuAtencion | null {
  if (!Array.isArray(fila.opciones) || !fila.opciones.every(esObjeto)) return null;
  const menu = normalizarMenu({ activo: fila.activo, saludo: fila.saludo, opciones: fila.opciones as unknown as OpcionMenu[] });
  return erroresDelMenu(menu).length === 0 ? menu : null;
}

/* ── El mensaje que recibe la paciente ──────────────────────────────── */

function opcionMeta(o: { titulo: string; descripcion?: string }, id: string): Opcion {
  return { id, titulo: o.titulo, ...(o.descripcion ? { descripcion: o.descripcion } : {}) };
}

/**
 * Hasta tres opciones cortas, sin descripción ni formato: botones (un toque).
 * Si no, lista (un toque para abrirla y otro para elegir). La opción de
 * promociones solo sale si hoy hay alguna publicada para WhatsApp.
 */
export function mensajeDelMenu(menu: MenuAtencion, { hayPromociones }: { hayPromociones: boolean }): MensajePreparado {
  const visibles = menu.opciones.filter(o => o.tipo !== 'PROMOCIONES' || hayPromociones);
  const opciones = visibles.map(o => opcionMeta(o, idDeOpcion(o)));
  const caben = visibles.length <= 3 && visibles.every(o => !o.descripcion && o.titulo.length <= LIMITES.tituloBoton && !NO_BOTON.test(o.titulo));
  return caben
    ? { tipo: 'botones', cuerpo: menu.saludo, opciones }
    : { tipo: 'lista', cuerpo: menu.saludo, boton: 'Ver opciones', secciones: [{ titulo: 'Opciones', opciones }] };
}

/**
 * La lista de promociones publicadas para WhatsApp, con el texto que escribió la
 * clínica. `null` si el menú no la ofrece o no hay ninguna. Los títulos de la
 * promoción pueden ser más largos que una fila de Meta: se acortan.
 */
export function mensajeDePromociones(menu: MenuAtencion, promociones: readonly PromocionDeMenu[]): MensajePreparado | null {
  const opcion = menu.opciones.find(o => o.tipo === 'PROMOCIONES');
  if (!opcion?.respuesta || promociones.length === 0) return null;
  return {
    tipo: 'lista',
    cuerpo: opcion.respuesta,
    boton: 'Ver promociones',
    secciones: [{
      titulo: 'Promociones',
      opciones: promociones.slice(0, LIMITES.opciones).map(p => ({
        id: idDePromocion(p),
        titulo: acortar(p.titulo, LIMITES.titulo),
        ...(p.resumen ? { descripcion: acortar(p.resumen, LIMITES.descripcion) } : {}),
      })),
    }],
  };
}

/* ── Qué significa una selección ────────────────────────────────────── */

export type AccionMenu =
  | { tipo: 'PERSONA' | 'CITA'; confirmacion: string | null }
  | { tipo: 'EMERGENCIA'; orientacion: string }
  | { tipo: 'RESPUESTA'; texto: string }
  | { tipo: 'UBICACION'; texto: string | null }
  | { tipo: 'PROMOCIONES' }
  /** Eligió una promoción de la lista: se le manda su tarjeta (precio, condiciones, pagar). */
  | { tipo: 'PROMOCION'; promocionId: string };

/** Las acciones que el menú resuelve solo, sin pedir a una persona. */
export function seResuelveSola(a: AccionMenu | null): boolean {
  return a?.tipo === 'RESPUESTA' || a?.tipo === 'UBICACION' || a?.tipo === 'PROMOCIONES' || a?.tipo === 'PROMOCION';
}

/**
 * Lo que pide una opción ya correlacionada con nuestra oferta, según el menú de
 * HOY. Si la opción ya no existe (la clínica cambió el menú entre el envío y el
 * toque), devuelve `null` y la respuesta queda para una persona: nunca se
 * contesta con un texto que la clínica retiró.
 */
export function accionDeSeleccion(menu: MenuAtencion | null, seleccionId: string): AccionMenu | null {
  if (!menu) return null;
  if (seleccionId.startsWith(PREFIJO_PROMO)) {
    /* El id salió de NUESTRA lista (la correlación lo garantiza); si la promoción
       sigue visible lo decide quien manda su tarjeta. */
    const promocionId = seleccionId.slice(PREFIJO_PROMO.length);
    return menu.opciones.some(o => o.tipo === 'PROMOCIONES') && promocionId ? { tipo: 'PROMOCION', promocionId } : null;
  }
  const o = menu.opciones.find(x => idDeOpcion(x) === seleccionId);
  if (!o) return null;
  switch (o.tipo) {
    case 'PERSONA':
    case 'CITA':
      return { tipo: o.tipo, confirmacion: o.respuesta ?? null };
    case 'EMERGENCIA':
      return o.respuesta ? { tipo: 'EMERGENCIA', orientacion: o.respuesta } : null;
    case 'RESPUESTA':
      return o.respuesta ? { tipo: 'RESPUESTA', texto: o.respuesta } : null;
    case 'UBICACION':
      return { tipo: 'UBICACION', texto: o.respuesta ?? null };
    case 'PROMOCIONES':
      return o.respuesta ? { tipo: 'PROMOCIONES' } : null;
  }
}

/**
 * La orientación de emergencia que la clínica aprobó, para quien ESCRIBE que es
 * una emergencia (sin tocar el botón). `null` si el menú no la tiene: entonces
 * no se le manda nada inventado, pero la solicitud crítica nace igual.
 */
export function orientacionDeEmergencia(menu: MenuAtencion | null): string | null {
  return menu?.opciones.find(o => o.tipo === 'EMERGENCIA')?.respuesta ?? null;
}
