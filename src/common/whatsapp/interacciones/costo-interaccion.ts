/** Estimación por entrega. No reemplaza pricing_analytics ni factura de Meta.
 * Sin rate card vigente/cuota corroborada: desconocido, nunca cero implícito.
 */
export interface ContextoCosto {
  phoneNumberId: string;
  mercado: string;
  categoria: "service" | "utility" | "authentication" | "marketing";
  ventanaServicioAbierta: boolean;
  entrega: "pendiente" | "no_entregado" | "entregado";
  fechaEntrega: string;
  fepVerificadoHasta: string | null;
  cuotaGratisRestanteVerificada: number | null;
  tarifa: {
    phoneNumberId: string;
    mercado: string;
    categoria: ContextoCosto["categoria"];
    usd: number;
    desde: string;
    hasta: string;
    fuente: string;
  } | null;
}
export function estimarCosto(c: ContextoCosto): {
  usd: number | null;
  motivo: string;
  facturacionReal: false;
} {
  const resultado = (usd: number | null, motivo: string) => ({
    usd,
    motivo,
    facturacionReal: false as const,
  });
  if (c.entrega === "pendiente") return resultado(null, "ENTREGA_PENDIENTE");
  if (c.entrega === "no_entregado") return resultado(0, "SIN_ENTREGA");
  const fecha = Date.parse(c.fechaEntrega);
  if (!Number.isFinite(fecha)) return resultado(null, "FECHA_INVALIDA");
  if (c.fepVerificadoHasta && fecha < Date.parse(c.fepVerificadoHasta))
    return resultado(0, "FEP_VERIFICADO");
  if (
    c.categoria === "service" &&
    c.cuotaGratisRestanteVerificada !== null &&
    c.cuotaGratisRestanteVerificada > 0
  )
    return resultado(0, "CUOTA_VERIFICADA");
  const t = c.tarifa;
  if (
    !t ||
    t.phoneNumberId !== c.phoneNumberId ||
    t.mercado !== c.mercado ||
    t.categoria !== c.categoria ||
    !t.fuente.trim() ||
    !Number.isFinite(t.usd) ||
    t.usd < 0 ||
    !(fecha >= Date.parse(t.desde) && fecha < Date.parse(t.hasta))
  )
    return resultado(null, "TARIFA_NO_VERIFICADA");
  // Una ventana de servicio abierta permite responder: no prueba gratuidad en octubre 2026.
  return resultado(t.usd, "ESTIMADO_POR_ENTREGA");
}
