import { Workbook } from 'exceljs';

/**
 * Un .xlsx real armado en memoria para las suites de la planilla: la primera
 * fila son las claves del primer objeto, como el export de FileMaker. Con la
 * misma librería que lo lee (`exceljs`); SheetJS salió del proyecto por sus
 * vulnerabilidades (ver `leerExcel`). Los `*.de-prueba.ts` quedan fuera del build.
 */
export async function excelDePrueba(
  filas: ReadonlyArray<Record<string, string | number | Date | null>>,
  hoja = 'Ventas',
): Promise<Buffer> {
  const libro = new Workbook();
  const pagina = libro.addWorksheet(hoja);
  const cabeceras = Object.keys(filas[0] ?? {});
  pagina.addRow(cabeceras);
  for (const fila of filas) pagina.addRow(cabeceras.map(c => fila[c] ?? null));
  return Buffer.from(await libro.xlsx.writeBuffer());
}
