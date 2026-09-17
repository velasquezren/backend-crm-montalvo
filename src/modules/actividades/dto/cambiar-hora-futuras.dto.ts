import { Matches } from 'class-validator';

/**
 * La hora a la que pasan esta ocurrencia y las siguientes.
 *
 * **Un solo campo, y ese es el punto.** La alternativa era añadir un `alcance`
 * al PATCH general, que admite ocho campos —entre ellos `clienteId` y
 * `agenteId`—: un despiste ahí cambiaría de paciente o reasignaría doce
 * actividades de golpe. Aquí eso no se puede ni escribir.
 *
 * Es una HORA, no una fecha: cada ocurrencia conserva su propio día. Y no es un
 * desplazamiento («+90 min»), que solo coincide con esto cuando todas están a
 * la misma hora.
 */
export class CambiarHoraFuturasDto {
  /** `HH:MM` en 24 h, interpretado en la zona de la clínica. */
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'La hora debe tener el formato HH:MM en 24 horas.',
  })
  hora!: string;
}
