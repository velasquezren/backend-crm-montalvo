import { BadRequestException } from '@nestjs/common';
import { CellValue, Workbook } from 'exceljs';

import { FilaExcel, normalizar } from './clasificador';

/**
 * Lectura del export mensual de FileMaker (.xlsx, una sola hoja, 20 columnas).
 *
 * Las columnas se resuelven por NOMBRE de cabecera, no por posición: FileMaker
 * puede reordenarlas o renombrar levemente entre versiones y eso no debería
 * romper la importación. Cada campo acepta varios alias.
 */

/** Alias aceptados por columna (se comparan normalizados: sin acentos, mayúsculas). */
const ALIAS_COLUMNAS: Record<keyof FilaExcel, readonly string[]> = {
  fecha: ['FECHA'],
  modulo: ['MODULO'],
  codOrigen: ['COD_ORIGEN', 'CODORIGEN', 'COD ORIGEN'],
  estadoPlan: ['ESTADO'],
  codItem: ['COD_ITEM', 'CODITEM', 'COD ITEM'],
  detalle: ['DETALLE'],
  pac: ['PAC'],
  paciente: ['PACIENTE'],
  medicoPk: ['MEDICO_PK', 'MEDICOPK', 'MEDICO PK'],
  medico: ['MEDICO'],
  area: ['AREA', 'AREA CLINICA', 'AREA_CLINICA', 'ESPECIALIDAD'],
  vendedoraPk: ['VENDEDORA_PK', 'VENDEDORAPK', 'VENDEDORA PK'],
  vendedoraNombre: ['VENDEDORA'],
  captacion: ['CAPTACION'],
  seguro: ['SEGURO'],
  promocion: ['PROMOCION'],
  precio: ['PRECIO'],
  anticipoPlan: ['ANTICIPO_PLAN', 'ANTICIPOPLAN', 'ANTICIPO PLAN', 'ANTICIPO'],
  tc: ['TC'],
  obs: ['OBS', 'OBSERVACIONES'],
  /* La cabecera real del export dice `clasifiacion`, sin la segunda c. Se acepta
     tal cual y también bien escrita, por si FileMaker lo corrige algún día. */
  clasificacionServicio: ['CLASIFIACION', 'CLASIFICACION SERVICIO', 'CLASIF SERVICIO'],
  clasificacionPlan: [
    'CONFIG.PLANES.CLAS::CLASIFICACION',
    'CLASIFICACION',
    'CONFIG PLANES CLAS CLASIFICACION',
  ],
};

/** Columnas sin las cuales el archivo no sirve. */
const COLUMNAS_OBLIGATORIAS: ReadonlyArray<keyof FilaExcel> = ['detalle', 'precio'];

type FilaCruda = Record<string, unknown>;

/**
 * El valor de una celda tal como lo usaba la lectura anterior (SheetJS con
 * `raw: true`): de una fórmula, su resultado guardado; de un texto con formato
 * o un enlace, el texto; un error de Excel (`#N/A`), vacío.
 */
function valorDeCelda(valor: CellValue): unknown {
  if (valor === null || valor === undefined) return null;
  if (valor instanceof Date) return aHoraLocal(valor);
  if (typeof valor !== 'object') return valor;
  if ('result' in valor) return valor.result === undefined ? null : valorDeCelda(valor.result as CellValue);
  if ('richText' in valor) return valor.richText.map(trozo => trozo.text).join('');
  if ('text' in valor) return valor.text;
  if ('error' in valor) return null;
  return null;
}

/** Convierte a número tolerando strings con separadores de miles o coma decimal. */
function aNumero(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (typeof valor === 'string') {
    // "3.532,87" (europeo) y "3,532.87" (anglosajón) llegan según cómo exporte FileMaker.
    const limpio = valor.trim().replace(/\s/g, '');
    const normalizado =
      limpio.includes(',') && limpio.lastIndexOf(',') > limpio.lastIndexOf('.')
        ? limpio.replace(/\./g, '').replace(',', '.')
        : limpio.replace(/,/g, '');
    const n = Number(normalizado);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Excel no guarda zona: «01/12/2025» es una fecha de calendario. `exceljs` la
 * entrega como medianoche UTC; SheetJS, como medianoche en la zona del proceso,
 * y así están guardadas todas las `VentaImportada.fecha` (el VPS corre en
 * America/New_York). Medianoche UTC, vista desde La Paz, es el día ANTERIOR a
 * las 20:00: cada venta del día 1 caería en el mes previo. Se conserva la
 * convención de siempre: la misma fecha y hora de pared, en la zona local.
 */
function aHoraLocal(utc: Date): Date {
  return new Date(
    utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate(),
    utc.getUTCHours(), utc.getUTCMinutes(), utc.getUTCSeconds(), utc.getUTCMilliseconds(),
  );
}

/** Convierte a texto limpio, o null si viene vacío. */
function aTexto(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  const texto = String(valor).trim();
  return texto === '' ? null : texto;
}

/** Convierte a fecha: acepta Date (celda con formato de fecha), serial de Excel o texto ISO. */
function aFecha(valor: unknown): Date | null {
  if (valor === null || valor === undefined || valor === '') return null;
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor;
  if (typeof valor === 'number') {
    // Serial de Excel: días desde 1899-12-30.
    const ms = Math.round((valor - 25569) * 86400 * 1000);
    const fecha = new Date(ms);
    return Number.isNaN(fecha.getTime()) ? null : fecha;
  }
  const fecha = new Date(String(valor));
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

/**
 * Mapea las cabeceras reales del archivo a los campos de `FilaExcel`.
 * Devuelve también las columnas obligatorias que no se encontraron.
 */
function mapearCabeceras(cabecerasReales: readonly string[]): {
  mapa: Partial<Record<keyof FilaExcel, string>>;
  faltantes: string[];
} {
  const mapa: Partial<Record<keyof FilaExcel, string>> = {};

  for (const [campo, alias] of Object.entries(ALIAS_COLUMNAS) as Array<
    [keyof FilaExcel, readonly string[]]
  >) {
    const encontrada = cabecerasReales.find(cabecera => alias.includes(normalizar(cabecera)));
    if (encontrada) mapa[campo] = encontrada;
  }

  const faltantes = COLUMNAS_OBLIGATORIAS.filter(campo => !mapa[campo]).map(String);
  return { mapa, faltantes };
}

export interface ResultadoLectura {
  filas: FilaExcel[];
  /** Filas descartadas por venir totalmente vacías (colas del export). */
  filasVacias: number;
  /** Columnas declaradas en el spec que este archivo no traía. */
  columnasAusentes: string[];
}

/**
 * Las filas de la primera hoja como objetos `{ cabecera: valor }`, igual que
 * las daba `sheet_to_json` de SheetJS: la primera fila son las cabeceras, una
 * fila sin ningún valor no cuenta, y una cabecera repetida no pisa a la primera.
 */
function filasDeLaHoja(libro: Workbook): { cabeceras: string[]; crudas: FilaCruda[] } {
  const hoja = libro.worksheets[0];
  if (!hoja) throw new BadRequestException('El Excel no tiene ninguna hoja');

  const cabeceras: string[] = [];
  const columnas: Array<{ columna: number; cabecera: string }> = [];
  hoja.getRow(1).eachCell({ includeEmpty: false }, (celda, columna) => {
    const cabecera = aTexto(valorDeCelda(celda.value));
    if (!cabecera || cabeceras.includes(cabecera)) return;
    cabeceras.push(cabecera);
    columnas.push({ columna, cabecera });
  });

  const crudas: FilaCruda[] = [];
  for (let numero = 2; numero <= hoja.rowCount; numero++) {
    const fila = hoja.getRow(numero);
    const cruda: FilaCruda = {};
    let conValor = false;
    for (const { columna, cabecera } of columnas) {
      const valor = valorDeCelda(fila.getCell(columna).value);
      cruda[cabecera] = valor === '' ? null : valor;
      if (cruda[cabecera] !== null) conValor = true;
    }
    if (conValor) crudas.push(cruda);
  }
  return { cabeceras, crudas };
}

/**
 * Lee el .xlsx completo y devuelve las filas normalizadas.
 * No clasifica ni valida reglas de negocio: solo traduce el archivo a datos.
 *
 * Con `exceljs` y no SheetJS (`xlsx`): el paquete de npm de SheetJS quedó
 * congelado en 0.18.5, con dos vulnerabilidades publicadas (contaminación de
 * prototipo y ReDoS) que justo se disparan leyendo un archivo subido. Las
 * versiones corregidas solo salen de su CDN, donde `npm audit` no las ve.
 * `exceljs` ya era la librería de la exportación: queda una sola.
 */
export async function leerExcel(buffer: Buffer): Promise<ResultadoLectura> {
  const libro = new Workbook();
  try {
    await libro.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new BadRequestException('El archivo no es un Excel válido (.xlsx)');
  }

  const { cabeceras: cabecerasReales, crudas } = filasDeLaHoja(libro);

  if (crudas.length === 0) {
    throw new BadRequestException('La hoja del Excel está vacía');
  }

  const { mapa, faltantes } = mapearCabeceras(cabecerasReales);

  if (faltantes.length > 0) {
    throw new BadRequestException(
      `Al Excel le faltan columnas obligatorias: ${faltantes.join(', ')}. ` +
        `Cabeceras encontradas: ${cabecerasReales.join(', ')}`,
    );
  }

  const columnasAusentes = (Object.keys(ALIAS_COLUMNAS) as Array<keyof FilaExcel>)
    .filter(campo => !mapa[campo])
    .map(String);

  const leer = (cruda: FilaCruda, campo: keyof FilaExcel): unknown => {
    const columna = mapa[campo];
    return columna ? cruda[columna] : null;
  };

  const filas: FilaExcel[] = [];
  let filasVacias = 0;

  for (const cruda of crudas) {
    const detalle = aTexto(leer(cruda, 'detalle'));
    const precio = aNumero(leer(cruda, 'precio'));

    // Los exports suelen traer filas de cola completamente vacías.
    if (!detalle && precio === null) {
      filasVacias++;
      continue;
    }

    filas.push({
      fecha: aFecha(leer(cruda, 'fecha')),
      modulo: aTexto(leer(cruda, 'modulo')),
      codOrigen: aTexto(leer(cruda, 'codOrigen')),
      estadoPlan: aTexto(leer(cruda, 'estadoPlan')),
      codItem: aTexto(leer(cruda, 'codItem')),
      detalle: detalle ?? '(sin detalle)',
      pac: aTexto(leer(cruda, 'pac')),
      paciente: aTexto(leer(cruda, 'paciente')),
      medicoPk: aTexto(leer(cruda, 'medicoPk')),
      medico: aTexto(leer(cruda, 'medico')),
      area: aTexto(leer(cruda, 'area')),
      vendedoraPk: aTexto(leer(cruda, 'vendedoraPk')),
      vendedoraNombre: aTexto(leer(cruda, 'vendedoraNombre')),
      captacion: aTexto(leer(cruda, 'captacion')),
      seguro: aTexto(leer(cruda, 'seguro')),
      promocion: aTexto(leer(cruda, 'promocion')),
      precio: precio ?? 0,
      anticipoPlan: aNumero(leer(cruda, 'anticipoPlan')),
      tc: aNumero(leer(cruda, 'tc')),
      obs: aTexto(leer(cruda, 'obs')),
      clasificacionServicio: aTexto(leer(cruda, 'clasificacionServicio')),
      clasificacionPlan: aTexto(leer(cruda, 'clasificacionPlan')),
    });
  }

  if (filas.length === 0) {
    throw new BadRequestException('El Excel no tiene ninguna fila con datos');
  }

  return { filas, filasVacias, columnasAusentes };
}

/**
 * Deduce el periodo (año/mes) y el tipo de cambio del archivo.
 * El mes es el de la fecha más frecuente; el TC, el primero no nulo (regla 10).
 */
export function deducirPeriodo(filas: readonly FilaExcel[]): {
  anio: number;
  mes: number;
  tipoCambio: number;
} {
  const conteo = new Map<string, number>();
  for (const fila of filas) {
    if (!fila.fecha) continue;
    const clave = `${fila.fecha.getFullYear()}-${fila.fecha.getMonth() + 1}`;
    conteo.set(clave, (conteo.get(clave) ?? 0) + 1);
  }

  let claveDominante: string | null = null;
  let maximo = 0;
  for (const [clave, veces] of conteo) {
    if (veces > maximo) {
      maximo = veces;
      claveDominante = clave;
    }
  }

  const ahora = new Date();
  const [anio, mes] = claveDominante
    ? claveDominante.split('-').map(Number)
    : [ahora.getFullYear(), ahora.getMonth() + 1];

  const tipoCambio = filas.find(f => f.tc !== null && f.tc > 0)?.tc ?? 6.96;

  return { anio, mes, tipoCambio };
}
