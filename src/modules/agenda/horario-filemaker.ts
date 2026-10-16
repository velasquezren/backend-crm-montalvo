import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { HorarioFilemakerDto } from './dto/horario-filemaker.dto';
import { BloqueDeAgenda, CasillaActiva, DIAS_AGENDA, HORA_FILEMAKER, horarioHtmlPorTurnos } from './horario-html';

const minutos = (hora: string) => Number(hora.slice(0, 2)) * 60 + Number(hora.slice(3, 5));
const hora = (minuto: number) => `${String(Math.floor(minuto / 60)).padStart(2, '0')}:${String(minuto % 60).padStart(2, '0')}`;

/** Agrupa solo casillas contiguas: conserva los descansos incluso dentro de una mañana. */
export function bloquesContiguos(casillas: readonly CasillaActiva[], minutosConsulta = 30): BloqueDeAgenda[] {
  const resultado: BloqueDeAgenda[] = [];
  DIAS_AGENDA.forEach((dia, indice) => {
    const horas = [...new Set(casillas.filter(c => c.dia === dia).map(c => minutos(c.hora)))].sort((a, b) => a - b);
    let bloque: BloqueDeAgenda | undefined;
    for (const inicio of horas) {
      if (bloque && bloque.finMinuto === inicio) bloque.finMinuto = inicio + minutosConsulta;
      else { bloque = { diaSemana: indice + 1, inicioMinuto: inicio, finMinuto: inicio + minutosConsulta }; resultado.push(bloque); }
    }
  });
  return resultado;
}

export function prepararHorarioFilemaker(dto: HorarioFilemakerDto) {
  if (new Set(dto.dias.map(d => d.dia)).size !== 6) throw new BadRequestException('Debe enviar una vez cada día, de lunes a sábado.');
  const datos: HorarioFilemakerDto = {
    registroId: dto.registroId.trim(), medicoCodigo: dto.medicoCodigo.trim().toUpperCase(), revision: dto.revision,
    estado: dto.estado, sucursal: dto.sucursal.trim(), minutosConsulta: dto.minutosConsulta,
    dias: DIAS_AGENDA.map(dia => {
      const d = dto.dias.find(item => item.dia === dia);
      if (!d) throw new BadRequestException('Debe enviar los seis días completos.');
      return { dia, mananaInicio: d.mananaInicio, mananaUltima: d.mananaUltima, tardeInicio: d.tardeInicio, tardeUltima: d.tardeUltima };
    }),
  };
  if (!datos.registroId || datos.dias.some(d => !d)) throw new BadRequestException('El registro y los seis días son obligatorios.');
  // El guion instalado envía 30. Si un tramo no cabe en esa cadencia,
  // usamos 15 para TODO el médico; nunca redondeamos ni añadimos un cupo solapado.
  // Conservamos el dato original en la huella para que los reintentos sigan siendo idénticos.
  if (![15, 30].includes(datos.minutosConsulta)) throw new BadRequestException('La consulta debe durar 15 o 30 minutos.');
  const minutosConsulta = datos.minutosConsulta === 15 || datos.dias.some(d =>
    [[d.mananaInicio, d.mananaUltima], [d.tardeInicio, d.tardeUltima]].some(([i, u]) =>
      i && u && (minutos(u) - minutos(i)) % 30 !== 0)) ? 15 : 30;
  const casillas = new Map<string, CasillaActiva>();
  const tramos: { dia: typeof DIAS_AGENDA[number]; manana: string; tarde: string }[] = [];
  for (const d of datos.dias) {
    const tramo = (inicio: string, ultima: string): string => {
      if (!inicio && !ultima) return '';
      if (!HORA_FILEMAKER.test(inicio) || !HORA_FILEMAKER.test(ultima) || inicio > ultima) {
        throw new BadRequestException(`${d.dia}: complete ambos extremos en intervalos de 15 minutos, entre 05:00 y 22:30, con inicio anterior o igual a la última cita.`);
      }
      for (let m = minutos(inicio); m <= minutos(ultima); m += minutosConsulta) casillas.set(`${d.dia} ${hora(m)}`, { dia: d.dia, hora: hora(m) });
      const mostrar = (h: string) => h.replace(/^0(\d)/, '$1');
      return inicio === ultima ? mostrar(inicio) : `${mostrar(inicio)}-${mostrar(ultima)}`;
    };
    const manana = tramo(d.mananaInicio, d.mananaUltima);
    const tarde = tramo(d.tardeInicio, d.tardeUltima);
    if (d.mananaUltima && d.tardeInicio && d.tardeInicio !== d.mananaUltima && minutos(d.tardeInicio) < minutos(d.mananaUltima) + minutosConsulta) throw new BadRequestException(`${d.dia}: los tramos de mañana y tarde se superponen.`);
    // Un extremo compartido (12:30 / 12:30) representa UN cupo, no dos.
    tramos.push({ dia: d.dia, manana, tarde });
  }
  const activas = datos.estado === 'ACTIVO' ? [...casillas.values()] : [];
  const { revision: _revision, ...contenido } = datos;
  return {
    datos, activas, minutosConsulta, bloques: bloquesContiguos(activas, minutosConsulta),
    html: activas.length ? horarioHtmlPorTurnos(tramos) : '',
    huella: createHash('sha256').update(JSON.stringify(contenido)).digest('hex'),
  };
}
