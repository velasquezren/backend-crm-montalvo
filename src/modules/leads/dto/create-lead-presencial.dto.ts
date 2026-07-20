import { IsOptional, IsPhoneNumber, IsString, MinLength } from 'class-validator';

/** RF-07 — alta rápida en ventanilla. El agente y la fecha salen del JWT/servidor. */
export class CreateLeadPresencialDto {
  @IsString()
  @MinLength(2)
  nombre!: string;

  @IsPhoneNumber()
  telefono!: string;

  @IsOptional()
  @IsString()
  interes?: string;
}
