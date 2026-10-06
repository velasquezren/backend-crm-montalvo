import { EstadoPromocion } from '../../prisma/prisma-client';
import {
  ACCIONES_PROMOCION,
  faltantesParaPublicar,
  generarCodigo,
  mensajeDeWhatsapp,
  problemaDeBanner,
  PromocionParaPublicar,
  puedeEditar,
  TRANSICIONES,
  vigenciaDe,
} from './promocion-reglas';

const dia = (t: string) => new Date(`${t}T00:00:00Z`);
const HOY = dia('2026-10-13');
const lista = (cambios: Partial<PromocionParaPublicar> = {}): PromocionParaPublicar => ({
  titulo: 'Control prenatal',
  resumen: 'Tres controles con ecografía',
  condiciones: 'Válido hasta fin de mes. Incluye tres controles.',
  etiquetaOferta: '-20 %',
  precioRegular: 600,
  precioPromocional: 480,
  vigenteDesde: dia('2026-10-01'),
  vigenteHasta: dia('2026-10-31'),
  enLanding: true,
  enWhatsapp: true,
  formatos: ['CUADRADO'],
  ...cambios,
});

describe('reglas de promociones', () => {
  it('una promoción completa no tiene faltantes', () => {
    expect(faltantesParaPublicar(lista(), HOY)).toEqual([]);
  });

  it.each<[string, Partial<PromocionParaPublicar>, RegExp]>([
    ['sin banner cuadrado', { formatos: ['HORIZONTAL'] }, /banner Cuadrado/],
    ['con precio y sin condiciones', { condiciones: '  ' }, /condiciones/],
    ['promocional no menor', { precioPromocional: 600 }, /menor que el regular/],
    ['vencida', { vigenteHasta: dia('2026-10-12') }, /ya terminó/],
    ['sin canal', { enLanding: false, enWhatsapp: false }, /al menos un canal/],
  ])('%s', (_, cambios, motivo) => {
    expect(faltantesParaPublicar(lista(cambios), HOY).join(' ')).toMatch(motivo);
  });

  it('sin precio ni oferta, las condiciones no son obligatorias', () => {
    expect(faltantesParaPublicar(lista({ precioRegular: null, precioPromocional: null, etiquetaOferta: null, condiciones: '' }), HOY)).toEqual([]);
  });

  it('vigencia en días de La Paz, inclusiva', () => {
    expect(vigenciaDe(dia('2026-10-14'), null, HOY)).toBe('PROXIMA');
    expect(vigenciaDe(dia('2026-10-13'), dia('2026-10-13'), HOY)).toBe('VIGENTE');
    expect(vigenciaDe(dia('2026-10-01'), null, HOY)).toBe('VIGENTE');
    expect(vigenciaDe(dia('2026-10-01'), dia('2026-10-12'), HOY)).toBe('VENCIDA');
  });

  it('banners: proporción con 2 % de holgura y medidas mínimas', () => {
    expect(problemaDeBanner('CUADRADO', 1080, 1080)).toBeNull();
    expect(problemaDeBanner('VERTICAL', 1080, 1351)).toBeNull();
    expect(problemaDeBanner('CUADRADO', 1080, 1350)).toMatch(/proporción/);
    expect(problemaDeBanner('CUADRADO', 800, 800)).toMatch(/al menos 1080×1080/);
    expect(problemaDeBanner('HORIZONTAL', 1200, 628)).toBeNull();
    expect(problemaDeBanner('HISTORIA', 1080, 1920)).toBeNull();
  });

  it('una agente edita solo borradores; un admin todo salvo lo archivado', () => {
    const estados: EstadoPromocion[] = ['BORRADOR', 'EN_REVISION', 'PUBLICADA', 'PAUSADA', 'ARCHIVADA'];
    expect(estados.filter(e => puedeEditar(e, false))).toEqual(['BORRADOR']);
    expect(estados.filter(e => puedeEditar(e, true))).toEqual(['BORRADOR', 'EN_REVISION', 'PUBLICADA', 'PAUSADA']);
  });

  it('solo «enviar» es de una agente; publicar, devolver, pausar y archivar son de un admin', () => {
    expect(ACCIONES_PROMOCION.filter(a => TRANSICIONES[a].rango === 'AGENTE')).toEqual(['enviar']);
    expect(TRANSICIONES.archivar.desde).not.toContain('ARCHIVADA');
  });

  it('el código es legible por teléfono y viaja en el mensaje de WhatsApp', () => {
    const codigos = Array.from({ length: 200 }, generarCodigo);
    for (const c of codigos) expect(c).toMatch(/^PRM-[2-9A-HJ-KMNP-Z]{5}$/);
    expect(mensajeDeWhatsapp('Control prenatal', 'PRM-7K3QX')).toBe('Hola, me interesa la promoción «Control prenatal» (PRM-7K3QX).');
  });
});
