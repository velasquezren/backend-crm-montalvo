import { PassThrough } from 'stream';

import { CalculoComisionesService } from './calculo-comisiones.service';
import { ExportacionWordService } from './exportacion-word.service';
import { ExportacionMetricasService } from './exportacion-metricas.service';
import {
  armarInforme,
  AUTORIZA_PLANILLA,
  comisionesDe,
  FilaInforme,
  firmantesPara,
  formatearNumero,
  formatearPorcentaje,
} from './informe-liquidacion';

/**
 * El informe de liquidación: el documento que administración revisa y firma.
 *
 * Las reglas (qué fila va en qué bloque, cuánto suma cada pie, quién firma) se
 * prueban sobre el módulo puro, que no depende del formato. Del .docx en sí se
 * comprueba que se genere y que sea un Word de verdad — el contenido visible ya
 * está fijado por las pruebas de arriba.
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

describe('comisionesDe', () => {
  /* El informe vertical no tiene ancho para una columna por tipo —son cuatro—
     y el desglose por tipo es justo lo que se va a mirar al Excel. */
  it('suma los cuatro tipos en un solo número', () => {
    expect(
      comisionesDe({ comisionA: 98.08, comisionTipoARA: 2.91, comisionB: 551.24, comisionC: 24.6 }),
    ).toBeCloseTo(676.83, 2);
  });
});

describe('formatearPorcentaje', () => {
  /* `toFixed()` devuelve siempre punto, y "1.85 %" junto a "42.725,33" mezcla
     dos convenciones en la misma línea del mismo documento. */
  it('usa coma decimal, como el resto de los números', () => {
    expect(formatearPorcentaje(1.85, 2)).toBe('1,85 %');
    expect(formatearPorcentaje(19.24)).toBe('19,2 %');
  });

  it('un cero también sale con coma', () => {
    expect(formatearPorcentaje(0)).toBe('0,0 %');
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

/* ── El documento generado ───────────────────────────────────────────── */

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
  return new ExportacionWordService(prisma as never, calculo);
}

describe('documento Word generado', () => {
  /* Un .docx es un ZIP: empieza por la firma PK. Si `Packer` devolviera otra
     cosa —un stream, un string— Word abriría un archivo corrupto y el fallo
     solo se vería al abrirlo. */
  it('es un .docx válido', async () => {
    const doc = await montarServicio(4).generar('p1', { usuarioId: 'u1' });

    expect(doc.subarray(0, 2).toString()).toBe('PK');
    expect(doc.length).toBeGreaterThan(3000);
  });

  /*
   * El documento se arma entero en memoria (un ZIP no se puede escribir a
   * medias), así que conviene tener a la vista cuánto ocupa: el servicio corre
   * con MemoryMax=400M. Diez filas y tres firmas no llegan a 20 KB, y aunque el
   * equipo creciera diez veces sigue siendo irrelevante.
   */
  it('pesa poco aunque el equipo crezca', async () => {
    const doc = await montarServicio(40).generar('p1', { usuarioId: 'u1' });

    expect(doc.length).toBeLessThan(200_000);
  });

  it('se genera igual sin usuario que lo firme', async () => {
    const doc = await montarServicio(4).generar('p1');

    expect(doc.subarray(0, 2).toString()).toBe('PK');
  });
});

/* ── El PDF de métricas ──────────────────────────────────────────────── */

describe('PDF de métricas', () => {
  async function generarMetricas(cantidad: number): Promise<Buffer> {
    const resultados = Array.from({ length: cantidad }, (_, i) => ({
      vendedoraId: `v${i}`,
      montoVendido: 10000 + i * 1000,
      baseCalculo: 8700,
      planesVendidos: 5,
      cumpleObjetivoPlanes: true,
      planpaqVendidos: 5,
      planpaqComisionables: 1,
      planninVendidos: 3,
      planninComisionables: 1,
      acumuladoCirugias: 0,
      nivelCirugia: null,
      ingresoMaternidadTipoARA: 0,
      ingresoRATipoARA: 0,
      excedenteTipoARA: 0,
      nivelTipoARA: null,
      comisionA: 50,
      comisionB: 30,
      comisionC: 20,
      comisionTipoARA: 10,
      bonoJefatura: 5,
      bonoPublicidad: 0,
      bonoTrimestral: 0,
      totalUsd: 115,
      totalBob: 801.55,
      sueldoBase: 0,
      totalGanado: 801.55,
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
        findUnique: async () => ({ id: 'p1', anio: 2026, mes: 1, tipoCambio: 6.97, estado: 'CALCULADO' }),
      },
      resultadoComision: { findMany: async () => resultados },
    };
    const calculo = new CalculoComisionesService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const trozos: Buffer[] = [];
    const salida = new PassThrough();
    salida.on('data', c => trozos.push(c as Buffer));
    const cerrado = new Promise<void>(r => salida.on('end', () => r()));

    await new ExportacionMetricasService(prisma as never, calculo).exportar('p1', salida);
    await cerrado;
    return Buffer.concat(trozos);
  }

  const paginas = (pdf: Buffer) => Number(/\/Count (\d+)/.exec(pdf.toString('latin1'))?.[1] ?? 0);

  it('es un PDF válido', async () => {
    const pdf = await generarMetricas(4);

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  /* Panorama del equipo + una página por cada tres fichas. Con 4 vendedoras:
     panorama, tres fichas, y la cuarta en su propia página. */
  it('el panorama va aparte de las fichas, tres por página', async () => {
    expect(paginas(await generarMetricas(3))).toBe(2);
    expect(paginas(await generarMetricas(4))).toBe(3);
    expect(paginas(await generarMetricas(6))).toBe(3);
  });

  /* Un mes sin liquidar no puede reventar el informe: sale el panorama en cero
     y ninguna ficha. */
  it('sin vendedoras no falla', async () => {
    const pdf = await generarMetricas(0);

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(paginas(pdf)).toBe(1);
  });
});
