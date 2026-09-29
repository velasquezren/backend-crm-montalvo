import { Prisma } from './prisma-client';
import { campoDeIndice, candidatosDeChoqueUnico, tablaDelChoque } from './choque-unico';

/**
 * Sin base: lo que se fija aquí es la FORMA del error, que es justo lo que
 * cambió al pasar a Prisma 7 y dejó dos traducciones muertas.
 *
 * `driverAdapter` es un volcado literal de un P2002 real contra el `crm_test`
 * local, no una forma inventada: inventarla es exactamente cómo se pasó por
 * alto que `meta.target` había desaparecido.
 */

const p2002 = (meta: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '7', meta });

const driverAdapter = p2002({
  driverAdapterError: {
    name: 'DriverAdapterError',
    cause: {
      originalCode: '23505',
      originalMessage: 'duplicate key value violates unique constraint "Cliente_telefono_key"',
      kind: 'UniqueConstraintViolation',
      constraint: { index: 'Cliente_telefono_key' },
      table: 'Cliente',
    },
  },
  modelName: 'Cliente',
});

describe('candidatosDeChoqueUnico', () => {
  /* La forma que de verdad llega hoy. Mientras esto pase, un teléfono repetido
     se explica; en cuanto deje de pasar, vuelve el 500. */
  it('encuentra el índice dentro del error del driver, donde NO hay meta.target', () => {
    expect(driverAdapter.meta?.['target']).toBeUndefined();
    expect(candidatosDeChoqueUnico(driverAdapter)).toContain('Cliente_telefono_key');
  });

  it('sigue leyendo el meta.target clásico, por si se quita el adaptador', () => {
    expect(candidatosDeChoqueUnico(p2002({ target: ['telefono'] }))).toEqual(['telefono']);
    expect(candidatosDeChoqueUnico(p2002({ target: 'pac' }))).toEqual(['pac']);
  });

  it('un error sin meta no revienta ni inventa un campo', () => {
    expect(candidatosDeChoqueUnico(p2002({}))).toEqual([]);
  });
});

describe('campoDeIndice', () => {
  it('saca la columna del nombre del índice', () => {
    expect(campoDeIndice('Cliente_telefono_key', 'Cliente')).toBe('telefono');
    expect(campoDeIndice('Cliente_pac_key', 'Cliente')).toBe('pac');
  });

  it('deja en paz lo que ya es un nombre de columna', () => {
    expect(campoDeIndice('telefono', 'Cliente')).toBe('telefono');
  });

  /* Sin la tabla, recortar por el primer «_» convertiría `Cliente_ci_key` en
     `ci_key` o, peor, el índice de otra tabla en un campo que sí existe en
     ésta: mejor no reconocerlo que señalar la casilla equivocada. */
  it('sin saber la tabla no adivina el prefijo', () => {
    expect(campoDeIndice('Cliente_telefono_key')).toBe('Cliente_telefono');
  });

  it('no recorta el prefijo de una tabla distinta', () => {
    expect(campoDeIndice('Mensaje_clientMessageId_key', 'Cliente')).toBe('Mensaje_clientMessageId');
  });
});

describe('tablaDelChoque', () => {
  it('la saca del error del driver', () => {
    expect(tablaDelChoque(driverAdapter)).toBe('Cliente');
  });

  it('undefined cuando el error no la trae', () => {
    expect(tablaDelChoque(p2002({ target: ['telefono'] }))).toBeUndefined();
  });
});
