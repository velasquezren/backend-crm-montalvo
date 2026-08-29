/**
 * Armado del informe de comisiones en PDF: la parte que decide QUÉ se imprime.
 *
 * Está separada del dibujo (`exportacion-pdf.service.ts`) a propósito: las
 * reglas —qué columnas entran, qué fila va en qué bloque, cuánto suma cada
 * pie— se pueden probar sin generar un PDF ni montar Nest. Lo que queda al otro
 * lado es solo geometría.
 */

/** Una fila del consolidado, en lo que este informe necesita de ella. */
export interface FilaInforme {
  nombre: string;
  codigo: string;
  area: string;
  montoVendido: number;
  baseCalculo: number;
  comisionA: number;
  comisionTipoARA: number;
  comisionB: number;
  comisionC: number;
  totalBonos: number;
  totalUsd: number;
  totalBob: number;
  sueldoBase: number;
  totalGanado: number;
}

/** Los totales de un bloque. Mismas claves que una fila, sin los datos de identidad. */
export type TotalesBloque = Omit<FilaInforme, 'nombre' | 'codigo' | 'area'>;

export interface InformeComisiones {
  /** Quien vende y comisiona. */
  ventas: FilaInforme[];
  /** Quien cobra bono sin vender. Vacío si no hay nadie del área. */
  marketing: FilaInforme[];
  totalVentas: TotalesBloque;
  totalMarketing: TotalesBloque;
  /** Los dos bloques juntos: lo que sale de caja. */
  totalGeneral: TotalesBloque;
}

const AREA_MARKETING = 'PUBLICIDAD';

const CLAVES: ReadonlyArray<keyof TotalesBloque> = [
  'montoVendido',
  'baseCalculo',
  'comisionA',
  'comisionTipoARA',
  'comisionB',
  'comisionC',
  'totalBonos',
  'totalUsd',
  'totalBob',
  'sueldoBase',
  'totalGanado',
];

function redondear(valor: number): number {
  return Math.round((valor + Number.EPSILON) * 100) / 100;
}

export function sumar(filas: readonly FilaInforme[]): TotalesBloque {
  const total = Object.fromEntries(CLAVES.map(c => [c, 0])) as TotalesBloque;
  for (const fila of filas) {
    for (const clave of CLAVES) total[clave] += fila[clave];
  }
  for (const clave of CLAVES) total[clave] = redondear(total[clave]);
  return total;
}

/**
 * Separa la planilla en sus dos bloques y calcula los tres pies.
 *
 * **Cada pie suma las filas que tiene encima**, y el general suma los dos
 * bloques. No se reutiliza el total que ya trae el consolidado: ese es del
 * periodo entero y con la hoja partida serviría para el general y para ninguno
 * de los dos subtotales — un pie que no es la suma de sus filas es peor que no
 * tener pie.
 */
export function armarInforme(filas: readonly FilaInforme[]): InformeComisiones {
  const ventas = filas.filter(f => f.area !== AREA_MARKETING);
  const marketing = filas.filter(f => f.area === AREA_MARKETING);

  return {
    ventas,
    marketing,
    totalVentas: sumar(ventas),
    totalMarketing: sumar(marketing),
    totalGeneral: sumar(filas),
  };
}

/**
 * Número con formato boliviano: punto para miles, coma para decimales.
 *
 * A mano y no con `Intl.NumberFormat`: el formato de este documento no puede
 * depender de qué datos de localización tenga instalados el servidor. Si un día
 * el proceso arranca sin ICU completo, `Intl` cae a `en-US` en silencio y la
 * planilla que se firma sale con los separadores cambiados —1,396.62 en vez de
 * 1.396,62—, que en un documento de pagos se lee como otra cifra.
 */
export function formatearNumero(valor: number): string {
  const negativo = valor < 0;
  const [entero, decimales] = Math.abs(redondear(valor)).toFixed(2).split('.');
  const conMiles = entero.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negativo ? '-' : ''}${conMiles},${decimales}`;
}

export const usd = (valor: number): string => `$ ${formatearNumero(valor)}`;
export const bob = (valor: number): string => `Bs ${formatearNumero(valor)}`;

/**
 * Quién firma el informe.
 *
 * `elaboradoPor` y `revisadoPor` salen del usuario que genera el documento —es
 * quien lo produjo y quien responde por él— y `autorizadoPor` es fijo: la
 * autorización es del director de la clínica, no de quien imprime.
 */
export interface Firmantes {
  elaboradoPor: string;
  revisadoPor: string;
  autorizadoPor: string;
}

/**
 * Quién autoriza la planilla. Está acá y no incrustado en el dibujo para que se
 * encuentre buscando el nombre: el día que cambie la dirección de la clínica,
 * esta línea es lo único que hay que tocar.
 */
export const AUTORIZA_PLANILLA = 'Dr. Juan Carlos Montalvo';

export function firmantesPara(usuario: { nombre: string } | null): Firmantes {
  /* Sin usuario no se inventa un nombre: se deja la línea en blanco para que se
     firme a mano. Poner "Sistema" o el nombre de otra persona en un documento
     que se archiva sería atribuir una revisión que nadie hizo. */
  const nombre = usuario?.nombre?.trim() || '';
  return {
    elaboradoPor: nombre,
    revisadoPor: nombre,
    autorizadoPor: AUTORIZA_PLANILLA,
  };
}
