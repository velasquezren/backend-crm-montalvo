/** Activación explícita por línea, independiente del modo de respuesta de IA. */
export function lineasTranscripcionAudio(): string[] {
  return [...new Set((process.env.TRANSCRIPCION_AUDIO_LINEAS ?? '').split(',').map(id => id.trim()).filter(id => id && id !== '*'))];
}

export function transcribirAudioEnLinea(lineaId: string): boolean {
  return lineasTranscripcionAudio().includes(lineaId);
}
