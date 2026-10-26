import * as Sentry from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';

/**
 * Rastreo de errores: lo que hoy solo queda en `journalctl` llega, agrupado y
 * con su stack, a Sentry o a GlitchTip (el mismo protocolo, alojable por la
 * clínica: lo decide el DSN). **Apagado sin `SENTRY_DSN`.**
 *
 * Solo se reportan los errores inesperados, desde tres sitios que ya los
 * concentraban: el filtro global (un 500 sin capturar), `enSegundoPlano` (un
 * trabajo de fondo que falló) y las tareas periódicas. Un 400 o un 404 no son
 * errores de la aplicación.
 *
 * Sin rastreo de rendimiento ni auto-instrumentación (`defaultIntegrations:
 * false`): en este Xeon cada capa sobre Express se paga, y lo que falta es saber
 * QUÉ falló, no cuánto tardó. Un rechazo sin manejar sigue tumbando el proceso
 * como siempre (`mode: 'strict'`), para que systemd lo releve: el SDK no puede
 * cambiar esa semántica en silencio.
 *
 * Nada de la paciente sale del servidor: `limpiarEvento` quita la petición, el
 * usuario y las migas, y enmascara teléfonos, correos, BSUID y tokens del texto.
 */
let activo = false;

export function iniciarRastreoDeErrores(entorno: NodeJS.ProcessEnv = process.env): boolean {
  const dsn = entorno['SENTRY_DSN']?.trim();
  if (!dsn || entorno['NODE_ENV'] === 'test') return false;
  Sentry.init({
    dsn,
    environment: entorno['SENTRY_ENVIRONMENT']?.trim() || entorno['NODE_ENV'] || 'production',
    release: entorno['SENTRY_RELEASE']?.trim() || undefined,
    /* La v11 recoge por defecto cabeceras, cookies, cuerpos y query: todo apagado.
       Del error solo interesa qué falló y dónde. */
    dataCollection: {
      userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false,
      databaseQueryData: false, queues: false, stackFrameVariables: false, frameContextLines: 0,
      graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false }, mcp: { inputs: false, outputs: false },
    },
    maxBreadcrumbs: 0,
    defaultIntegrations: false,
    enableRuntimeChannelInjection: false,
    integrations: [
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration({ mode: 'strict' }),
      Sentry.linkedErrorsIntegration(),
      Sentry.nodeContextIntegration(),
      Sentry.dedupeIntegration(),
    ],
    beforeSend: evento => limpiarEvento(evento),
  });
  activo = true;
  return true;
}

/** Reporta un error inesperado con dónde pasó. Sin DSN no hace nada; nunca lanza. */
export function reportarError(error: unknown, contexto: { readonly origen: string; readonly requestId?: string }): void {
  if (!activo) return;
  try {
    Sentry.withScope(alcance => {
      alcance.setTag('origen', redactar(contexto.origen).slice(0, 200));
      if (contexto.requestId) alcance.setTag('requestId', contexto.requestId);
      Sentry.captureException(error);
    });
  } catch {
    /* Reportar un error no puede provocar otro. */
  }
}

/** Lo que sale del servidor: el error y su stack, sin datos de la petición ni de la paciente. */
export function limpiarEvento(evento: ErrorEvent): ErrorEvent {
  delete evento.request;
  delete evento.user;
  delete evento.breadcrumbs;
  delete evento.extra;
  if (evento.message) evento.message = redactar(evento.message);
  for (const excepcion of evento.exception?.values ?? []) {
    if (excepcion.value) excepcion.value = redactar(excepcion.value);
    for (const marco of excepcion.stacktrace?.frames ?? []) delete marco.vars;
  }
  return evento;
}

/**
 * Enmascara lo que puede identificar a alguien en el texto de un error: un
 * mensaje de Meta trae el número al que no pudo enviar; uno de Prisma, a veces,
 * el valor que chocó. Lo demás —qué falló y dónde— queda intacto.
 */
export function redactar(texto: string): string {
  return texto
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jwt]')
    .replace(/Bearer\s+[\w.~+/-]+=*/gi, 'Bearer [token]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[correo]')
    .replace(/\b[A-Z]{2}\.(?:[A-Z]{2,8}\.)?[A-Za-z0-9]{6,128}\b/g, '[bsuid]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[número]');
}
