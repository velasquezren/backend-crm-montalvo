import { BadRequestException } from '@nestjs/common';
import * as XLSX from 'xlsx';

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

/** Convierte a texto limpio, o null si viene vacío. */
function aTexto(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  const texto = String(valor).trim();
  return texto === '' ? null : texto;
}

/** Convierte a fecha: acepta Date (cellDates), serial de Excel o texto ISO. */
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
 * Lee el .xlsx completo y devuelve las filas normalizadas.
 * No clasifica ni valida reglas de negocio: solo traduce el archivo a datos.
 */
export function leerExcel(buffer: Buffer): ResultadoLectura {
  let libro: XLSX.WorkBook;
  try {
    libro = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch {
    throw new BadRequestException('El archivo no es un Excel válido (.xlsx)');
  }

  const nombreHoja = libro.SheetNames[0];
  if (!nombreHoja) {
    throw new BadRequestException('El Excel no tiene ninguna hoja');
  }

  const hoja = libro.Sheets[nombreHoja];
  const crudas = XLSX.utils.sheet_to_json<FilaCruda>(hoja, { defval: null, raw: true });

  if (crudas.length === 0) {
    throw new BadRequestException('La hoja del Excel está vacía');
  }

  const cabecerasReales = Object.keys(crudas[0]);
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
