import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  PageOrientation,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';

import { PrismaService } from '../../prisma/prisma.service';
import { CalculoComisionesService } from './calculo-comisiones.service';
import {
  armarInforme,
  FilaInforme,
  Firmantes,
  firmantesPara,
  formatearNumero,
  InformeComisiones,
  TotalesBloque,
} from './informe-liquidacion';

/**
 * Informe mensual de comisiones en Word (.docx).
 *
 * ## Por qué Word y no PDF
 *
 * Lo pidió administración: el informe se revisa y a veces se anota o se corrige
 * un nombre antes de firmarlo, y un PDF obliga a rehacerlo desde el sistema por
 * cualquier retoque. Un .docx se abre en Word o LibreOffice, se edita y se
 * exporta a PDF desde ahí cuando toca archivarlo.
 *
 * El coste es comparable al del Excel que ya se genera: `docx` es JS puro, arma
 * un documento de unos 10 KB en milisegundos y no levanta ningún navegador —
 * importante con `MemoryMax=400M` en un VPS compartido.
 *
 * ## Vertical, y por eso ocho columnas
 *
 * En A4 vertical caben ~17 cm de tabla. Las 20 columnas de la hoja
 * "Liquidación" necesitarían el triple, así que este informe responde solo su
 * pregunta —cuánto se le paga a cada quien— y las cuatro comisiones van
 * sumadas en una sola columna. El desglose por tipo, los niveles y los planes
 * están en el Excel, que es donde se audita.
 *
 * ## Sobrio a propósito
 *
 * Sin bloques de color ni franjas: gris muy claro en las cabeceras, filetes
 * finos y negro sobre blanco. Es un documento que se imprime, se firma y se
 * archiva; el color de marca es de la interfaz, no del papel.
 */

/** Gris de cabecera y gris de filete. Es toda la paleta del documento. */
const GRIS_CABECERA = 'EFEFEF';
const GRIS_FILETE = 'BFBFBF';
const NEGRO = '000000';

/** A4 vertical con márgenes de 2 cm, en twips (1 cm = 567). */
const MARGEN = 1134;

const MESES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

const ESTADO_LEGIBLE: Record<string, string> = {
  BORRADOR: 'Borrador',
  CALCULADO: 'Calculado',
  EN_REVISION: 'En revisión',
  CERRADO: 'Cerrado',
  PAGADO: 'Pagado',
};

/**
 * Anchos en porcentaje del ancho de la tabla. Suman 100.
 *
 * **Sin sueldo y sin "A PAGAR".** Este informe es de COMISIONES: los sueldos se
 * pagan por otra vía y en otro momento —en agosto se está liquidando enero— así
 * que mezclarlos en la misma fila invita a pagar dos veces lo mismo. La columna
 * final es la comisión del mes convertida a bolivianos, y nada más.
 *
 * **En cambio sí va el desglose por tipo**, que es lo que se discute cuando
 * alguien revisa su liquidación: de dónde salió cada parte. Caben porque los
 * importes de comisión son de tres cifras, no de seis como el facturado.
 */
const COLUMNAS = [
  /* 30 % para el nombre: con 23 % "Canedo Villamor Claudia Marcela" volvía a
     partirse en cuatro líneas. Se lo quitan las columnas de tipo, que muestran
     importes de tres cifras ("136,80") y no necesitan casi nada. */
  { titulo: 'Vendedora', ancho: 30, numerica: false },
  { titulo: 'Facturado\n($us)', ancho: 12, numerica: true },
  { titulo: 'Tipo A\n($us)', ancho: 8, numerica: true },
  { titulo: 'Tipo A RA\n($us)', ancho: 8, numerica: true },
  { titulo: 'Tipo B\n($us)', ancho: 8, numerica: true },
  { titulo: 'Tipo C\n($us)', ancho: 8, numerica: true },
  { titulo: 'Bonos\n($us)', ancho: 8, numerica: true },
  { titulo: 'Total\n($us)', ancho: 9, numerica: true },
  { titulo: 'Comisión\n(Bs)', ancho: 9, numerica: true },
] as const;

@Injectable()
export class ExportacionWordService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calculo: CalculoComisionesService,
  ) {}

  async nombreArchivo(periodoId: string): Promise<string> {
    const periodo = await this.prisma.periodoComision.findUnique({
      where: { id: periodoId },
      select: { anio: true, mes: true },
    });
    if (!periodo) {
      throw new NotFoundException(`Periodo ${periodoId} no encontrado`);
    }
    return `informe-comisiones-${periodo.anio}-${String(periodo.mes).padStart(2, '0')}.docx`;
  }

  async generar(
    periodoId: string,
    opciones: { incluirOcultas?: boolean; usuarioId?: string } = {},
  ): Promise<Buffer> {
    const consolidado = await this.calculo.reporteConsolidado(
      periodoId,
      opciones.incluirOcultas ?? false,
    );

    const usuario = opciones.usuarioId
      ? await this.prisma.usuario.findUnique({
          where: { id: opciones.usuarioId },
          select: { nombre: true },
        })
      : null;

    const informe = armarInforme(consolidado.filas);
    const firmantes = firmantesPara(usuario);
    const periodo = consolidado.periodo;

    const hijos: Array<Paragraph | Table> = [
      ...this.encabezado(
        periodo.mes,
        periodo.anio,
        Number(periodo.tipoCambio) || 1,
        periodo.estado,
        firmantes,
      ),
      ...this.bloque('Equipo de ventas', informe.ventas, informe.totalVentas, false),
    ];

    if (informe.marketing.length > 0) {
      hijos.push(...this.bloque('Equipo de marketing', informe.marketing, informe.totalMarketing, true));
    }

    /* El titular va SIEMPRE, haya marketing o no: es el número por el que se
       abre este documento. Cuando hay un solo bloque repite su pie, y está
       bien — se lee sin tener que buscarlo dentro de la tabla. */
    hijos.push(
      ...this.totalComisiones(informe),
      ...this.avisoOcultas(consolidado),
      ...this.firmas(firmantes),
    );

    const doc = new Document({
      creator: 'Clínica Montalvo',
      title: `Informe de Comisiones ${periodo.mes}/${periodo.anio}`,
      /* Una sola familia y un solo tamaño base: un documento que administración
         va a editar no puede traer diez estilos que se peleen al escribir. */
      styles: {
        default: {
          document: { run: { font: 'Calibri', size: 18, color: NEGRO } },
        },
      },
      sections: [
        {
          properties: {
            page: {
              size: { orientation: PageOrientation.PORTRAIT },
              margin: { top: MARGEN, right: MARGEN, bottom: MARGEN, left: MARGEN },
            },
          },
          children: hijos,
        },
      ],
    });

    return Packer.toBuffer(doc) as unknown as Promise<Buffer>;
  }

  /* ── Encabezado ─────────────────────────────────────────────────────── */

  private encabezado(
    mes: number,
    anio: number,
    tipoCambio: number,
    estado: string,
    firmantes: Firmantes,
  ): Paragraph[] {
    const definitivo = estado === 'CERRADO' || estado === 'PAGADO';

    const parrafos = [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        heading: HeadingLevel.HEADING_1,
        children: [
          new TextRun({ text: 'CLÍNICA MONTALVO', bold: true, size: 30, color: NEGRO }),
        ],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: 'Informe General de Comisiones', size: 24, color: NEGRO }),
        ],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 240 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: GRIS_FILETE, space: 6 } },
        children: [
          new TextRun({ text: `${MESES[mes - 1] ?? mes} ${anio}`, bold: true, size: 24 }),
        ],
      }),
      /* Con qué se convirtió y cuándo se emitió, en una sola línea: son el
         mismo tipo de dato (metadatos del documento) y separarlos en dos
         líneas de "Etiqueta: valor" no suma nada, solo alarga el encabezado. */
      this.lineaDato(
        'Tipo de cambio',
        `Bs ${formatearNumero(tipoCambio)}   ·   Emitido el ${new Date().toLocaleDateString('es-BO')}`,
      ),
    ];

    if (firmantes.elaboradoPor) {
      parrafos.push(this.lineaDato('Elaborado por', firmantes.elaboradoPor));
    }

    /*
     * El estado del periodo no lleva línea propia: solo importa decirlo
     * cuando el mes AÚN NO está cerrado, y ahí ya hace falta un aviso —así
     * que el estado viaja dentro de ese mismo aviso en vez de duplicarse.
     * Un "Estado del periodo: Cerrado" en cada informe definitivo no le dice
     * nada nuevo a quien ya tiene el papel para firmar.
     *
     * Las cifras de un mes sin cerrar pueden cambiar al día siguiente. Sin
     * este aviso el informe de un borrador sale idéntico al definitivo, y
     * este es un documento editable: quien lo reciba no tiene forma de saber
     * de cuál se trata.
     */
    if (!definitivo) {
      parrafos.push(
        new Paragraph({
          spacing: { before: 160 },
          children: [
            new TextRun({
              text: `Documento preliminar (${ESTADO_LEGIBLE[estado] ?? estado}): el periodo aún no está cerrado y las cifras pueden cambiar.`,
              bold: true,
              size: 16,
            }),
          ],
        }),
      );
    }

    /* El aviso de "no incluye sueldos" que antes vivía en una línea propia
       ("Concepto") se dice una sola vez, junto al total que sí paga en este
       documento (`totalComisiones`) — decirlo dos veces no lo refuerza, solo
       ocupa una línea más antes de llegar a la tabla. */
    return parrafos;
  }

  private lineaDato(etiqueta: string, valor: string): Paragraph {
    return new Paragraph({
      spacing: { after: 40 },
      children: [
        new TextRun({ text: `${etiqueta}: `, bold: true, size: 18 }),
        new TextRun({ text: valor, size: 18 }),
      ],
    });
  }

  /* ── Bloques de la planilla ─────────────────────────────────────────── */

  private bloque(
    titulo: string,
    filas: FilaInforme[],
    totales: TotalesBloque,
    esMarketing: boolean,
  ): Array<Paragraph | Table> {
    const encabezadoBloque = new Paragraph({
      spacing: { before: 320, after: 120 },
      children: [new TextRun({ text: titulo.toUpperCase(), bold: true, size: 19 })],
    });

    if (filas.length === 0) {
      return [
        encabezadoBloque,
        new Paragraph({ children: [new TextRun({ text: 'Sin personas en este bloque.', italics: true, size: 17 })] }),
      ];
    }

    const tabla = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: this.bordes(),
      rows: [
        this.filaCabecera(),
        ...filas.map(f => this.filaDatos(f, esMarketing)),
        this.filaTotales(totales, esMarketing),
      ],
    });

    return [encabezadoBloque, tabla];
  }

  private filaCabecera(): TableRow {
    return new TableRow({
      tableHeader: true,
      children: COLUMNAS.map(
        col =>
          new TableCell({
            width: { size: col.ancho, type: WidthType.PERCENTAGE },
            shading: { fill: GRIS_CABECERA },
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 60, bottom: 60, left: 40, right: 40 },
            children: col.titulo.split('\n').map(
              linea =>
                new Paragraph({
                  alignment: col.numerica ? AlignmentType.RIGHT : AlignmentType.LEFT,
                  children: [new TextRun({ text: linea, bold: true, size: 15 })],
                }),
            ),
          }),
      ),
    });
  }

  private filaDatos(f: FilaInforme, esMarketing: boolean): TableRow {
    /* Las columnas de venta van VACÍAS en marketing, no en 0,00: un cero dice
       "vendió y no llegó", el hueco dice "esto no le corresponde". */
    const valores = [
      f.nombre,
      esMarketing ? '' : formatearNumero(f.montoVendido),
      esMarketing ? '' : formatearNumero(f.comisionA),
      esMarketing ? '' : formatearNumero(f.comisionTipoARA),
      esMarketing ? '' : formatearNumero(f.comisionB),
      esMarketing ? '' : formatearNumero(f.comisionC),
      formatearNumero(f.totalBonos),
      formatearNumero(f.totalUsd),
      formatearNumero(f.totalBob),
    ];

    return new TableRow({
      children: valores.map((valor, i) => this.celda(valor, COLUMNAS[i], false)),
    });
  }

  private filaTotales(totales: TotalesBloque, esMarketing: boolean): TableRow {
    const valores = [
      'TOTAL',
      esMarketing ? '' : formatearNumero(totales.montoVendido),
      esMarketing ? '' : formatearNumero(totales.comisionA),
      esMarketing ? '' : formatearNumero(totales.comisionTipoARA),
      esMarketing ? '' : formatearNumero(totales.comisionB),
      esMarketing ? '' : formatearNumero(totales.comisionC),
      formatearNumero(totales.totalBonos),
      formatearNumero(totales.totalUsd),
      formatearNumero(totales.totalBob),
    ];

    return new TableRow({
      children: valores.map((valor, i) => this.celda(valor, COLUMNAS[i], true)),
    });
  }

  private celda(
    valor: string,
    col: (typeof COLUMNAS)[number],
    negrita: boolean,
  ): TableCell {
    return new TableCell({
      width: { size: col.ancho, type: WidthType.PERCENTAGE },
      verticalAlign: VerticalAlign.CENTER,
      margins: { top: 50, bottom: 50, left: 40, right: 40 },
      children: [
        new Paragraph({
          alignment: col.numerica ? AlignmentType.RIGHT : AlignmentType.LEFT,
          children: [new TextRun({ text: valor, bold: negrita, size: 16 })],
        }),
      ],
    });
  }

  private bordes() {
    const filete = { style: BorderStyle.SINGLE, size: 2, color: GRIS_FILETE };
    return {
      top: filete,
      bottom: filete,
      left: filete,
      right: filete,
      insideHorizontal: filete,
      insideVertical: filete,
    };
  }

  /**
   * El titular del informe: lo que hay que pagar en comisiones este mes.
   *
   * Va como párrafo destacado y no como una tercera tabla de una fila — en
   * vertical, una tabla suelta con un solo dato se lee como si le faltara algo.
   */
  private totalComisiones(informe: InformeComisiones): Paragraph[] {
    return [
      new Paragraph({
        spacing: { before: 280 },
        border: { top: { style: BorderStyle.SINGLE, size: 6, color: NEGRO, space: 6 } },
        children: [
          new TextRun({ text: 'TOTAL COMISIONES A PAGAR:  ', bold: true, size: 20 }),
          new TextRun({
            text: `Bs ${formatearNumero(informe.totalGeneral.totalBob)}`,
            bold: true,
            size: 20,
          }),
        ],
      }),
      new Paragraph({
        spacing: { after: 120 },
        children: [
          new TextRun({
            text:
              informe.marketing.length > 0
                ? 'Equipo de ventas y marketing juntos. No incluye sueldos.'
                : 'No incluye sueldos.',
            italics: true,
            size: 15,
          }),
        ],
      }),
    ];
  }

  /**
   * La misma declaración que llevan el Excel y la pantalla — la razón de
   * fondo es la misma: un total que cuadra con sus filas y aun así le falta
   * gente es peor que uno incompleto. Pero acá es una nota al pie, no una
   * línea del cuerpo: chica, y con la gramática bien —"1 vendedora", no
   * "vendedora(s)"—, que es la diferencia entre un aviso y una plantilla sin
   * terminar.
   */
  private avisoOcultas(consolidado: {
    incluyeOcultas: boolean;
    ocultas: ReadonlyArray<{ nombre: string; codigo: string }>;
  }): Paragraph[] {
    const fuera = consolidado.incluyeOcultas ? [] : consolidado.ocultas;
    if (fuera.length === 0) return [];

    const nombres = fuera.map(v => `${v.nombre} (${v.codigo})`).join(', ');
    const texto =
      fuera.length === 1
        ? `No incluye a la vendedora dada de baja ${nombres}.`
        : `No incluye a las ${fuera.length} vendedoras dadas de baja: ${nombres}.`;

    return [
      new Paragraph({
        spacing: { before: 200 },
        children: [new TextRun({ text: texto, italics: true, size: 13 })],
      }),
    ];
  }

  /* ── Firmas ─────────────────────────────────────────────────────────── */

  /**
   * Las tres firmas, en una tabla sin bordes.
   *
   * Tabla y no tabulaciones: administración va a editar este archivo, y unas
   * columnas hechas con tabuladores se desmontan en cuanto alguien cambia un
   * nombre por otro más largo.
   */
  private firmas(firmantes: Firmantes): Array<Paragraph | Table> {
    const casillas: Array<[string, string]> = [
      ['Elaborado por', firmantes.elaboradoPor],
      ['Revisado por', firmantes.revisadoPor],
      ['Autorizado por', firmantes.autorizadoPor],
    ];

    const celda = (rol: string, nombre: string) =>
      new TableCell({
        width: { size: 33, type: WidthType.PERCENTAGE },
        borders: {
          top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
          bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
          left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
          right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
        },
        children: [
          /* La línea de firma es el borde inferior de un párrafo vacío: así se
             mantiene recta aunque el nombre de abajo cambie de largo. */
          new Paragraph({
            spacing: { before: 700 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: NEGRO, space: 2 } },
            children: [new TextRun({ text: '', size: 16 })],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 80 },
            children: [new TextRun({ text: nombre || '', bold: true, size: 17 })],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: rol, size: 15 })],
          }),
        ],
      });

    return [
      new Paragraph({
        spacing: { before: 400 },
        children: [
          new TextRun({
            text:
              'Los importes en bolivianos se convirtieron con el tipo de cambio del periodo ' +
              'liquidado.',
            italics: true,
            size: 15,
          }),
        ],
      }),
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
          top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
          bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
          left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
          right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
          insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
          insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
        },
        rows: [new TableRow({ children: casillas.map(([rol, nombre]) => celda(rol, nombre)) })],
      }),
    ];
  }
}
