/* Los decoradores de class-validator leen metadatos por reflexión. En la app lo
   carga Nest al arrancar; en una prueba aislada hay que pedirlo a mano o los
   decoradores no existen y el DTO valida cualquier cosa. */
import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { ActualizarVendedoraDto } from './configuracion.dto';

/**
 * Este DTO recibe el sueldo, así que un fallo aquí no da error: da una planilla
 * con la columna "Sueldo" en Bs 0,00 y a nadie le cuadra el pago.
 *
 * Ya pasó. `sueldoBase` es un `Decimal` de Prisma y se serializa a JSON como
 * TEXTO, así que el frontend devolvía `"2750"` al guardar. Con
 * `enableImplicitConversion: false` ese texto no se convertía solo, `@IsNumber()`
 * lo rechazaba y el PATCH respondía 400 — pero la interfaz seguía mostrando el
 * sueldo tecleado, porque Angular solo reescribe el input cuando el valor
 * enlazado cambia, y en la base seguía siendo 0. Se descubrió recalculando la
 * planilla y viendo que nadie tenía sueldo.
 *
 * Las opciones replican EXACTAMENTE las del ValidationPipe global de `main.ts`:
 * probar con otras no probaría nada.
 */
const OPCIONES_DEL_PIPE = { enableImplicitConversion: false } as const;

function validar(cuerpo: Record<string, unknown>) {
  const dto = plainToInstance(ActualizarVendedoraDto, cuerpo, OPCIONES_DEL_PIPE);
  return { dto, errores: validateSync(dto as object, { whitelist: true }) };
}

describe('ActualizarVendedoraDto · sueldoBase', () => {
  /* La prueba que habría atrapado el bug. */
  it('acepta el sueldo como TEXTO, que es como lo devuelve un Decimal', () => {
    const { dto, errores } = validar({ sueldoBase: '2750' });

    expect(errores).toHaveLength(0);
    expect(dto.sueldoBase).toBe(2750);
    expect(typeof dto.sueldoBase).toBe('number');
  });

  it('acepta decimales, que es como viene un sueldo real', () => {
    const { dto, errores } = validar({ sueldoBase: '4236.81' });

    expect(errores).toHaveLength(0);
    expect(dto.sueldoBase).toBe(4236.81);
  });

  it('sigue aceptando un número', () => {
    const { dto, errores } = validar({ sueldoBase: 2750 });

    expect(errores).toHaveLength(0);
    expect(dto.sueldoBase).toBe(2750);
  });

  /* Que se acepte texto no puede significar que se acepte cualquier cosa: un
     sueldo mal escrito debe rebotar, no colarse como NaN. */
  it('rechaza un texto que no es un número', () => {
    const { errores } = validar({ sueldoBase: 'dos mil' });

    expect(errores.length).toBeGreaterThan(0);
    expect(errores[0].property).toBe('sueldoBase');
  });

  it('rechaza un sueldo negativo', () => {
    const { errores } = validar({ sueldoBase: '-100' });

    expect(errores.length).toBeGreaterThan(0);
    expect(errores[0].property).toBe('sueldoBase');
  });

  it('deja pasar un cuerpo que no trae sueldo (el campo es opcional)', () => {
    const { errores } = validar({ configurada: true });

    expect(errores).toHaveLength(0);
  });
});
