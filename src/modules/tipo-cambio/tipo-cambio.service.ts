import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FuenteTipoCambio } from '@prisma/client';

import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Último recurso, solo si la tabla está vacía de verdad (recién migrada y el
 * primer intento automático todavía no corrió). Antes esto era la ÚNICA
 * fuente de verdad del sistema entero (`MonedaService` del frontend) — el bug
 * que motivó este módulo: quedó fijo en 6.97 mientras el oficial subía a 11.54.
 */
const TIPO_CAMBIO_RESPALDO = 6.97;

/**
 * bcb.gob.bo NO expone API propia — solo descargas de Excel/PDF por año
 * (`/tiposDeCambioHistorico/xls.php?anio=`). Este es un espejo público de
 * terceros que replica el mismo TCO oficial en JSON, sin key. Por eso lo que
 * trae se guarda como `AUTOMATICO`, nunca como "oficial": si el espejo se cae
 * o cambia de forma, un ADMIN sigue pudiendo cargar el valor a mano viéndolo
 * directamente en bcb.gob.bo (`corregirManual`, que además siempre gana).
 */
const URL_TC_OFICIAL_ESPEJO = 'https://apibcb.cucu.bo/api/v1/tc/oficial';

const SEIS_HORAS_MS = 6 * 60 * 60 * 1000;

interface RespuestaEspejoBcb {
  tc_oficial?: {
    valor?: number;
    fecha?: string; // YYYY-MM-DD, la fecha para la que el BCB marca este TCO como vigente
  };
}

export interface TipoCambioVigenteRespuesta {
  tipoCambio: number;
  fecha: string | null;
  fuente: FuenteTipoCambio | 'RESPALDO';
}

export interface ResultadoSincronizacion {
  actualizado: boolean;
  motivo: 'ok' | 'sin_cambios' | 'ya_hay_valor_manual' | 'fetch_fallido' | 'respuesta_invalida';
  fecha?: string;
  valor?: number;
}

/**
 * Serie histórica del tipo de cambio oficial USD→BOB (modelo `TipoCambioDiario`).
 *
 * Fuente híbrida, a propósito: un intervalo intenta traer el valor del día desde
 * `URL_TC_OFICIAL_ESPEJO` cada 6 horas (un `setInterval` que sobrevive a un
 * `systemctl restart` a cualquier hora, en vez de un cron a hora fija que se
 * puede saltar un reinicio), y CUALQUIER valor cargado a mano por un ADMIN
 * (`corregirManual`) le gana siempre a uno automático — ver el chequeo de
 * `fuente === 'MANUAL'` en `sincronizarAutomatico`.
 *
 * No confundir con `PeriodoComision.tipoCambio`: ese es el TC de un mes de
 * liquidación ya cerrado (columna del Excel de FileMaker) y se queda fijo para
 * siempre. Este historial es la cotización día a día que usa el resto del CRM
 * para mostrar montos en dólares (selector Bs/$us, KPIs, tabla de Ventas).
 */
@Injectable()
export class TipoCambioService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TipoCambioService.name);
  private intervalo?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  onModuleInit(): void {
    /* La suite de unit/integración de este backend instancia los services a
       mano (`new XService(...)`), no el módulo Nest completo, así que esto no
       las afecta hoy. Igual se guarda por si algún día alguien bootstrapea el
       AppModule entero en una prueba: no tiene sentido pegarle a un servicio
       de terceros en cada corrida de test. */
    if (process.env.NODE_ENV === 'test') return;

    void this.sincronizarAutomatico();
    this.intervalo = setInterval(() => void this.sincronizarAutomatico(), SEIS_HORAS_MS);
    this.intervalo.unref(); // no debe ser el motivo por el que el proceso sigue vivo
  }

  onModuleDestroy(): void {
    if (this.intervalo) clearInterval(this.intervalo);
  }

  /** El más reciente con fecha <= hoy. Si la tabla está vacía, el respaldo fijo. */
  async vigente(): Promise<TipoCambioVigenteRespuesta> {
    const fila = await this.prisma.tipoCambioDiario.findFirst({
      where: { fecha: { lte: new Date() } },
      orderBy: { fecha: 'desc' },
    });

    if (!fila) {
      return { tipoCambio: TIPO_CAMBIO_RESPALDO, fecha: null, fuente: 'RESPALDO' };
    }

    return { tipoCambio: Number(fila.valor), fecha: formatearFecha(fila.fecha), fuente: fila.fuente };
  }

  /** Serie de un mes calendario completo, para la pantalla de administración. */
  async historial(anio: number, mes: number) {
    const desde = new Date(Date.UTC(anio, mes - 1, 1));
    const hasta = new Date(Date.UTC(anio, mes, 1));

    return this.prisma.tipoCambioDiario.findMany({
      where: { fecha: { gte: desde, lt: hasta } },
      orderBy: { fecha: 'asc' },
    });
  }

  /** Corrección manual de un día — siempre gana sobre lo automático. Queda en AuditLog. */
  async corregirManual(fechaTexto: string, valor: number, usuarioId: string) {
    const fecha = parsearFecha(fechaTexto);

    const fila = await this.prisma.tipoCambioDiario.upsert({
      where: { fecha },
      create: { fecha, valor, fuente: 'MANUAL', actualizadoPorId: usuarioId },
      update: { valor, fuente: 'MANUAL', actualizadoPorId: usuarioId },
    });

    await this.auditService.registrar('TipoCambioDiario', fechaTexto, 'CORRECCION_MANUAL', usuarioId, { valor });
    return fila;
  }

  /**
   * Intenta traer el valor vigente del espejo y lo guarda. Nunca lanza: un
   * tercero caído no puede tumbar el arranque del proceso ni una llamada manual
   * desde el panel (`POST /tipo-cambio/sincronizar`).
   */
  async sincronizarAutomatico(): Promise<ResultadoSincronizacion> {
    let cuerpo: RespuestaEspejoBcb;
    try {
      const respuesta = await fetch(URL_TC_OFICIAL_ESPEJO, { signal: AbortSignal.timeout(8_000) });
      if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
      cuerpo = (await respuesta.json()) as RespuestaEspejoBcb;
    } catch (error) {
      this.logger.warn(
        `No se pudo sincronizar el tipo de cambio automático: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { actualizado: false, motivo: 'fetch_fallido' };
    }

    const valor = cuerpo.tc_oficial?.valor;
    const fechaTexto = cuerpo.tc_oficial?.fecha;
    if (!valor || !(valor > 0) || !fechaTexto) {
      this.logger.warn('Respuesta del espejo de tipo de cambio sin la forma esperada, se ignora.');
      return { actualizado: false, motivo: 'respuesta_invalida' };
    }

    const fecha = parsearFecha(fechaTexto);
    const existente = await this.prisma.tipoCambioDiario.findUnique({ where: { fecha } });

    if (existente?.fuente === 'MANUAL') {
      return { actualizado: false, motivo: 'ya_hay_valor_manual', fecha: fechaTexto };
    }
    if (existente && Number(existente.valor) === valor) {
      return { actualizado: false, motivo: 'sin_cambios', fecha: fechaTexto, valor };
    }

    await this.prisma.tipoCambioDiario.upsert({
      where: { fecha },
      create: { fecha, valor, fuente: 'AUTOMATICO' },
      update: { valor, fuente: 'AUTOMATICO' },
    });

    this.logger.log(`Tipo de cambio sincronizado automáticamente: ${fechaTexto} = ${valor}`);
    return { actualizado: true, motivo: 'ok', fecha: fechaTexto, valor };
  }
}

function parsearFecha(fechaTexto: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaTexto)) {
    throw new BadRequestException(`Fecha inválida: "${fechaTexto}" (formato esperado AAAA-MM-DD)`);
  }
  const fecha = new Date(`${fechaTexto}T00:00:00.000Z`);
  if (Number.isNaN(fecha.getTime())) {
    throw new BadRequestException(`Fecha inválida: "${fechaTexto}"`);
  }
  return fecha;
}

function formatearFecha(fecha: Date): string {
  return fecha.toISOString().slice(0, 10);
}
