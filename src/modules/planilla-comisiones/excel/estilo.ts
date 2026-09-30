import { Workbook, Worksheet } from 'exceljs';

/*
 * El estilo del Excel mensual: colores, formatos numéricos y las piezas con
 * las que se arma cada hoja (título, secciones, pares etiqueta/valor, notas
 * de cabecera, tablas con cabecera y la fila de totales). Una sola versión
 * para todas las hojas, las de `hojas-del-consolidado.ts` y las que siguen en
 * `ExportacionComisionesService`.
 */

/** Colores de la identidad del CRM, en el formato ARGB que pide ExcelJS. */
export const COLOR = {
  cabecera: 'FF1E293B',
  cabeceraTexto: 'FFFFFFFF',
  seccion: 'FFF1F5F9',
  totales: 'FFE2E8F0',
  borde: 'FFCBD5E1',
} as const;

/**
 * Formatos numéricos.
 *
 * `usd`/`bob` son moneda; `pct` espera el número YA en puntos porcentuales
 * (ej. `4.5` para "4,5%") — es un formato de texto, no el `0.0%` nativo de
 * Excel, que sí divide entre 100 solo.
 *
 * **Ojo: no todo lo que se llama "pct" está en la misma unidad.**
 * `pctMonto` (`AnaliticaComisionesService.porcentaje()`) parte de una
 * fracción y la multiplica por 100 a propósito. Pero `pctEmpresa`/`pctPropio`
 * de `NivelCirugia`/`NivelTipoARA`/`TarifaPlan`/`TarifaServicio` NACEN en
 * puntos porcentuales — así los siembra `configuracion-por-defecto.ts`
 * (`pctEmpresa: 4.5`) y así los usa el propio motor de cálculo
 * (`comisionUsd = base * porcentaje / 100`, sin dividir entre 100 antes).
 * Multiplicarlos por 100 de nuevo —lo que hacía esta hoja hasta que salió
 * "450.0%" en vez de "4.5%"— infla el número cien veces. Antes de tocar un
 * `%`, confirmar la unidad real contra el sembrado o el motor, nunca contra
 * el nombre del campo.
 */
export const FORMATO = {
  bob: '"Bs" #,##0.00',
  usd: '"$" #,##0.00',
  pct: '0.0"%"',
  entero: '#,##0',
} as const;

export interface ColumnaInforme {
  titulo: string;
  clave: string;
  ancho: number;
  formato?: string;
}

/**
 * Aplica un formato numérico a un rango puntual de celdas, nunca a la
 * columna entera: en esta hoja la misma columna sirve al bloque de resumen,
 * al desglose y a las ventas, cada uno con su propio tipo de dato — un
 * `getColumn().numFmt` se filtraría hacia arriba o hacia abajo del bloque
 * que lo necesita. Es el mismo bug de fondo que ya rompió el % de Tipo A
 * (RA) en la hoja "Tipo A (RA)" (ver la cabecera de este archivo).
 */
export function formatoRangoColumna(
  hoja: Worksheet,
  filaDesde: number,
  filaHasta: number,
  columna: number,
  formato: string,
): void {
  for (let r = filaDesde; r <= filaHasta; r++) {
    const celda = hoja.getCell(r, columna);
    celda.numFmt = formato;
    celda.alignment = { horizontal: 'right' };
  }
}

/* ── Utilidades de formato ──────────────────────────────────────────── */

/** Hoja tabular con cabecera fija, autofiltro y formatos por columna. */
export function hojaConCabecera(libro: Workbook, nombre: string, columnas: ColumnaInforme[]): Worksheet {
  const hoja = libro.addWorksheet(nombre, {
    views: [{ state: 'frozen', ySplit: 1 }], // la cabecera acompaña al scroll
  });

  hoja.columns = columnas.map(c => ({ header: c.titulo, key: c.clave, width: c.ancho }));

  const cabecera = hoja.getRow(1);
  cabecera.height = 22;
  cabecera.font = { bold: true, color: { argb: COLOR.cabeceraTexto }, size: 11 };
  cabecera.alignment = { vertical: 'middle', horizontal: 'left', wrapText: false };
  cabecera.eachCell(celda => {
    celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.cabecera } };
    celda.border = { bottom: { style: 'thin', color: { argb: COLOR.borde } } };
  });

  columnas.forEach((c, i) => {
    if (!c.formato) return;
    const columna = hoja.getColumn(i + 1);
    columna.numFmt = c.formato;
    columna.alignment = { horizontal: 'right' };
  });

  // Filtrar y ordenar desde el propio Excel, que es como se revisa el informe.
  hoja.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columnas.length } };
  return hoja;
}

/**
 * Nota de celda (▲ roja, aparece al pasar el mouse) sobre la cabecera de
 * una columna — para explicar una fórmula sin gastar una fila entera ni
 * romper el autofiltro de la fila 1, que solo funciona sobre una sola fila
 * de cabecera.
 */
export function nota(hoja: Worksheet, clave: string, texto: string): void {
  const columna = hoja.getColumn(clave);
  hoja.getRow(1).getCell(columna.number).note = texto;
}

export function titulo(hoja: Worksheet, texto: string, columnas: number): void {
  const fila = hoja.addRow([texto]);
  fila.height = 28;
  fila.font = { bold: true, size: 15 };
  hoja.mergeCells(fila.number, 1, fila.number, columnas);
}

export function seccion(hoja: Worksheet, texto: string, columnas: number): void {
  const fila = hoja.addRow([texto]);
  fila.font = { bold: true, size: 11 };
  fila.eachCell(celda => {
    celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.seccion } };
  });
  hoja.mergeCells(fila.number, 1, fila.number, columnas);
}

export function dato(hoja: Worksheet, etiqueta: string, valor: string | number, formato?: string) {
  const fila = hoja.addRow([etiqueta, valor]);
  if (formato) {
    fila.getCell(2).numFmt = formato;
    fila.getCell(2).alignment = { horizontal: 'right' };
  }
  return fila;
}

export function marcarTotales(fila: ReturnType<Worksheet['addRow']>, columnas: number): void {
  fila.font = { bold: true };
  for (let i = 1; i <= columnas; i++) {
    const celda = fila.getCell(i);
    celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.totales } };
    celda.border = { top: { style: 'medium', color: { argb: COLOR.cabecera } } };
  }
}
