/* Ver la cabecera de `actualizar-vendedora.dto.spec.ts`: los decoradores leen
   metadatos por reflexión y en una prueba aislada hay que pedirlo a mano. */
import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { CorregirOrigenDto } from './corregir-origen.dto';

/**
 * Este DTO tiene una particularidad que hay que dejar fijada: `null` es un
 * valor con significado —«esta venta no vino de ninguna campaña»— y el campo
 * ausente NO lo es.
 *
 * Con `@IsOptional()`, que es el reflejo natural al escribir un DTO de PATCH,
 * los dos casos se confunden: un `PATCH {}` por un bug en el cliente entraría
 * como válido y, según cómo lo lea el service, borraría la atribución sin que
 * nadie lo pidiera. Por eso `@ValidateIf`.
 *
 * Las opciones replican las del ValidationPipe global de `main.ts`.
 */
const OPCIONES_DEL_PIPE = { enableImplicitConversion: false } as const;

function validar(cuerpo: Record<string, unknown>) {
  const dto = plainToInstance(CorregirOrigenDto, cuerpo, OPCIONES_DEL_PIPE);
  return { dto, errores: validateSync(dto as object, { whitelist: true }) };
}

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('CorregirOrigenDto', () => {
  it('acepta un uuid', () => {
    const { dto, errores } = validar({ leadId: UUID });

    expect(errores).toHaveLength(0);
    expect(dto.leadId).toBe(UUID);
  });

  it('acepta null — así se quita una atribución equivocada', () => {
    const { dto, errores } = validar({ leadId: null });

    expect(errores).toHaveLength(0);
    expect(dto.leadId).toBeNull();
  });

  it('RECHAZA el cuerpo vacío: ausente no es lo mismo que null', () => {
    expect(validar({}).errores.length).toBeGreaterThan(0);
  });

  it('rechaza cualquier cosa que no sea un uuid', () => {
    expect(validar({ leadId: 'no-es-un-uuid' }).errores.length).toBeGreaterThan(0);
    expect(validar({ leadId: 42 }).errores.length).toBeGreaterThan(0);
    expect(validar({ leadId: '' }).errores.length).toBeGreaterThan(0);
  });

  it('el whitelist del pipe descarta lo que venga de más', () => {
    /* Es la barrera que impide que un `PATCH /ventas/:id/origen` con `monto`
       en el cuerpo llegue a tocar nada: el endpoint corrige el origen y punto. */
    const { dto, errores } = validar({ leadId: null, monto: 999999, estado: 'GANADA' });

    expect(errores).toHaveLength(0);
    expect(dto).not.toHaveProperty('monto');
    expect(dto).not.toHaveProperty('estado');
  });
});
