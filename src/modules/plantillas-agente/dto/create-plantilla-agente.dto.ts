import { IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreatePlantillaAgenteDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  titulo!: string;

  @IsString()
  @IsOptional()
  @MaxLength(30)
  atajo?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  contenido!: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];
}
