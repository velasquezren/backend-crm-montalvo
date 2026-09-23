import { BadRequestException } from '@nestjs/common';

/**
 * Qué hace falta saber de una plantilla aprobada para mandarla desde el chat,
 * y cómo se convierte en el texto que de verdad recibe el paciente.
 *
 * Son funciones puras a propósito: cada regla de aquí corresponde a un rechazo
 * de Meta que llega DESPUÉS, por el webhook de `statuses`, cuando la agente ya
 * vio su mensaje «enviado». Adelantarlas al momento de pulsar Enviar es la
 * diferencia entre un aviso claro y un «No enviado» sin explicación.
 */

/** La plantilla tal como la devuelve Graph API (`message_templates`). */
export interface PlantillaMeta {
  name: string;
  status: string;
  category: string;
  language: string;
  /** `NAMED` usa `{{nombre}}`; `POSITIONAL` (o ausente, plantillas antiguas) usa `{{1}}`. */
  parameter_format?: string;
  components?: Array<{
    type: string;
    format?: string;
    text?: string;
    buttons?: Array<{ type: string; text?: string; url?: string }>;
  }>;
}

/** Plantilla aprobada, lista para el selector del chat. */
export interface PlantillaResumen {
  nombre: string;
  idioma: string;
  categoria: string;
  cuerpo: string;
  /** Nombres de las variables del cuerpo en el orden en que Meta las espera (`1`, `2`… o `nombre`, `fecha`…). */
  nombresVariables: string[];
  /** Cuántas son. Se conserva por compatibilidad con la interfaz anterior. */
  variables: number;
  formato: 'POSITIONAL' | 'NAMED';
  pie: string | null;
  botones: string[];
  /** false si lleva algo que el chat no sabe rellenar; Meta la rechazaría. */
  enviable: boolean;
  motivoNoEnviable: string | null;
}

const VARIABLE = /\{\{\s*([^}]+?)\s*\}\}/g;
const TIENE_VARIABLE = /\{\{[^}]+\}\}/;

function nombresEnOrden(texto: string, formato: 'POSITIONAL' | 'NAMED'): string[] {
  const nombres = [...new Set([...texto.matchAll(VARIABLE)].map(m => m[1]!))];
  /* Posicionales: Meta las numera desde 1 y las espera en ese orden, aunque en
     el texto aparezcan como «{{2}} … {{1}}». */
  return formato === 'POSITIONAL' ? nombres.sort((a, b) => Number(a) - Number(b)) : nombres;
}

export function resumirPlantilla(meta: PlantillaMeta): PlantillaResumen {
  const formato = meta.parameter_format === 'NAMED' ? 'NAMED' : 'POSITIONAL';
  const componente = (tipo: string) => meta.components?.find(c => c.type === tipo);
  const cuerpo = componente('BODY')?.text ?? '';
  const cabecera = componente('HEADER');
  const botones = componente('BUTTONS')?.buttons ?? [];
  const nombresVariables = nombresEnOrden(cuerpo, formato);

  let motivoNoEnviable: string | null = null;
  if (cabecera && cabecera.format && cabecera.format !== 'TEXT') {
    motivoNoEnviable = 'Lleva una imagen, video o documento de encabezado: el chat todavía no sabe adjuntarlo.';
  } else if (cabecera?.text && TIENE_VARIABLE.test(cabecera.text)) {
    motivoNoEnviable = 'El encabezado tiene una variable: el chat solo rellena las del cuerpo.';
  } else if (botones.some(b => b.type === 'URL' && TIENE_VARIABLE.test(b.url ?? ''))) {
    motivoNoEnviable = 'Su botón lleva un enlace variable; se envía desde el módulo que lo genera.';
  }

  return {
    nombre: meta.name,
    idioma: meta.language,
    categoria: meta.category,
    cuerpo,
    nombresVariables,
    variables: nombresVariables.length,
    formato,
    pie: componente('FOOTER')?.text ?? null,
    botones: botones.map(b => b.text ?? '').filter(Boolean),
    enviable: motivoNoEnviable === null,
    motivoNoEnviable,
  };
}

/**
 * Meta rechaza (#132018) un parámetro con saltos de línea, tabuladores o más
 * de cuatro espacios seguidos, y (#132000) uno vacío.
 */
export function validarParametros(plantilla: PlantillaResumen, parametros: readonly string[]): string[] {
  if (!plantilla.enviable) throw new BadRequestException(plantilla.motivoNoEnviable);
  if (parametros.length !== plantilla.nombresVariables.length) {
    throw new BadRequestException(
      `La plantilla «${plantilla.nombre}» necesita ${plantilla.nombresVariables.length} dato(s) y llegaron ${parametros.length}.`,
    );
  }
  return parametros.map((valor, i) => {
    const limpio = valor.trim();
    if (!limpio) throw new BadRequestException(`Falta completar «${plantilla.nombresVariables[i]}».`);
    if (/[\n\t]| {5,}/.test(limpio)) {
      throw new BadRequestException(
        `«${plantilla.nombresVariables[i]}» no puede llevar saltos de línea ni muchos espacios seguidos: WhatsApp lo rechaza.`,
      );
    }
    return limpio;
  });
}

/** El texto que recibe el paciente: es lo que se guarda en el historial. */
export function renderizarPlantilla(plantilla: PlantillaResumen, parametros: readonly string[]): string {
  const valores = new Map(plantilla.nombresVariables.map((nombre, i) => [nombre, parametros[i] ?? '']));
  const cuerpo = plantilla.cuerpo.replace(VARIABLE, (original, nombre: string) => valores.get(nombre) ?? original);
  return plantilla.pie ? `${cuerpo}\n\n${plantilla.pie}` : cuerpo;
}
