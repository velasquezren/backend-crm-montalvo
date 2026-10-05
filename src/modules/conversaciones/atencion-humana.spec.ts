import { esAvisoDeEmergencia, esPedidoDePersona, estadoDeAtencion, motivoDeRespuesta, prioridadDeMotivo, subeMotivo } from './atencion-humana';

describe('reglas de atención humana', () => {
  it.each([
    [{ estado: 'CORRELACIONADA', seleccionId: 'TALK_TO_HUMAN' }, 'SOLICITUD_EXPLICITA'],
    [{ estado: 'CADUCADA', seleccionId: 'TALK_TO_HUMAN' }, 'SOLICITUD_EXPLICITA'],
    [{ estado: 'CORRELACIONADA', seleccionId: 'BOOK_APPOINTMENT' }, 'SOLICITUD_CITA'],
    [{ estado: 'CORRELACIONADA', propositoFlow: 'SOLICITUD_CITA' }, 'SOLICITUD_CITA'],
    [{ estado: 'CORRELACIONADA', seleccionId: 'VIEW_SERVICES' }, 'REVISION'],
    [{ estado: 'NO_CORRELACIONADA' }, 'REVISION'],
    [{ estado: 'INVALIDA' }, 'REVISION'],
    [{ estado: 'DESCONOCIDA' }, 'REVISION'],
    [{ estado: 'DUPLICADA', seleccionId: 'TALK_TO_HUMAN' }, null],
    [{ estado: 'CORRELACIONADA', seleccionId: 'EMERGENCY' }, 'EMERGENCIA'],
    [{ estado: 'CADUCADA', seleccionId: 'EMERGENCY' }, 'EMERGENCIA'],
    [{ estado: 'NO_CORRELACIONADA', seleccionId: 'EMERGENCY' }, 'REVISION'],
  ])('%j → %s', (r, esperado) => {
    expect(motivoDeRespuesta(r)).toBe(esperado);
  });

  it('lo que el menú contesta solo no pide persona, salvo un toque tardío', () => {
    expect(motivoDeRespuesta({ estado: 'CORRELACIONADA', seleccionId: 'INFO_abcd1234' }, true)).toBeNull();
    expect(motivoDeRespuesta({ estado: 'CADUCADA', seleccionId: 'INFO_abcd1234' }, true)).toBe('REVISION');
    /* Pedir una persona o avisar una emergencia nunca se «resuelve solo». */
    expect(motivoDeRespuesta({ estado: 'CORRELACIONADA', seleccionId: 'TALK_TO_HUMAN' }, true)).toBe('SOLICITUD_EXPLICITA');
    expect(motivoDeRespuesta({ estado: 'CORRELACIONADA', seleccionId: 'EMERGENCY' }, true)).toBe('EMERGENCIA');
  });

  it('un id que no salió de nuestra oferta nunca es un pedido explícito', () => {
    /* `seleccionId` solo lo pone `guardarRespuesta` tras correlacionar; sin él, revisión. */
    expect(motivoDeRespuesta({ estado: 'NO_CORRELACIONADA', seleccionId: 'TALK_TO_HUMAN' })).toBe('REVISION');
  });

  it('la prioridad sale del motivo; CRITICA solo la da una emergencia declarada', () => {
    expect(prioridadDeMotivo('EMERGENCIA')).toBe('CRITICA');
    expect(prioridadDeMotivo('SOLICITUD_EXPLICITA')).toBe('ALTA');
    expect(prioridadDeMotivo('SOLICITUD_CITA')).toBe('NORMAL');
    expect(prioridadDeMotivo('REVISION')).toBe('NORMAL');
  });

  it('una solicitud viva solo sube de motivo', () => {
    expect(subeMotivo(null, 'REVISION')).toBe(true);
    expect(subeMotivo('REVISION', 'SOLICITUD_EXPLICITA')).toBe(true);
    expect(subeMotivo('SOLICITUD_EXPLICITA', 'SOLICITUD_CITA')).toBe(false);
    expect(subeMotivo('SOLICITUD_CITA', 'SOLICITUD_CITA')).toBe(false);
    expect(subeMotivo('SOLICITUD_EXPLICITA', 'EMERGENCIA')).toBe(true);
    expect(subeMotivo('EMERGENCIA', 'SOLICITUD_EXPLICITA')).toBe(false);
  });

  it('el estado sale de las fechas', () => {
    const t = new Date();
    expect(estadoDeAtencion({ atencionSolicitadaEn: null, atencionTomadaEn: null })).toBeNull();
    expect(estadoDeAtencion({ atencionSolicitadaEn: t, atencionTomadaEn: null })).toBe('ESPERANDO');
    expect(estadoDeAtencion({ atencionSolicitadaEn: t, atencionTomadaEn: t })).toBe('EN_ATENCION');
  });
});

describe('pedir a una persona escribiendo', () => {
  it.each([
    'Quiero hablar con una persona',
    'quiero hablar con una persona.',
    '¿Puedo hablar con alguien?',
    'Hola, quiero hablar con alguien de la clínica',
    'necesito hablar con recepción',
    'Hablar con un humano',
    'hablar con una persona real por favor',
    'Buenas tardes, quisiera hablar con una asesora',
    'ME GUSTARÍA HABLAR CON UN AGENTE',
  ])('«%s» es un pedido', texto => {
    expect(esPedidoDePersona(texto)).toBe(true);
  });

  it.each([
    'no quiero hablar con una persona que me cobre más',
    'quiero hablar con una persona sobre mi cita del martes',
    'hablar con recepción sobre mi cita',
    'quiero hablar con una persona o con un robot',
    'quiero bajar de peso',
    'me duele mucho el pecho',
    'persona',
    'humano',
    'hola',
    '',
    'quiero hablar con una persona'.repeat(10),
  ])('«%s» no lo es', texto => {
    expect(esPedidoDePersona(texto)).toBe(false);
  });

  it('no detecta urgencias ni asuntos médicos: no es un clasificador', () => {
    for (const texto of ['necesito ayuda urgente', 'es una emergencia', 'me siento muy mal', 'sangrado después de la cirugía']) {
      expect(esPedidoDePersona(texto)).toBe(false);
    }
  });
});

describe('decir que es una emergencia escribiendo', () => {
  it.each([
    'Es una emergencia',
    'es una emergencia!!',
    'EMERGENCIA',
    'Hola, tengo una emergencia',
    'hay una emergencia por favor',
    'es una urgencia médica',
    'Urgente',
    'es muy urgente',
    'Auxilio',
    'ayuda urgente por favor',
  ])('«%s» es un aviso de emergencia', texto => {
    expect(esAvisoDeEmergencia(texto)).toBe(true);
  });

  it.each([
    'no es una emergencia, solo una consulta',
    'es una emergencia? quiero saber el precio',
    'necesito una cita urgente',
    'me siento muy mal',
    'sangrado después de la cirugía',
    'emergencia'.repeat(20),
    '',
    '¿Hay emergencia?',
    '¿es urgente?',
    'urgencia?',
  ])('«%s» no lo es: solo cuenta la frase entera, no se clasifica nada', texto => {
    expect(esAvisoDeEmergencia(texto)).toBe(false);
  });
});
