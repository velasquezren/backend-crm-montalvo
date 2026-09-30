import { ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

/** Una fila de la cola del portal de resultados. Contrato de su API, no nuestro. */
/** Filtros de `GET /v1/integraciones/crm/informes`. Ver `docs/api.md` del portal. */
export interface FiltrosCola {
  pagina?: number;
  limite?: number;
  informeId?: string;
  /** Hasta 100; el portal los devuelve en este orden. */
  ids?: string[];
  /** Nombre, PAC o CI, crudo: el portal escapa los comodines de LIKE. */
  buscar?: string;
  abierto?: boolean;
  vigente?: boolean;
}

export interface PanoramaCola {
  totales: { todos: number; abiertos: number; vencidosSinAbrir: number };
  /** Vigentes y sin abrir, ordenados como la cola. Acotado: el enlace dura 30 días. */
  vigentesSinAbrir: string[];
  /** El conjunto superó el tope del portal: la cola lo dice en vez de callarlo. */
  truncado: boolean;
  /** Solo con búsqueda: cuáles del conjunto responden a ella. */
  coinciden?: string[];
}

export interface InformePublicado {
  informeId: string;
  /**
   * Cómo está registrado el paciente en el portal. El CRM lo reconoce con
   * estos identificadores (`ClientesService.reconocerPacientes`) y el nombre
   * se le muestra a la asistente para comparar antes de enviar.
   */
  paciente: { nombre: string; pac: string | null; ci: string | null };
  estudio: string;
  fechaEstudio: string;
  publicadoEn: string | null;
  /**
   * El acceso del paciente. Es la llave del enlace (desde el 2026-09-23 no hay
   * código): quien abre `…/resultados/<accesoId>` ve el informe.
   */
  accesoId: string;
  accesoVigente: boolean;
  accesoExpiraEn: string;
  /** Primera vez que el paciente lo abrió; `null` si todavía no. */
  abiertoEn: string | null;
}

interface ColaInformes {
  datos: InformePublicado[];
  total: number;
}

/**
 * Lectura del portal de resultados, que vive en el MISMO servidor detrás de
 * loopback. No es una base compartida ni un join entre bases: es su API
 * pública de integración, con su propia credencial de solo lectura.
 *
 * Se espera (`await`) a propósito: a diferencia del envío a Meta, esta llamada
 * SÍ determina lo que ve el usuario, así que no cabe dispararla en segundo
 * plano. Es loopback, no sale a internet.
 */
@Injectable()
export class PortalResultadosClient {
  private readonly logger = new Logger(PortalResultadosClient.name);

  private configuracion(): { base: string; token: string } {
    const base = process.env.PORTAL_RESULTADOS_URL;
    const token = process.env.PORTAL_RESULTADOS_TOKEN;
    /* 503 con el nombre de la variable que falta. No es un webhook de Meta, así
       que no hay riesgo de que un reintento eterno desactive una suscripción:
       lo pide una persona desde el CRM y el mensaje dice qué arreglar. */
    if (!base || !token) {
      throw new ServiceUnavailableException(
        `La entrega de resultados no está configurada en el servidor: falta ${!base ? 'PORTAL_RESULTADOS_URL' : 'PORTAL_RESULTADOS_TOKEN'}.`,
      );
    }
    return { base: base.replace(/\/$/, ''), token };
  }

  /**
   * El enlace para revisar un informe publicado en el visor del portal —el
   * mismo que usa el médico—, firmado y válido 10 minutos.
   *
   * El CRM recibe el enlace, nunca el PDF: la asistente lo abre directo en el
   * portal, que sirve la versión liviana del informe (la misma que recibe la
   * paciente) sin pasar por aquí. Y no es el enlace del paciente: ese marca
   * `abiertoEn`, y entonces la fila diría «Abierto por el paciente».
   */
  enlaceRevision(informeId: string): Promise<{ url: string; expiraEn: string }> {
    return this.pedir(`/v1/integraciones/crm/informes/${informeId}/revision`, 'POST');
  }

  /** Informes publicados. Con `informeId`, solo ese. */
  /**
   * La cola del portal. Los filtros los resuelve el PORTAL, donde se corta la
   * página: filtrar aquí una página ya cortada haría que una pestaña dijera
   * «no hay más» con informes en la página siguiente.
   */
  async informes(params: FiltrosCola): Promise<ColaInformes> {
    const query = new URLSearchParams();
    if (params.pagina) query.set('pagina', String(params.pagina));
    if (params.limite) query.set('limite', String(params.limite));
    if (params.informeId) query.set('informeId', params.informeId);
    if (params.ids?.length) query.set('ids', params.ids.join(','));
    if (params.buscar) query.set('buscar', params.buscar);
    if (params.abierto !== undefined) query.set('abierto', String(params.abierto));
    if (params.vigente !== undefined) query.set('vigente', String(params.vigente));
    return this.pedir<ColaInformes>(`/v1/integraciones/crm/informes?${query}`, 'GET');
  }

  /**
   * Totales y conjunto de trabajo —ids vigentes y sin abrir, enteros— para las
   * pestañas. «Por avisar» y «esperando lectura» son ese conjunto partido por
   * lo que solo sabe el CRM: si ya se avisó. Ver el portal, `panoramaForCrm`.
   */
  panorama(buscar?: string): Promise<PanoramaCola> {
    const query = buscar ? `?${new URLSearchParams({ buscar })}` : '';
    return this.pedir<PanoramaCola>(`/v1/integraciones/crm/informes/panorama${query}`, 'GET');
  }

  /** Extiende 30 días el acceso de un informe publicado; el enlace no cambia. */
  renovarAcceso(informeId: string): Promise<{ accesoId: string; expiraEn: string }> {
    return this.pedir(`/v1/integraciones/crm/informes/${informeId}/acceso/renovar`, 'POST');
  }

  private async pedir<T>(ruta: string, method: 'GET' | 'POST'): Promise<T> {
    const { base, token } = this.configuracion();
    let respuesta: Response;
    try {
      respuesta = await fetch(`${base}${ruta}`, {
        method,
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      /* Transitorio de verdad: el portal caído o lento. Reintentar puede salir bien. */
      this.logger.error('No se pudo consultar el portal de resultados', error as Error);
      throw new ServiceUnavailableException('El portal de resultados no responde. Intenta de nuevo en un momento.');
    }
    /* Estas dos no son caídas del portal: son respuestas sobre el informe, y
       decir «el portal no responde» mandaría a reintentar algo que no cambia. */
    if (respuesta.status === 404) throw new NotFoundException('Ese informe ya no está publicado en el portal.');
    if (respuesta.status === 409) throw new ConflictException('El informe fue retirado: su enlace no se puede renovar.');
    if (!respuesta.ok) {
      this.logger.error(`El portal de resultados respondió ${respuesta.status}`);
      throw new ServiceUnavailableException(
        respuesta.status === 401
          ? 'El CRM no está autorizado en el portal de resultados. Revisa PORTAL_RESULTADOS_TOKEN.'
          : 'El portal de resultados no pudo atender la consulta.',
      );
    }
    return (await respuesta.json()) as T;
  }
}
