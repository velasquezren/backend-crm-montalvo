import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

/** Una fila de la cola del portal de resultados. Contrato de su API, no nuestro. */
export interface InformePublicado {
  informeId: string;
  /** PAC canónico del paciente: la clave con la que el CRM lo reconoce. */
  referenciaCrm: string;
  estudio: string;
  fechaEstudio: string;
  publicadoEn: string | null;
  /** Identifica el acceso del paciente; NO lo autoriza — eso lo hace su código. */
  accesoId: string;
  accesoVigente: boolean;
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

  /** Informes publicados de pacientes vinculados. Con `informeId`, solo ese. */
  async informes(params: { pagina?: number; limite?: number; informeId?: string }): Promise<ColaInformes> {
    const { base, token } = this.configuracion();
    const query = new URLSearchParams();
    if (params.pagina) query.set('pagina', String(params.pagina));
    if (params.limite) query.set('limite', String(params.limite));
    if (params.informeId) query.set('informeId', params.informeId);

    let respuesta: Response;
    try {
      respuesta = await fetch(`${base}/v1/integraciones/crm/informes?${query}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      /* Transitorio de verdad: el portal caído o lento. Reintentar puede salir bien. */
      this.logger.error('No se pudo consultar el portal de resultados', error as Error);
      throw new ServiceUnavailableException('El portal de resultados no responde. Intenta de nuevo en un momento.');
    }
    if (!respuesta.ok) {
      this.logger.error(`El portal de resultados respondió ${respuesta.status}`);
      throw new ServiceUnavailableException(
        respuesta.status === 401
          ? 'El CRM no está autorizado en el portal de resultados. Revisa PORTAL_RESULTADOS_TOKEN.'
          : 'El portal de resultados no pudo atender la consulta.',
      );
    }
    return (await respuesta.json()) as ColaInformes;
  }
}
