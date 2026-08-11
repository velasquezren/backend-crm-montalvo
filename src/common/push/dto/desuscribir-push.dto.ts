import { IsUrl } from 'class-validator';

/** Baja de una suscripción. Ver el comentario del endpoint: solo borra las propias. */
export class DesuscribirPushDto {
  @IsUrl({ require_tld: false, protocols: ['https'] })
  endpoint!: string;
}
