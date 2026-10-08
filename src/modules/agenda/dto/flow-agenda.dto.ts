import { IsString, MaxLength, MinLength } from 'class-validator';

/** El sobre que manda WhatsApp al endpoint de un Flow (data_api_version 3.0). */
export class PeticionFlowCifradaDto {
  @IsString() @MinLength(16) @MaxLength(200_000)
  encrypted_flow_data!: string;

  @IsString() @MinLength(16) @MaxLength(4_000)
  encrypted_aes_key!: string;

  @IsString() @MinLength(8) @MaxLength(100)
  initial_vector!: string;
}
