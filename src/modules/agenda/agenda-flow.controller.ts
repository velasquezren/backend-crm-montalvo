import { Body, Controller, Header, HttpCode, HttpException, Logger, Post, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { createPrivateKey, KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Public } from '../../common/decorators/public.decorator';
import { MetaSignatureGuard } from '../../common/guards/meta-signature.guard';
import { cifrarRespuestaFlow, descifrarPeticionFlow, ErrorDeCifradoFlow } from '../../common/whatsapp/flows/cifrado-flow';
import { AgendaFlowService, TokenFlowInvalido } from './agenda-flow.service';
import { PeticionFlowCifradaDto } from './dto/flow-agenda.dto';

/**
 * Endpoint del Flow de WhatsApp «Reservar una cita». Lo llama el cliente de
 * WhatsApp en cada pantalla, a través de Meta:
 *
 * - firmado con el App Secret (`MetaSignatureGuard`, como los webhooks);
 * - cifrado con nuestra llave pública: la privada vive en el servidor
 *   (`WHATSAPP_FLOWS_LLAVE_ARCHIVO`, ver `scripts/whatsapp/flow-llaves.sh`);
 * - sin límite por IP: todas las pacientes llegan desde las IPs de Meta.
 *
 * Códigos del protocolo: 421 si no se puede descifrar (el cliente refresca la
 * llave pública y reintenta), 427 si el `flow_token` no es nuestro o venció
 * (el cliente cierra el Flow).
 */
@Public()
@SkipThrottle()
@Controller('whatsapp/flows/agenda')
export class AgendaFlowController {
  private readonly logger = new Logger(AgendaFlowController.name);
  private llave?: KeyObject;

  constructor(
    private readonly flow: AgendaFlowService,
    private readonly config: ConfigService,
  ) {}

  private llavePrivada(): KeyObject {
    if (this.llave) return this.llave;
    const archivo = this.config.get<string>('WHATSAPP_FLOWS_LLAVE_ARCHIVO')?.trim();
    if (!archivo) throw new ServiceUnavailableException('El Flow de reserva no está configurado.');
    try {
      this.llave = createPrivateKey({ key: readFileSync(archivo), passphrase: this.config.get<string>('WHATSAPP_FLOWS_LLAVE_CLAVE') || undefined });
      return this.llave;
    } catch (error) {
      this.logger.error(`No se pudo leer la llave del Flow: ${error instanceof Error ? error.message : 'error'}`);
      throw new ServiceUnavailableException('El Flow de reserva no está configurado.');
    }
  }

  @Post()
  @HttpCode(200)
  @UseGuards(MetaSignatureGuard)
  @Header('Content-Type', 'text/plain')
  @Header('Cache-Control', 'no-store')
  async responder(@Body() cuerpo: PeticionFlowCifradaDto): Promise<string> {
    let peticion;
    try {
      peticion = descifrarPeticionFlow(cuerpo, this.llavePrivada());
    } catch (error) {
      if (error instanceof ErrorDeCifradoFlow) throw new HttpException('No se pudo descifrar', 421);
      throw error;
    }
    try {
      const respuesta = await this.flow.responder(peticion.datos);
      return cifrarRespuestaFlow(respuesta, peticion.clave, peticion.vector);
    } catch (error) {
      if (error instanceof TokenFlowInvalido) throw new HttpException('Flow vencido o ajeno', 427);
      throw error;
    }
  }
}
