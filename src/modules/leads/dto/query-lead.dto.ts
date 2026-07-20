import { OrigenLead } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class QueryLeadDto {
  @IsOptional()
  @IsEnum(OrigenLead)
  origen?: OrigenLead;

  @IsOptional()
  @IsString()
  agenteId?: string;
}
