import { Prisma } from '@prisma/client';

/**
 * Traduce la ficha de FileMaker (`Cliente.datosExtra`) a un objeto estable.
 *
 * `datosExtra` guarda el volcado tal cual salió del sistema antiguo, con sus
 * nombres: `Edad.a`, `CI.Lug.Pac`, `E_Civil`, `Profesion`… Enviar eso al
 * frontend acoplaría la interfaz a un origen de datos concreto: el día que se
 * migre FileMaker o cambie una columna, habría que tocar las vistas.
 *
 * Aquí se hace la traducción una sola vez y hacia dentro. El frontend consume
 * `paciente.edad`, no `datosExtra['Edad.a']`.
 */

/** Ficha clínica del paciente, ya con nombres propios del CRM. */
export interface DatosPaciente {
  /** Identificador en FileMaker. Se lee de la columna, no del JSON. */
  pac: string | null;
  edad: number | null;
  ocupacion: string | null;
  ci: string | null;
  lugarCi: string | null;
  sexo: string | null;
  estadoCivil: string | null;
  direccion: string | null;
  nacionalidad: string | null;
  telefonoFijo: string | null;
}

/** Devuelve el valor solo si es un texto con contenido real. */
function texto(valor: unknown): string | null {
  if (typeof valor === 'number') return String(valor);
  if (typeof valor !== 'string') return null;
  const limpio = valor.trim();
  return limpio === '' ? null : limpio;
}

/** Devuelve el valor solo si es un número utilizable (FileMaker exporta ambos). */
function numero(valor: unknown): number | null {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (typeof valor === 'string') {
    const n = Number(valor.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Construye la ficha del paciente. Devuelve `null` cuando no hay ni PAC ni
 * datos de FileMaker: un contacto captado por redes todavía no es paciente, y
 * la vista debe poder distinguir eso de un paciente con campos vacíos.
 */
export function extraerDatosPaciente(
  pac: string | null,
  datosExtra: Prisma.JsonValue | null,
): DatosPaciente | null {
  const esObjeto = typeof datosExtra === 'object' && datosExtra !== null && !Array.isArray(datosExtra);
  if (!pac && !esObjeto) return null;

  const d = (esObjeto ? datosExtra : {}) as Record<string, unknown>;

  return {
    pac,
    edad: numero(d['Edad.a']),
    ocupacion: texto(d['Profesion']),
    ci: texto(d['CI.Pac']),
    lugarCi: texto(d['CI.Lug.Pac']),
    sexo: texto(d['Sexo']),
    estadoCivil: texto(d['E_Civil']),
    direccion: texto(d['Direccion']),
    nacionalidad: texto(d['Nacionalidad']),
    telefonoFijo: texto(d['Telef.Dom']),
  };
}
