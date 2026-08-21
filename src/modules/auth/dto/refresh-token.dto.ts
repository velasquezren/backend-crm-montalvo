import { IsOptional, IsString } from 'class-validator';

/** DTO opcional para refresco de token si no viaja en cookie HttpOnly. */
export class RefreshTokenDto {
  @IsOptional()
  @IsString()
  refresh_token?: string;
}
