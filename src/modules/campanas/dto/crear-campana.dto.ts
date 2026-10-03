import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsDefined,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
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

const recortar = ({ value }: { value: unknown }): unknown => typeof value === 'string' ? value.trim() : value;

/** Una variable de la plantilla: el nombre de la paciente o un texto fijo. Ver `VariableCampana`. */
export class VariableCampanaDto {
  @IsIn(['NOMBRE', 'TEXTO'])
  tipo!: 'NOMBRE' | 'TEXTO';

  /** Con `NOMBRE`: lo que va si la ficha no tiene nombre de verdad. */
  @ValidateIf((v: VariableCampanaDto) => v.tipo === 'NOMBRE')
  @Transform(recortar)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  respaldo?: string;

  /** Con `TEXTO`: el mismo valor para todas. */
  @ValidateIf((v: VariableCampanaDto) => v.tipo === 'TEXTO')
  @Transform(recortar)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  texto?: string;
}

/** La audiencia, con los mismos campos que `GET /campanas/audiencia`. */
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
  @Transform(recortar)
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  nombre!: string;

  @IsUUID()
  lineaId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(512)
  @Transform(recortar)
  plantilla!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(20)
  @Transform(recortar)
  idioma!: string;

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => VariableCampanaDto)
  variables!: VariableCampanaDto[];

  @IsDefined()
  @IsObject()
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
