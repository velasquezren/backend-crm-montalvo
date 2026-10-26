import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { TareaPeriodica } from '../../common/trabajos/tarea-periodica.decorator';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { clicDeLaFicha, decidirAviso, ESPERA_ANTES_DE_AVISAR_MS, EventoCompra, leerRespuesta, ResultadoAviso } from './conversiones-meta';

/** La misma versión de Graph API que el resto del CRM (`WhatsappCloudService`). */
const BASE = 'https://graph.facebook.com/v25.0';
const ESPERA_MS = 10_000;
/** Ventas por vuelta. Son decenas al mes: si se llega, se avisa en el log. */
const TOPE_BARRIDO = 50;
/** Reintentos ante un límite de uso de Meta, con espera creciente. */
const MAX_INTENTOS = 5;
const ESPERA_REINTENTO_MS = 15 * 60 * 1000;

/**
 * Avisa a Meta cada venta que vino de un anuncio de Click-to-WhatsApp
 * (Conversions API para Business Messaging), para que optimice la campaña por
 * pacientes que pagan y no solo por conversaciones.
 *
 * **Apagado mientras `META_CONVERSIONES` no sea `on`**: ni registra ni envía.
 * Encenderlo es decisión de la clínica, no técnica: Meta restringe a los
 * anunciantes de salud y una compra unida a un anuncio médico puede revelar una
 * relación sanitaria (ver docs/conversiones-meta.md y CAMP-0 §CAMP-15).
 *
 * Es un outbox: `registrarCompra` deja la fila en la transacción de la venta, y
 * el barrido la revalida y la manda pasada una hora. Lo incierto no se reenvía
 * solo, porque Meta no deduplica estos eventos.
 */
@Injectable()
export class ConversionesMetaService {
  private readonly logger = new Logger(ConversionesMetaService.name);
  private faltaConfiguracionAvisada = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get activa(): boolean {
    return this.config.get<string>('META_CONVERSIONES') === 'on';
  }

  /**
   * Una venta acaba de quedar GANADA: deja su aviso pendiente, en la MISMA
   * transacción que la venta. SQL con `ON CONFLICT` y no `upsert`: un P2002
   * abortaría la transacción entera, es decir, la venta. Si ya se había
   * descartado (la anularon y ahora vuelve a GANADA) se reactiva; si ya se
   * envió, no se toca: Meta la contaría dos veces.
   */
  async registrarCompra(tx: Prisma.TransactionClient, ventaId: string, ocurridoEn = new Date()): Promise<void> {
    if (!this.activa) return;
    const avisarDesde = new Date(ocurridoEn.getTime() + ESPERA_ANTES_DE_AVISAR_MS);
    await tx.$executeRaw`
      INSERT INTO "ConversionMeta" ("id", "ventaId", "estado", "ocurridoEn", "proximoIntento", "updatedAt")
      VALUES (gen_random_uuid()::text, ${ventaId}, 'PENDIENTE', ${ocurridoEn}, ${avisarDesde}, now())
      ON CONFLICT ("ventaId") DO UPDATE
        SET "estado" = 'PENDIENTE', "ocurridoEn" = EXCLUDED."ocurridoEn", "proximoIntento" = EXCLUDED."proximoIntento",
            "intentos" = 0, "motivo" = NULL, "updatedAt" = now()
        WHERE "ConversionMeta"."estado" = 'DESCARTADO'`;
  }

  /** Cada cinco minutos (`TrabajosService`). Devuelve cuántas se resolvieron. */
  @TareaPeriodica({
    nombre: 'conversiones-meta', descripcion: 'aviso de ventas a Meta (Conversions API)',
    cron: '*/5 * * * *', cadaMs: 5 * 60 * 1000, limiteSegundos: 4 * 60,
  })
  async barrer(ahora = new Date()): Promise<number> {
    if (!this.activa) return 0;
    const dataset = this.config.get<string>('META_CONVERSIONES_DATASET_ID')?.trim();
    const token = this.config.get<string>('META_CONVERSIONES_TOKEN')?.trim();
    if (!dataset || !token) {
      if (!this.faltaConfiguracionAvisada) this.logger.error('META_CONVERSIONES=on sin META_CONVERSIONES_DATASET_ID o META_CONVERSIONES_TOKEN: no se avisa nada');
      this.faltaConfiguracionAvisada = true;
      return 0;
    }

    const pendientes = await this.prisma.conversionMeta.findMany({
      where: { estado: 'PENDIENTE', proximoIntento: { lte: ahora } },
      orderBy: { proximoIntento: 'asc' },
      take: TOPE_BARRIDO,
      select: { id: true, ventaId: true, ocurridoEn: true, intentos: true },
    });
    if (pendientes.length === TOPE_BARRIDO) this.logger.warn(`Avisos a Meta: se llegó al tope de ${TOPE_BARRIDO}; el resto sale en la vuelta siguiente`);

    let resueltas = 0;
    /* De a una: son pocas, y en serie no compiten con las agentes por el pool. */
    for (const fila of pendientes) {
      try {
        if (await this.avisarUna(fila, dataset, token, ahora)) resueltas++;
      } catch (error) {
        this.logger.error(`Aviso a Meta de la venta ${fila.ventaId} sin resolver`, error);
      }
    }
    return resueltas;
  }

  private async avisarUna(
    fila: { id: string; ventaId: string; ocurridoEn: Date; intentos: number },
    dataset: string, token: string, ahora: Date,
  ): Promise<boolean> {
    const decision = decidirAviso(await this.ventaParaAvisar(fila.ventaId), fila.ocurridoEn, ahora);
    if (!decision.avisar) {
      const { count } = await this.prisma.conversionMeta.updateMany({
        where: { id: fila.id, estado: 'PENDIENTE' }, data: { estado: 'DESCARTADO', motivo: decision.motivo },
      });
      return count > 0;
    }

    /* Se reclama marcándola INCIERTO ANTES de llamar a Meta, como el despacho de
       mensajes: si el proceso muere en medio, queda incierta y no se reenvía a
       ciegas (Meta la contaría dos veces). */
    const { count } = await this.prisma.conversionMeta.updateMany({
      where: { id: fila.id, estado: 'PENDIENTE', proximoIntento: { lte: ahora } },
      data: { estado: 'INCIERTO', motivo: 'Enviando a Meta', intentos: { increment: 1 } },
    });
    if (!count) return false; // otra vuelta la tomó

    const resultado = await this.enviar(decision.evento, dataset, token);
    await this.prisma.conversionMeta.update({ where: { id: fila.id }, data: this.datosDeResultado(resultado, fila.intentos + 1, ahora) });
    if (resultado.estado === 'FALLIDO') this.logger.error(`Meta rechazó el aviso de la venta ${fila.ventaId}: ${resultado.motivo}`);
    return resultado.estado !== 'REINTENTAR';
  }

  private datosDeResultado(resultado: ResultadoAviso, intentos: number, ahora: Date): Prisma.ConversionMetaUpdateInput {
    switch (resultado.estado) {
      case 'ENVIADO':
        return { estado: 'ENVIADO', motivo: null, fbtraceId: resultado.fbtraceId, enviadoEn: ahora };
      case 'REINTENTAR':
        return intentos >= MAX_INTENTOS
          ? { estado: 'FALLIDO', motivo: `Sin éxito tras ${intentos} intentos. ${resultado.motivo}`.slice(0, 300) }
          : { estado: 'PENDIENTE', motivo: resultado.motivo, proximoIntento: new Date(ahora.getTime() + ESPERA_REINTENTO_MS * 2 ** (intentos - 1)) };
      case 'FALLIDO':
      case 'INCIERTO':
        return { estado: resultado.estado, motivo: resultado.motivo };
    }
  }

  /** Lectura agregada de otros dominios (venta, lead, ficha, línea): permitida, no escribe en ellos. */
  private async ventaParaAvisar(ventaId: string) {
    const venta = await this.prisma.venta.findUnique({
      where: { id: ventaId },
      select: {
        id: true, estado: true, monto: true,
        cliente: { select: { datosExtra: true } },
        lead: {
          select: {
            anuncioId: true, metaLeadId: true,
            primerContacto: { select: { conversacion: { select: { linea: { select: { wabaId: true } } } } } },
          },
        },
      },
    });
    if (!venta) return null;
    return {
      id: venta.id,
      estado: venta.estado,
      monto: Number(venta.monto),
      lead: venta.lead ? {
        anuncioId: venta.lead.anuncioId,
        metaLeadId: venta.lead.metaLeadId,
        wabaId: venta.lead.primerContacto?.conversacion.linea.wabaId ?? null,
      } : null,
      clic: clicDeLaFicha(venta.cliente.datosExtra),
    };
  }

  /** Nunca lanza: un corte de red o un 5xx es INCIERTO, nunca «no salió». */
  private async enviar(evento: EventoCompra, dataset: string, token: string): Promise<ResultadoAviso> {
    const prueba = this.config.get<string>('META_CONVERSIONES_PRUEBA')?.trim();
    try {
      const respuesta = await fetch(`${BASE}/${encodeURIComponent(dataset)}/events`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(ESPERA_MS),
        /* `test_event_code`: el evento aparece en «Probar eventos» del dataset y no cuenta para la campaña. */
        body: JSON.stringify({ data: [evento], ...(prueba ? { test_event_code: prueba } : {}) }),
      });
      const cuerpo: unknown = await respuesta.json().catch(() => null);
      return leerRespuesta(respuesta.status, cuerpo);
    } catch (error) {
      return { estado: 'INCIERTO', motivo: `Sin respuesta de Meta: ${error instanceof Error ? error.name : 'error'}` };
    }
  }
}
