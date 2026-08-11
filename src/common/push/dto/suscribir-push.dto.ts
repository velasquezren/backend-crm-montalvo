import { Type } from 'class-transformer';
import { IsNotEmpty, IsObject, IsString, IsUrl, ValidateNested } from 'class-validator';

/** Claves de cifrado que el navegador genera para su suscripción. */
export class ClavesPushDto {
  @IsString()
  @IsNotEmpty()
  p256dh!: string;

  @IsString()
  @IsNotEmpty()
  auth!: string;
}

/**
 * Suscripción Web Push tal como la entrega `PushManager.subscribe()`.
 *
 * **Cada campo lleva su decorador y eso no es decoración.** El `ValidationPipe`
 * global corre con `whitelist: true`, que descarta toda propiedad sin decorador:
 * un DTO sin ellos no llega vacío al service *a veces*, llega vacío **siempre**.
 * Así estaba, y `guardarSuscripcion` devolvía `{ ok: false }` sin error ni log —
 * las notificaciones nunca se guardaron y nada lo delataba.
 *
 * `ValidateNested` + `Type` son imprescindibles en `keys`: sin ellos el objeto
 * anidado no se valida y el whitelist lo vacía igual.
 */
export class SuscribirPushDto {
  /** URL del servicio de push del navegador (FCM, Mozilla, WNS…). */
  @IsUrl({ require_tld: false, protocols: ['https'] })
  endpoint!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => ClavesPushDto)
  keys!: ClavesPushDto;
}
