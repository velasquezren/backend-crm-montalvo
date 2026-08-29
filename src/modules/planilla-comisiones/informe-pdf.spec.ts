import { PassThrough } from 'stream';

import { CalculoComisionesService } from './calculo-comisiones.service';
import { ExportacionPdfService } from './exportacion-pdf.service';
import {
  armarInforme,
  AUTORIZA_PLANILLA,
  FilaInforme,
  firmantesPara,
  formatearNumero,
} from './informe-pdf';

/**
 * El informe de comisiones en PDF: el documento que se imprime y se firma.
 *
 * Las reglas (qué fila va en qué bloque, cuánto suma cada pie, quién firma) se
 * prueban sobre el módulo puro. Del PDF en sí se comprueba lo que de verdad
 * puede romperse sin que nadie lo note: que quepa en una página y que crezca
 * cuando toca.
 */

function fila(nombre: string, area: string, valores: Partial<FilaInforme> = {}): FilaInforme {
  return {
    nombre,
    codigo: `C-${nombre}`,
    area,
    montoVendido: 0,
    baseCalculo: 0,
    comisionA: 0,
    comisionTipoARA: 0,
    comisionB: 0,
    comisionC: 0,
    totalBonos: 0,
    totalUsd: 0,
    totalBob: 0,
    sueldoBase: 0,
    totalGanado: 0,
    ...valores,
  };
}

describe('armarInforme', () => {
  const zuany = fila('Zuany', 'EJECUTIVA', {
    montoVendido: 16453.95,
    totalUsd: 107.56,
    totalGanado: 3499.69,
  });
  const cristel = fila('Cristel', 'PUBLICIDAD', {
    totalBonos: 33.35,
    totalUsd: 33.35,
    totalGanado: 3694.95,
  });
  const araceli = fila('Araceli', 'PUBLICIDAD', {
    totalBonos: 33.35,
    totalUsd: 33.35,
    totalGanado: 3694.95,
  });

  it('separa marketing del equipo de ventas', () => {
    const informe = armarInforme([zuany, cristel, araceli]);

    expect(informe.ventas.map(f => f.nombre)).toEqual(['Zuany']);
    expect(informe.marketing.map(f => f.nombre)).toEqual(['Cristel', 'Araceli']);
  });

  /* Cada pie suma las filas que tiene ENCIMA. Reutilizar un total del periodo
     serviría para el general y para ninguno de los dos subtotales. */
  it('cada subtotal suma solo su propio bloque', () => {
    const informe = armarInforme([zuany, cristel, araceli]);

    expect(informe.totalVentas.totalUsd).toBeCloseTo(107.56, 2);
    expect(informe.totalMarketing.totalUsd).toBeCloseTo(66.7, 2);
  });

  it('el total general junta los dos bloques', () => {
    const informe = armarInforme([zuany, cristel, araceli]);

    expect(informe.totalGeneral.totalUsd).toBeCloseTo(174.26, 2);
    expect(informe.totalGeneral.totalGanado).toBeCloseTo(10889.59, 2);
  });

  it('sin marketing, el bloque queda vacío y su total en cero', () => {
    const informe = armarInforme([zuany]);

    expect(informe.marketing).toEqual([]);
    expect(informe.totalMarketing.totalUsd).toBe(0);
    expect(informe.totalGeneral.totalUsd).toBeCloseTo(informe.totalVentas.totalUsd, 2);
  });
});

/**
 * El formato se escribe a mano y no con `Intl.NumberFormat` a propósito: si el
 * proceso arrancara sin datos de localización completos, `Intl` cae a `en-US`
 * en silencio y la planilla saldría con los separadores cambiados —1,396.62 en
 * vez de 1.396,62—, que en un documento de pagos se lee como otra cifra.
 */
describe('formatearNumero', () => {
  it('usa punto para miles y coma para decimales', () => {
    expect(formatearNumero(108553.63)).toBe('108.553,63');
    expect(formatearNumero(1396.62)).toBe('1.396,62');
  });

  it('siempre dos decimales', () => {
    expect(formatearNumero(2750)).toBe('2.750,00');
    expect(formatearNumero(0)).toBe('0,00');
  });

  it('no pone separador por debajo de mil', () => {
    expect(formatearNumero(749.69)).toBe('749,69');
  });

  it('redondea a dos decimales', () => {
    expect(formatearNumero(33.345)).toBe('33,35');
  });

  it('conserva el signo de un negativo', () => {
    expect(formatearNumero(-1234.5)).toBe('-1.234,50');
  });
});

describe('firmantesPara', () => {
  it('elaborado y revisado son quien genera el informe', () => {
    const f = firmantesPara({ nombre: 'Lic. Sara Bueno' });

    expect(f.elaboradoPor).toBe('Lic. Sara Bueno');
    expect(f.revisadoPor).toBe('Lic. Sara Bueno');
  });

  /* La autorización es de la dirección de la clínica, no de quien imprime. */
  it('autoriza siempre la dirección', () => {
    expect(firmantesPara({ nombre: 'Cualquiera' }).autorizadoPor).toBe(AUTORIZA_PLANILLA);
  });

  /* Sin usuario NO se inventa un nombre: la línea queda para firmar a mano.
     Poner "Sistema" ahí sería atribuir una revisión que nadie hizo. */
  it('sin usuario deja la línea en blanco', () => {
    expect(firmantesPara(null).elaboradoPor).toBe('');
    expect(firmantesPara({ nombre: '   ' }).revisadoPor).toBe('');
  });
});

/* ── El PDF generado ─────────────────────────────────────────────────── */

function montarServicio(cantidadVendedoras: number, estado = 'CERRADO') {
  const resultados = Array.from({ length: cantidadVendedoras }, (_, i) => ({
    vendedoraId: `v${i}`,
    montoVendido: 1000,
    baseCalculo: 870,
    planesVendidos: 0,
    cumpleObjetivoPlanes: true,
    planpaqVendidos: 0,
    planpaqComisionables: 0,
    planninVendidos: 0,
    planninComisionables: 0,
    acumuladoCirugias: 0,
    nivelCirugia: null,
    ingresoMaternidadTipoARA: 0,
    ingresoRATipoARA: 0,
    excedenteTipoARA: 0,
    nivelTipoARA: null,
    comisionA: 10,
    comisionB: 0,
    comisionC: 0,
    comisionTipoARA: 0,
    bonoJefatura: 0,
    bonoPublicidad: 0,
    bonoTrimestral: 0,
    totalUsd: 10,
    totalBob: 69.7,
    sueldoBase: 2750,
    totalGanado: 2819.7,
    desglose: [],
    vendedora: {
      id: `v${i}`,
      nombre: `Vendedora ${i}`,
      codigo: `Pe${i}`,
      tipo: 'VENDEDORA',
      area: 'EJECUTIVA',
      oculta: false,
      ocultaDesde: null,
      motivoOculta: null,
    },
  }));

  const prisma = {
    periodoComision: {
      findUnique: async () => ({ id: 'p1', anio: 2026, mes: 6, tipoCambio: 6.97, estado }),
    },
    resultadoComision: { findMany: async () => resultados },
    usuario: { findUnique: async () => ({ nombre: 'Lic. Sara Bueno' }) },
  };

  const calculo = new CalculoComisionesService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return new ExportacionPdfService(prisma as never, calculo);
}

async function generar(cantidadVendedoras: number): Promise<Buffer> {
  const trozos: Buffer[] = [];
  const salida = new PassThrough();
  salida.on('data', c => trozos.push(c as Buffer));
  const cerrado = new Promise<void>(r => salida.on('end', () => r()));

  await montarServicio(cantidadVendedoras).exportar('p1', salida, { usuarioId: 'u1' });
  await cerrado;
  return Buffer.concat(trozos);
}

/** El nodo `/Pages` del PDF declara cuántas páginas tiene. */
function paginas(pdf: Buffer): number {
  return Number(/\/Count (\d+)/.exec(pdf.toString('latin1'))?.[1] ?? 0);
}

describe('PDF generado', () => {
  it('es un PDF válido', async () => {
    const pdf = await generar(4);

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(2000);
  });

  /*
   * La primera versión salía SIEMPRE con una segunda hoja en blanco: la
   * aclaración del pie se escribía por debajo del margen inferior y PDFKit abre
   * una página nueva él solo cuando eso pasa. No fallaba nada y el contenido
   * era correcto — solo que el informe que se archiva tenía una hoja de más.
   */
  it('la planilla del equipo cabe en UNA página', async () => {
    expect(paginas(await generar(4))).toBe(1);
  });

  /* Y cuando de verdad no cabe, pagina en vez de superponer filas. */
  it('con muchas vendedoras crece a más páginas', async () => {
    expect(paginas(await generar(40))).toBeGreaterThan(1);
  });
});
