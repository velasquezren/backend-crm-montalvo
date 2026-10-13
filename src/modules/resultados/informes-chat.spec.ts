import { informesEnLinea, pideSusInformes } from './informes-chat.service';
import { HerramientasAsistenteService, herramientasDisponibles } from '../asistente/herramientas';
import { aTurno } from '../conversaciones/asistente-chat.service';

afterEach(() => { delete process.env.RESULTADOS_AUTOSERVICIO_LINEAS; delete process.env.WHATSAPP_INTERACCIONES; delete process.env.WHATSAPP_INTERACCIONES_LINEAS; });
it('falla cerrado por línea; todas no habilita datos clínicos', () => {
  process.env.WHATSAPP_INTERACCIONES = 'on'; process.env.WHATSAPP_INTERACCIONES_LINEAS = 'todas';
  expect(informesEnLinea('recepcion')).toBe(false);
  process.env.RESULTADOS_AUTOSERVICIO_LINEAS = 'todas'; expect(informesEnLinea('recepcion')).toBe(false);
  process.env.RESULTADOS_AUTOSERVICIO_LINEAS = 'recepcion';
  expect(informesEnLinea('recepcion')).toBe(true); expect(informesEnLinea('ventas')).toBe(false);
  delete process.env.WHATSAPP_INTERACCIONES; expect(informesEnLinea('recepcion')).toBe(false);
});
it('una solicitud de descarga no intercepta preguntas clínicas', () => {
  for (const texto of ['Mis informes', 'Quiero mis resultados', 'Envíame mi informe por favor']) expect(pideSusInformes(texto)).toBe(true);
  for (const texto of ['Mis resultados están altos', 'Quiero mis informes y me duele', 'Resultado de otra persona', 'Tengo una emergencia']) expect(pideSusInformes(texto)).toBe(false);
});
it('el modelo no recibe la lista ni los títulos seleccionados en el historial', () => {
  const m = { id: 'sintetico', createdAt: new Date(), direccion: 'ENTRANTE', tipo: 'TEXTO', mediaNombre: null, transcripcion: null, automatico: false, contenido: 'Estudio privado', interaccion: { vista: { proposito: 'INFORMES' } } } as Parameters<typeof aTurno>[0];
  expect(aTurno(m)).toBeNull();
});
it('abrir_mis_informes solo está declarada en líneas autorizadas y no consulta pacientes', async () => {
  const opciones = { permitirEscritura: false };
  expect(herramientasDisponibles({ telefono: '+59170000001', ventas: null }, opciones).some(h => h.nombre === 'abrir_mis_informes')).toBe(false);
  const h = herramientasDisponibles({ telefono: '+59170000001', ventas: null, informes: true }, opciones).find(h => h.nombre === 'abrir_mis_informes');
  expect(h?.parametros.properties).toEqual({});
  // Ningún puerto de datos se necesita: la autorización y la consulta son del CRM.
  const servicio = new HerramientasAsistenteService(undefined as never, undefined as never);
  expect(await servicio.ejecutar('abrir_mis_informes', {}, { telefono: '+59170000001', ventas: null, informes: true }, opciones))
    .toMatchObject({ ok: true, accion: { tipo: 'INFORMES' } });
  expect(await servicio.ejecutar('abrir_mis_informes', {}, { telefono: '+59170000001', ventas: null }, opciones)).toMatchObject({ ok: false });
});
