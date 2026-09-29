import { IsPhoneNumber } from 'class-validator';

/**
 * Lo único que la asistente aporta sobre la ficha del paciente de un informe.
 * Misma regla que `CreateClienteDto.telefono`: formato internacional (`+591…`);
 * la pantalla ya convierte `70012345` antes de enviarlo.
 */
export class TelefonoPacienteDto {
  @IsPhoneNumber()
  telefono!: string;
}
