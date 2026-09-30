import { PartialType } from '@nestjs/mapped-types';
import { IsBoolean, IsOptional } from 'class-validator';

import { CreateClienteDto } from './create-cliente.dto';

export class UpdateClienteDto extends PartialType(CreateClienteDto) {
  /**
   * `false` la da de baja de las promociones; `true` las reactiva —porque ella
   * lo pidió—. Normalmente la baja la registra la propia paciente al tocar
   * «No me interesa»; esto es para cuando lo dice de palabra. Ver
   * `Cliente.bajaPromocionesEn`.
   */
  @IsOptional()
  @IsBoolean()
  recibePromociones?: boolean;
}
