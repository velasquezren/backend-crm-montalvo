import { Injectable, Logger } from '@nestjs/common';

import { PushService } from '../push/push.service';

/** Lo que hay que contarle a un admin sobre la cuenta de WhatsApp. */
export interface AvisoPlataforma {
  /** `critico` es lo único que despierta un teléfono. */
  nivel: 'critico' | 'info';
  titulo: string;
  mensaje: string;
}

/** Forma mínima del `value` de un webhook de plataforma (ver el DTO). */
export interface CambioPlataforma {
  event?: string;
  current_limit?: string;
  max_daily_conversations_per_business?: string;
  message_template_name?: string;
  reason?: string;
  restriction_info?: Array<{ restriction_type?: string; expiration?: number }>;
  violation_info?: { violation_type?: string };
  ban_info?: { waba_ban_state?: string; waba_ban_date?: string };
}

/**
 * Convierte los avisos de plataforma de Meta en algo que alguien lea.
 *
 * El webhook de WhatsApp trae diez campos suscritos y el CRM solo usaba
 * `messages`. Los otros nueve entraban, se validaba su firma y se tiraban —
 * incluidos los que avisan de que Meta acaba de restringir la cuenta. Ese aviso
 * llegaba puntualmente al servidor y moría en silencio; el equipo se enteraba
 * cuando dejaban de salir los mensajes.
 *
 * Solo lo grave manda notificación, y solo a los admins: un aviso que suena por
 * cosas que nadie puede resolver acaba desactivado, y entonces tampoco suena el
 * que importa.
 */
@Injectable()
export class AlertasWhatsappService {
  private readonly logger = new Logger(AlertasWhatsappService.name);

  constructor(private readonly push: PushService) {}

  /** ¿Este `field` del webhook lo gestiona este servicio? */
  static atiende(field: string | undefined): boolean {
    return (
      field === 'account_update' ||
      field === 'phone_number_quality_update' ||
      field === 'message_template_status_update'
    );
  }

  /**
   * Registra el aviso y, si es grave, lo empuja al teléfono de los admins.
   *
   * No lanza nunca: lo llama el webhook, que ya respondió 200 a Meta, y un
   * fallo notificando no puede arrastrar al resto del lote.
   */
  async procesar(field: string | undefined, value: CambioPlataforma): Promise<void> {
    const aviso = interpretar(field, value);
    if (!aviso) return;

    if (aviso.nivel === 'critico') {
      this.logger.error(`[WhatsApp] ${aviso.titulo}: ${aviso.mensaje}`);
      try {
        await this.push.enviarAAdmins({
          titulo: aviso.titulo,
          mensaje: aviso.mensaje,
          url: '/conversaciones',
          /* Un `tag` por tipo de aviso: si Meta repite el mismo evento, la
             notificación se reemplaza en vez de apilarse. */
          tag: `wa-${field}`,
        });
      } catch (error) {
        this.logger.error('No se pudo notificar el aviso de WhatsApp a los admins', error);
      }
      return;
    }

    this.logger.log(`[WhatsApp] ${aviso.titulo}: ${aviso.mensaje}`);
  }
}

/**
 * Traduce el evento de Meta a un aviso en castellano, o `null` si no merece
 * ni una línea de log.
 *
 * Función pura a propósito: es la parte con reglas de negocio —qué es grave y
 * qué no— y así se prueba sin base, sin red y sin Meta.
 */
export function interpretar(
  field: string | undefined,
  value: CambioPlataforma,
): AvisoPlataforma | null {
  if (field === 'account_update') return desdeCuenta(value);
  if (field === 'phone_number_quality_update') return desdeLimite(value);
  if (field === 'message_template_status_update') return desdePlantilla(value);
  return null;
}

function desdeCuenta(value: CambioPlataforma): AvisoPlataforma | null {
  switch (value.event) {
    case 'ACCOUNT_RESTRICTION': {
      const tipos = (value.restriction_info ?? [])
        .map(r => r.restriction_type)
        .filter((t): t is string => Boolean(t));
      /* La que de verdad duele: deja de poder abrirse conversaciones nuevas,
         así que las plantillas y cualquier campaña quedan muertas. */
      const detalle = tipos.length > 0 ? tipos.join(', ') : 'sin detalle';
      return {
        nivel: 'critico',
        titulo: 'WhatsApp restringido por Meta',
        mensaje: `Meta restringió la cuenta (${detalle}). Revisa WhatsApp Manager.`,
      };
    }
    case 'ACCOUNT_VIOLATION':
      return {
        nivel: 'critico',
        titulo: 'Violación de políticas de WhatsApp',
        mensaje: `Meta marcó una violación (${value.violation_info?.violation_type ?? 'sin detalle'}).`,
      };
    case 'DISABLED_UPDATE':
      return {
        nivel: 'critico',
        titulo: 'Cuenta de WhatsApp deshabilitada',
        mensaje: `Estado: ${value.ban_info?.waba_ban_state ?? 'desconocido'}${
          value.ban_info?.waba_ban_date ? ` desde ${value.ban_info.waba_ban_date}` : ''
        }.`,
      };
    case 'ACCOUNT_DELETED':
      return {
        nivel: 'critico',
        titulo: 'Cuenta de WhatsApp eliminada',
        mensaje: 'La cuenta de WhatsApp Business ya no existe. El inbox dejará de recibir.',
      };
    default:
      /* El resto (PARTNER_ADDED, AUTH_INTL_PRICE_ELIGIBILITY_UPDATE…) son
         administrativos y no afectan a la clínica: quedan en el log. */
      return value.event
        ? { nivel: 'info', titulo: 'Cambio en la cuenta', mensaje: value.event }
        : null;
  }
}

/**
 * Cambios de límite/throughput.
 *
 * **No es una alarma de calidad.** Desde el 7 de octubre de 2025 el estado
 * `FLAGGED` dejó de existir y una caída de calidad ya no baja el límite; este
 * webhook quedó para los cambios de throughput. Lo que avisa de un problema de
 * verdad es `account_update` — de ahí que aquí solo se registre.
 */
function desdeLimite(value: CambioPlataforma): AvisoPlataforma | null {
  const limite = value.max_daily_conversations_per_business ?? value.current_limit;
  if (!value.event && !limite) return null;
  return {
    nivel: 'info',
    titulo: 'Límite de mensajes actualizado',
    mensaje: `${value.event ?? 'cambio'}${limite ? ` → ${limite}` : ''}`,
  };
}

function desdePlantilla(value: CambioPlataforma): AvisoPlataforma | null {
  const nombre = value.message_template_name ?? 'sin nombre';

  /* Rechazada, pausada o deshabilitada: alguien tiene que corregirla o la
     clínica se queda sin ese mensaje fuera de la ventana de 24 h. */
  if (value.event && ['REJECTED', 'PAUSED', 'DISABLED'].includes(value.event)) {
    return {
      nivel: 'critico',
      titulo: `Plantilla ${value.event === 'REJECTED' ? 'rechazada' : 'pausada'}`,
      mensaje: `"${nombre}"${value.reason ? `: ${value.reason}` : ''}`,
    };
  }

  return value.event
    ? { nivel: 'info', titulo: 'Estado de plantilla', mensaje: `"${nombre}" → ${value.event}` }
    : null;
}
