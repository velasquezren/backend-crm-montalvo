import { ConfigService } from '@nestjs/config';

import { AcuseAutomaticoService } from './acuse-automatico.service';

/**
 * La decisión del acuse no toca base ni red, así que se prueba aquí en
 * milisegundos en vez de en la suite de integración.
 *
 * Horario real de la clínica: los agentes de WhatsApp entran a las 9:00, el
 * sábado salen a las 13:00 y el domingo no trabajan. Las fechas van en UTC y
 * La Paz es UTC-4, así que 13:00Z = 09:00 en Bolivia.
 */
describe('AcuseAutomaticoService', () => {
  const HORARIO_REAL = 'L-V:09:00-19:00,S:09:00-13:00';

  function servicio(extra: Record<string, string> = {}) {
    const logger = { warn: jest.fn() };
    const s = new AcuseAutomaticoService(
      new ConfigService({
        AUTORESPUESTA_TEXTO: 'Gracias por escribir a Clínica Montalvo.',
        AUTORESPUESTA_HORARIO: HORARIO_REAL,
        AUTORESPUESTA_ZONA: 'America/La_Paz',
        ...extra,
      }),
    );
    Object.assign(s, { logger });
    return { s, logger };
  }

  /** Fecha UTC a partir de la hora local de La Paz (UTC-4, sin horario de verano). */
  const laPaz = (iso: string) => new Date(`${iso}-04:00`);

  it('calla en horario de atención', () => {
    // Martes 11:00 de La Paz.
    expect(servicio().s.decidir(laPaz('2026-08-11T11:00:00'))).toBeNull();
  });

  it('responde de madrugada entre semana', () => {
    // Martes 03:00: nadie en el chat.
    expect(servicio().s.decidir(laPaz('2026-08-11T03:00:00'))).not.toBeNull();
  });

  it('responde el domingo entero aunque la clínica esté abierta', () => {
    /* La distinción que importa del negocio: la clínica atiende los domingos,
       las agentes de WhatsApp no. */
    expect(servicio().s.decidir(laPaz('2026-08-09T11:00:00'))).not.toBeNull();
  });

  it('el sábado calla a las 12:00 y responde a las 14:00', () => {
    const { s } = servicio();
    expect(s.decidir(laPaz('2026-08-08T12:00:00'))).toBeNull();
    expect(s.decidir(laPaz('2026-08-08T14:00:00'))).not.toBeNull();
  });

  it('queda apagado si no hay texto configurado', () => {
    /* Sin texto no se inventa uno: el mensaje lleva el teléfono de urgencias. */
    expect(servicio({ AUTORESPUESTA_TEXTO: '   ' }).s.decidir(laPaz('2026-08-11T03:00:00'))).toBeNull();
  });

  it('ante un horario mal escrito calla y deja aviso en el log', () => {
    const { s, logger } = servicio({ AUTORESPUESTA_HORARIO: 'todos los días' });
    expect(s.decidir(laPaz('2026-08-11T03:00:00'))).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('degrada a texto plano si los botones no son válidos para Meta', () => {
    const { s } = servicio({ AUTORESPUESTA_BOTONES: 'Uno|Dos|Tres|Cuatro' });
    expect(s.decidir(laPaz('2026-08-11T03:00:00'))?.botones).toBeNull();
  });

  it('lleva botones cuando están bien configurados', () => {
    const { s } = servicio({ AUTORESPUESTA_BOTONES: 'Agendar cita|Resultados' });
    expect(s.decidir(laPaz('2026-08-11T03:00:00'))?.botones).toEqual([
      'Agendar cita',
      'Resultados',
    ]);
  });

  it('la espera entre acuses cae a 12 h si la variable no es un número', () => {
    expect(servicio({ AUTORESPUESTA_ESPERA_HORAS: 'muchas' }).s.esperaHoras).toBe(12);
    expect(servicio({ AUTORESPUESTA_ESPERA_HORAS: '6' }).s.esperaHoras).toBe(6);
  });

  describe('decidirPedidoDatos', () => {
    it('apagado si no hay AUTORESPUESTA_PEDIDO_DATOS configurado', () => {
      expect(servicio().s.decidirPedidoDatos()).toBeNull();
    });

    it('apagado si está vacío o solo espacios', () => {
      expect(servicio({ AUTORESPUESTA_PEDIDO_DATOS: '   ' }).s.decidirPedidoDatos()).toBeNull();
    });

    it('devuelve el texto configurado, recortado', () => {
      expect(
        servicio({ AUTORESPUESTA_PEDIDO_DATOS: '  Decinos tu nombre y edad, porfa  ' }).s.decidirPedidoDatos(),
      ).toBe('Decinos tu nombre y edad, porfa');
    });

    /* A diferencia de decidir(), no depende de la hora ni del horario: el
       clic en el botón puede llegar de madrugada o ya en horario de atención. */
    it('no depende de la hora', () => {
      const { s } = servicio({ AUTORESPUESTA_PEDIDO_DATOS: 'Nombre y edad, porfa' });
      expect(s.decidirPedidoDatos()).toBe('Nombre y edad, porfa');
    });
  });
});
