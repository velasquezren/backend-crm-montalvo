import { interpretar } from './alertas-whatsapp.service';

/**
 * Los `value` de estas pruebas están copiados de los ejemplos de la referencia
 * oficial de Meta (webhooks reference: account_update,
 * phone_number_quality_update, message_template_status_update), no inventados.
 * Si Meta cambia la forma, estas pruebas son lo que debería avisarlo.
 */
describe('interpretar avisos de plataforma de WhatsApp', () => {
  describe('account_update — lo que de verdad rompe el canal', () => {
    it('una restricción es crítica y nombra qué quedó restringido', () => {
      const aviso = interpretar('account_update', {
        event: 'ACCOUNT_RESTRICTION',
        restriction_info: [
          { restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING', expiration: 1641330498 },
          { restriction_type: 'RESTRICTED_ADD_PHONE_NUMBER_ACTION', expiration: 1641330498 },
        ],
      });

      expect(aviso?.nivel).toBe('critico');
      expect(aviso?.mensaje).toContain('RESTRICTED_BIZ_INITIATED_MESSAGING');
    });

    it('una violación de políticas es crítica y dice de qué tipo', () => {
      const aviso = interpretar('account_update', {
        event: 'ACCOUNT_VIOLATION',
        violation_info: { violation_type: 'ADULT' },
      });

      expect(aviso?.nivel).toBe('critico');
      expect(aviso?.mensaje).toContain('ADULT');
    });

    it('una cuenta deshabilitada es crítica e incluye el estado del baneo', () => {
      const aviso = interpretar('account_update', {
        event: 'DISABLED_UPDATE',
        ban_info: { waba_ban_state: 'REINSTATE', waba_ban_date: 'April 17, 2025' },
      });

      expect(aviso?.nivel).toBe('critico');
      expect(aviso?.mensaje).toContain('REINSTATE');
    });

    it('una cuenta eliminada es crítica', () => {
      expect(interpretar('account_update', { event: 'ACCOUNT_DELETED' })?.nivel).toBe('critico');
    });

    it('los eventos administrativos NO despiertan a nadie', () => {
      /* Que se comparta la cuenta con un partner no le importa a la clínica a
         las tres de la mañana: queda en el log y nada más. */
      expect(interpretar('account_update', { event: 'PARTNER_ADDED' })?.nivel).toBe('info');
      expect(interpretar('account_update', { event: 'AUTH_INTL_PRICE_ELIGIBILITY_UPDATE' })?.nivel).toBe(
        'info',
      );
    });

    it('un evento vacío no genera ni una línea', () => {
      expect(interpretar('account_update', {})).toBeNull();
    });
  });

  describe('phone_number_quality_update — ya NO es la alarma de calidad', () => {
    /* Desde el 7 de octubre de 2025 el estado FLAGGED dejó de existir y una
       caída de calidad ya no baja el límite. Este webhook quedó para cambios de
       throughput, así que solo informa: quien avisa de problemas es
       account_update. Esta prueba existe para que nadie lo vuelva a promover a
       crítico por costumbre. */
    it('una subida de throughput es informativa, no crítica', () => {
      const aviso = interpretar('phone_number_quality_update', {
        event: 'THROUGHPUT_UPGRADE',
        current_limit: 'TIER_UNLIMITED',
      });

      expect(aviso?.nivel).toBe('info');
      expect(aviso?.mensaje).toContain('TIER_UNLIMITED');
    });

    it('prefiere el límite nuevo por portafolio sobre el campo que Meta retira', () => {
      /* `current_limit` desaparece en febrero de 2026 en favor de
         `max_daily_conversations_per_business`. */
      const aviso = interpretar('phone_number_quality_update', {
        event: 'THROUGHPUT_UPGRADE',
        current_limit: 'TIER_250',
        max_daily_conversations_per_business: 'TIER_2K',
      });

      expect(aviso?.mensaje).toContain('TIER_2K');
      expect(aviso?.mensaje).not.toContain('TIER_250');
    });
  });

  describe('message_template_status_update', () => {
    it('una plantilla rechazada es crítica y trae el motivo', () => {
      const aviso = interpretar('message_template_status_update', {
        event: 'REJECTED',
        message_template_name: 'promo_especialidad',
        reason: 'INVALID_FORMAT',
      });

      expect(aviso?.nivel).toBe('critico');
      expect(aviso?.mensaje).toContain('promo_especialidad');
      expect(aviso?.mensaje).toContain('INVALID_FORMAT');
    });

    it('una plantilla aprobada solo informa', () => {
      expect(
        interpretar('message_template_status_update', {
          event: 'APPROVED',
          message_template_name: 'recordatorio_cita',
        })?.nivel,
      ).toBe('info');
    });
  });

  it('un campo que no gestionamos se ignora', () => {
    expect(interpretar('messages', { event: 'lo que sea' })).toBeNull();
    expect(interpretar(undefined, {})).toBeNull();
  });
});
