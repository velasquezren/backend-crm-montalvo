import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { enSegundoPlano } from '../../common/fiabilidad/en-segundo-plano';
import { EscuchaAudiosService } from './escucha-audios.service';
import { lineasTranscripcionAudio, transcribirAudioEnLinea } from './transcripcion-audio-lineas';

/** Cola durable para leer audios en el CRM; no tiene dependencias de envío ni de IA conversacional. */
@Injectable()
export class TranscripcionAudioService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TranscripcionAudioService.name);
  private timer?: NodeJS.Timeout;
  private enCurso = false;
  private detenido = false;

  constructor(private readonly prisma: PrismaService, private readonly escuchas: EscuchaAudiosService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => this.despertar(), 15_000);
    this.timer.unref();
    this.despertar();
  }
  onModuleDestroy(): void { this.detenido = true; if (this.timer) clearInterval(this.timer); }
  private despertar(): void {
    void enSegundoPlano('transcripciones internas', this.logger, () => this.barrerPendientes());
  }

  async barrerPendientes(): Promise<void> {
    if (this.detenido || this.enCurso) return;
    const lineas = lineasTranscripcionAudio();
    if (!lineas.length) return;
    this.enCurso = true;
    try {
      const pendientes = await this.prisma.trabajoTranscripcionAudio.findMany({
        where: { proximoIntento: { lte: new Date() }, mensaje: { conversacion: { lineaId: { in: lineas }, linea: { activa: true } } } },
        select: { mensajeId: true }, orderBy: [{ proximoIntento: 'asc' }, { mensajeId: 'asc' }], take: 10,
      });
      for (const p of pendientes) {
        if (this.detenido) break;
        await this.procesarUno(p.mensajeId);
      }
    } finally { this.enCurso = false; }
  }

  async procesarUno(mensajeId: string): Promise<boolean> {
    return this.prisma.$transaction(async tx => {
      const [lock] = await tx.$queryRaw<{ obtenido: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${mensajeId}, 60063)) AS obtenido`;
      if (!lock?.obtenido) return false;
      const t = await this.prisma.trabajoTranscripcionAudio.findUnique({ where: { mensajeId }, include: {
        mensaje: { select: { id: true, tipo: true, direccion: true, automatico: true, transcripcion: true, mediaKey: true,
          conversacion: { select: { lineaId: true, linea: { select: { activa: true } } } } } },
      } });
      if (!t?.proximoIntento || t.proximoIntento > new Date()) return false;
      const m = t.mensaje;
      if (!m.conversacion.lineaId || !transcribirAudioEnLinea(m.conversacion.lineaId) || !m.conversacion.linea?.activa) return false;
      const terminar = (ultimoError: string | null) => tx.trabajoTranscripcionAudio.update({ where: { mensajeId }, data: { proximoIntento: null, ultimoError } });
      if (m.transcripcion) { await terminar(null); return true; }
      if (m.tipo !== 'AUDIO' || m.direccion !== 'ENTRANTE') { await terminar('NO_ES_AUDIO_ENTRANTE'); return true; }
      if (t.intentos >= 3 || Date.now() - t.createdAt.getTime() >= 86_400_000) { await terminar('INTENTOS_O_PLAZO_AGOTADOS'); return true; }
      if (!m.mediaKey) {
        await tx.trabajoTranscripcionAudio.update({ where: { mensajeId }, data: { proximoIntento: new Date(Date.now() + 30_000) } });
        return false;
      }
      // Persiste antes de llamar al proveedor: un reinicio no concede intentos ilimitados.
      await this.prisma.trabajoTranscripcionAudio.update({ where: { mensajeId }, data: { intentos: { increment: 1 }, proximoIntento: new Date(Date.now() + 120_000) } });
      const inicio = Date.now();
      const r = await this.escuchas.escuchar([m]);
      const texto = r.transcripciones.get(mensajeId);
      // Sin el texto (es de la paciente): solo si salió y cuánto tardó, para verificar desde journalctl.
      const segundos = ((Date.now() - inicio) / 1000).toFixed(1);
      if (texto) this.logger.log(`Audio ${mensajeId} transcrito en ${segundos} s (intento ${t.intentos + 1})`);
      else this.logger.warn(`Audio ${mensajeId} sin transcripción en ${segundos} s (intento ${t.intentos + 1} de 3)`);
      await tx.trabajoTranscripcionAudio.update({ where: { mensajeId }, data: {
        proximoIntento: texto || t.intentos + 1 >= 3 ? null : new Date(Date.now() + 120_000),
        ultimoError: texto ? null : 'TRANSCRIPCION_NO_DISPONIBLE',
      } });
      return true;
    }, { timeout: 120_000, maxWait: 5_000 });
  }
}
