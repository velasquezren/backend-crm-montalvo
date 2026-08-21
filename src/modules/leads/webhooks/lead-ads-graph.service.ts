import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Único punto del CRM que resuelve un `leadgen_id` de Meta Lead Ads contra la
 * Graph API. El webhook solo entrega un identificador opaco (RF-04); sin esta
 * llamada nunca se sabe el nombre ni el teléfono de quien llenó el formulario
 * — que es exactamente lo que se quedaba sin hacer antes de este cambio.
 *
 * Mismo criterio que `WhatsappCloudService`: nunca lanza. Un problema hablando
 * con Meta (token vencido, rate limit, red caída) no puede tumbar el resto del
 * lote del webhook — quien llama decide qué hacer con un `null`.
 */

/** Se sube tocando solo esta línea — mismo criterio que WhatsappCloudService. */
const VERSION_API = 'v25.0';
const BASE = `https://graph.facebook.com/${VERSION_API}`;

export interface LeadAdsResuelto {
  nombre: string;
  telefono: string;
  origen: 'FACEBOOK_LEAD_AD' | 'INSTAGRAM_LEAD_AD';
  /** `ad_id` de Graph API, si Meta lo devolvió. Ver `Lead.anuncioId` en el schema. */
  anuncioId?: string;
}

interface CampoFormulario {
  name?: string;
  values?: string[];
}

interface RespuestaLeadgen {
  field_data?: CampoFormulario[];
  ad_id?: string;
  form_id?: string;
  /** 'fb' o 'ig', según de qué plataforma vino el formulario. */
  platform?: string;
}

/** Primer valor del campo con ese nombre exacto (Meta los manda en minúsculas: full_name, phone_number…). */
function valorDeCampo(campos: CampoFormulario[] | undefined, nombre: string): string | undefined {
  return campos?.find(c => c.name === nombre)?.values?.[0]?.trim() || undefined;
}

/** Primer valor de un campo cuyo nombre CONTIENE el fragmento — respaldo para formularios con preguntas custom. */
function valorDeCampoQueContenga(campos: CampoFormulario[] | undefined, fragmento: string): string | undefined {
  return campos?.find(c => c.name?.toLowerCase().includes(fragmento))?.values?.[0]?.trim() || undefined;
}

/** `full_name` es el campo estándar de Meta; si el formulario solo pide nombre y apellido por separado, se componen. */
function nombreDelLead(campos: CampoFormulario[] | undefined): string | undefined {
  const completo = valorDeCampo(campos, 'full_name');
  if (completo) return completo;

  const nombre = valorDeCampo(campos, 'first_name');
  const apellido = valorDeCampo(campos, 'last_name');
  const compuesto = [nombre, apellido].filter(Boolean).join(' ').trim();
  return compuesto || undefined;
}

@Injectable()
export class LeadAdsGraphService {
  private readonly logger = new Logger(LeadAdsGraphService.name);

  constructor(private readonly config: ConfigService) {}

  private get token(): string | undefined {
    return this.config.get<string>('PAGE_ACCESS_TOKEN');
  }

  /** Sin token el CRM sigue funcionando: el webhook loguea y no resuelve, igual que WhatsApp sin credenciales. */
  get habilitado(): boolean {
    return Boolean(this.token);
  }

  /**
   * Resuelve un `leadgen_id` contra `GET /{leadgen_id}` de la Graph API.
   *
   * `null` significa "no se pudo resolver" —sin token, error de Meta, campos
   * ausentes en el formulario— y quien llama decide qué hacer (hoy: descartar
   * y loguear, nunca crear un cliente sin teléfono).
   */
  async resolverLead(leadgenId: string): Promise<LeadAdsResuelto | null> {
    if (!this.habilitado) {
      this.logger.warn(
        `PAGE_ACCESS_TOKEN no configurado: no se puede resolver el lead ${leadgenId} contra Graph API`,
      );
      return null;
    }

    try {
      const respuesta = await fetch(`${BASE}/${leadgenId}?fields=field_data,ad_id,form_id,platform`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });

      if (!respuesta.ok) {
        this.logger.error(
          `Graph API rechazó el lead ${leadgenId} (${respuesta.status}): ${await respuesta.text()}`,
        );
        return null;
      }

      const datos = (await respuesta.json()) as RespuestaLeadgen;
      const nombre = nombreDelLead(datos.field_data);
      const telefono =
        valorDeCampo(datos.field_data, 'phone_number') ?? valorDeCampoQueContenga(datos.field_data, 'phone');

      /* Sin teléfono no hay con qué crear (ni encontrar) el Cliente — Cliente.telefono
         es obligatorio y único. Un formulario mal configurado no puede colar un
         registro a medias. */
      if (!nombre || !telefono) {
        this.logger.warn(
          `Lead ${leadgenId} sin nombre o teléfono en field_data (campos: ${
            datos.field_data?.map(c => c.name).join(', ') || 'ninguno'
          }); se descarta`,
        );
        return null;
      }

      return {
        nombre,
        telefono,
        origen: datos.platform === 'ig' ? 'INSTAGRAM_LEAD_AD' : 'FACEBOOK_LEAD_AD',
        anuncioId: datos.ad_id,
      };
    } catch (error) {
      this.logger.error(`Excepción resolviendo el lead ${leadgenId} contra Graph API`, error);
      return null;
    }
  }
}
