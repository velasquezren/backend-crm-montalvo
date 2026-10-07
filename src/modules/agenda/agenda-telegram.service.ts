import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { enSegundoPlano } from '../../common/fiabilidad/en-segundo-plano';

/** Telegram interpreta estos caracteres como formato (Markdown); en un nombre lo romperían. */
const escapar = (texto: string) => texto.replace(/[_*`[\]]/g, '\\$&');

/**
 * El aviso que la clínica ya recibe de ScriptCase en su grupo de Telegram, con
 * el MISMO texto, para que una reserva hecha en la web se atienda igual que
 * una de la agenda anterior. Mismo bot y mismo chat (`AGENDA_TELEGRAM_*`).
 * Sin configuración no avisa; un fallo nunca deshace la reserva.
 */
@Injectable()
export class AgendaTelegramService {
  private readonly logger = new Logger(AgendaTelegramService.name);
  private readonly token: string | null;
  private readonly chat: string | null;

  constructor(config: ConfigService) {
    this.token = config.get<string>('AGENDA_TELEGRAM_TOKEN')?.trim() || null;
    this.chat = config.get<string>('AGENDA_TELEGRAM_CHAT')?.trim() || null;
  }

  nuevaCita(nombre: string, ci: string): void {
    this.enviar(`*🏥 NUEVA CITA REGISTRADA*\n\n*Paciente:* ${escapar(nombre)}\n*Carnet:* ${escapar(ci)}\n*Estado:* PENDIENTE`);
  }

  pagoParaVerificar(nombre: string, ci: string): void {
    this.enviar(`*🏥 VERIFICAR PAGO REALIZADO*\n\n*Paciente:* ${escapar(nombre)}\n*Carnet:* ${escapar(ci)}\n*Estado:* PAGADO`);
  }

  private enviar(texto: string): void {
    if (!this.token || !this.chat) return;
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    void enSegundoPlano('aviso de Telegram de la agenda', this.logger, async () => {
      const respuesta = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chat, text: texto, parse_mode: 'Markdown' }),
        signal: AbortSignal.timeout(10_000),
      });
      // El token va en la URL: nunca se registra la URL, solo el código.
      if (!respuesta.ok) this.logger.warn(`Telegram respondió ${respuesta.status} al aviso de la agenda`);
    });
  }
}
