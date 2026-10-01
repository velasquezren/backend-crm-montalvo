import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { CategoriaCliente } from '../../../prisma/prisma-client';

/** Una variable de la plantilla: el nombre de la paciente o un texto fijo. Ver `VariableCampana`. */
export class VariableCampanaDto {
  @IsIn(['NOMBRE', 'TEXTO'])
  tipo!: 'NOMBRE' | 'TEXTO';

  /** Con `NOMBRE`: lo que va si la ficha no tiene nombre de verdad. */
  @ValidateIf((v: VariableCampanaDto) => v.tipo === 'NOMBRE')
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  respaldo?: string;

  /** Con `TEXTO`: el mismo valor para todas. */
  @ValidateIf((v: VariableCampanaDto) => v.tipo === 'TEXTO')
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  texto?: string;
}

/** La audiencia, con los mismos campos que `GET /audiencias`. */
export class FiltroCampanaDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(CategoriaCliente, { each: true })
  categorias!: CategoriaCliente[];

  @IsInt()
  @Min(0)
  @Max(365)
  diasSinCampana!: number;

  @IsBoolean()
  soloConversaron!: boolean;
}

export class CrearCampanaDto {
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  nombre!: string;

  @IsUUID()
  lineaId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(512)
  plantilla!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(20)
  idioma!: string;

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => VariableCampanaDto)
  variables!: VariableCampanaDto[];

  @ValidateNested()
  @Type(() => FiltroCampanaDto)
  filtro!: FiltroCampanaDto;

  /** Dólares por plantilla entregada con que se estimó: queda con la campaña. */
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  tarifaUsd!: number;

  /** Cuándo empieza; sin esto, ahora (dentro del horario de envío). */
  @IsOptional()
  @IsDateString()
  programadaPara?: string;

  /**
   * Cuántas elegibles vio quien la lanza. Si al crearla la audiencia ya no es
   * esa —alguien pidió la baja, entró una planilla—, 409 con el número nuevo:
   * nadie aprueba mandarle a 47 y termina mandándole a 60.
   */
  @IsInt()
  @Min(1)
  elegiblesVistas!: number;
}
