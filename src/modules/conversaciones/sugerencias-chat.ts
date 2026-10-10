import { Prisma } from '../../prisma/prisma-client';
import type { AccionAsistente } from '../asistente/herramientas';

/*
 * Las sugerencias del asistente en el chat (modo SUGERIR): lo que se guarda y
 * cómo se lee. Las escribe `AsistenteChatService`; el detalle de la
 * conversación las lee con `sugerenciaDelChat`, como lee el pago.
 */

/** Una sugerencia más vieja que esto ya no contesta a nada. */
const SUGERENCIA_VIGENTE_MS = 24 * 3_600_000;

export interface AccionSugerida {
  readonly tipo: 'PROMOCION' | 'HORARIO';
  readonly titulo: string;
  readonly promocionId?: string;
  readonly medicoId?: number;
  readonly horario?: string | null;
}

export interface SugerenciaDelChat {
  readonly id: string;
  readonly texto: string;
  readonly acciones: readonly AccionSugerida[];
  readonly aviso: string | null;
  readonly createdAt: Date;
}

export function accionesSugeridas(acciones: readonly AccionAsistente[]): AccionSugerida[] {
  return acciones.flatMap((a): AccionSugerida[] =>
    a.tipo === 'PROMOCION' ? [{ tipo: 'PROMOCION', titulo: a.titulo, promocionId: a.promocionId }]
      : a.tipo === 'HORARIO' ? [{ tipo: 'HORARIO', titulo: a.nombre, medicoId: a.medicoId, horario: a.horario }]
      : []);
}

export function accionesDe(valor: Prisma.JsonValue): AccionSugerida[] {
  if (!Array.isArray(valor)) return [];
  return valor.flatMap((v): AccionSugerida[] => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return [];
    const o = v as Record<string, unknown>;
    if (o['tipo'] === 'PROMOCION' && typeof o['promocionId'] === 'string' && typeof o['titulo'] === 'string') {
      return [{ tipo: 'PROMOCION', titulo: o['titulo'], promocionId: o['promocionId'] }];
    }
    if (o['tipo'] === 'HORARIO' && typeof o['medicoId'] === 'number' && typeof o['titulo'] === 'string') {
      return [{ tipo: 'HORARIO', titulo: o['titulo'], medicoId: o['medicoId'], horario: typeof o['horario'] === 'string' ? o['horario'] : null }];
    }
    return [];
  });
}

/**
 * La sugerencia que se muestra en el chat: la pendiente, si es de las últimas
 * 24 h y nadie contestó después. Se lee siempre después de comprobar el acceso.
 */
export async function sugerenciaDelChat(db: Prisma.TransactionClient, conversacionId: string, ahora = new Date()): Promise<SugerenciaDelChat | null> {
  const s = await db.sugerenciaAsistente.findFirst({
    where: { conversacionId, estado: 'PENDIENTE', createdAt: { gte: new Date(ahora.getTime() - SUGERENCIA_VIGENTE_MS) } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, texto: true, acciones: true, aviso: true, createdAt: true },
  });
  if (!s) return null;
  const contestada = await db.mensaje.findFirst({
    where: { conversacionId, direccion: 'SALIENTE', automatico: false, createdAt: { gt: s.createdAt } },
    select: { id: true },
  });
  return contestada ? null : { ...s, acciones: accionesDe(s.acciones) };
}
