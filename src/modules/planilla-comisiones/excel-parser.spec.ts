import { BadRequestException } from '@nestjs/common';
import { Workbook } from 'exceljs';

import { deducirPeriodo, leerExcel } from './excel-parser';
import { excelDePrueba } from './excel.de-prueba';

/*
 * La lectura pasó de SheetJS a `exceljs` (SheetJS en npm quedó congelado con
 * dos vulnerabilidades publicadas). Antes de cambiarla se comparó, campo por
 * campo, el export real de diciembre de 2025 leído por las dos: 357 filas y 22
 * campos idénticos con TZ=America/New_York (la del VPS) y TZ=UTC. Estas pruebas
 * fijan lo que esa comparación demostró, con datos ficticios.
 */

const BASE = { FECHA: null, MODULO: 'CONSULTA', DETALLE: 'Consulta general', PRECIO: 200, TC: 6.97, VENDEDORA_PK: 'V1', VENDEDORA: 'Vendedora' };

/** Un libro con celdas que `excelDePrueba` no sabe escribir: fórmulas, texto con formato, errores. */
async function libroConCeldasRaras(): Promise<Buffer> {
  const libro = new Workbook();
  const hoja = libro.addWorksheet('Ventas');
  hoja.addRow(['FECHA', 'DETALLE', 'PRECIO', 'TC', 'OBS', 'DETALLE']);
  hoja.addRow([
    new Date(Date.UTC(2025, 11, 1)),
    { richText: [{ text: 'Consulta ' }, { font: { bold: true }, text: 'cardiología' }] },
    { formula: '100+150', result: 250 },
    6.97,
    { error: '#N/A' },
    'repetida: no pisa a la primera',
  ]);
  hoja.addRow([]);
  hoja.addRow([null, { text: 'Ecografía', hyperlink: 'https://ejemplo.invalido' }, '3.532,87', null, null, null]);
  return Buffer.from(await libro.xlsx.writeBuffer());
}

describe('leerExcel (exceljs)', () => {
  it('resuelve columnas por nombre y alias, en cualquier orden', async () => {
    const { filas, columnasAusentes } = await leerExcel(await excelDePrueba([
      { PRECIO: 180, 'COD ORIGEN': 'C-1', DETALLE: 'Consulta', CLASIFIACION: 'CONSULTA', VENDEDORA_PK: 'V1' },
    ]));
    expect(filas[0]).toMatchObject({ precio: 180, codOrigen: 'C-1', detalle: 'Consulta', clasificacionServicio: 'CONSULTA', vendedoraPk: 'V1' });
    expect(columnasAusentes).toContain('medico');
  });

  it('de una fórmula toma el resultado; de un texto con formato o un enlace, el texto; un #N/A es vacío', async () => {
    const { filas } = await leerExcel(await libroConCeldasRaras());
    expect(filas[0]).toMatchObject({ detalle: 'Consulta cardiología', precio: 250, obs: null });
    expect(filas[1]).toMatchObject({ detalle: 'Ecografía', precio: 3532.87 });
  });

  it('una fila sin ningún valor no cuenta, y una cabecera repetida no pisa a la primera', async () => {
    const resultado = await leerExcel(await libroConCeldasRaras());
    expect(resultado.filas).toHaveLength(2);
    expect(resultado.filasVacias).toBe(0);
    expect(resultado.filas[0].detalle).toBe('Consulta cardiología');
  });

  it('una fila con datos pero sin detalle ni precio se cuenta como vacía, igual que antes', async () => {
    const { filas, filasVacias } = await leerExcel(await excelDePrueba([BASE, { ...BASE, DETALLE: null, PRECIO: null }]));
    expect(filas).toHaveLength(1);
    expect(filasVacias).toBe(1);
  });

  /* Excel no tiene zona: «01/12/2025» es una fecha de calendario. Lo guardado en
     `VentaImportada.fecha` es medianoche LOCAL del proceso (así lo hacía SheetJS);
     medianoche UTC, vista desde La Paz, sería el 30 de noviembre a las 20:00. */
  it('una fecha de Excel queda a medianoche local: el día 1 no cae en el mes anterior', async () => {
    const { filas } = await leerExcel(await libroConCeldasRaras());
    const fecha = filas[0].fecha!;
    expect([fecha.getFullYear(), fecha.getMonth(), fecha.getDate(), fecha.getHours()]).toEqual([2025, 11, 1, 0]);
    expect(deducirPeriodo(filas)).toMatchObject({ anio: 2025, mes: 12, tipoCambio: 6.97 });
  });

  it('una fecha escrita como texto ISO también se entiende', async () => {
    const { filas } = await leerExcel(await excelDePrueba([{ ...BASE, FECHA: '2031-01-10' }]));
    expect(filas[0].fecha?.getFullYear()).toBe(2031);
  });

  it('rechaza lo que no es un .xlsx, una hoja vacía y la falta de columnas obligatorias', async () => {
    await expect(leerExcel(Buffer.from('no soy un excel'))).rejects.toBeInstanceOf(BadRequestException);
    await expect(leerExcel(await excelDePrueba([]))).rejects.toThrow('vacía');
    await expect(leerExcel(await excelDePrueba([{ FECHA: '2031-01-10', MODULO: 'X' }]))).rejects.toThrow('detalle, precio');
  });
});
