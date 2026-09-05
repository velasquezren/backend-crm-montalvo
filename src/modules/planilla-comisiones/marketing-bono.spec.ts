import { AreaVendedora, TipoVendedora } from '../../prisma/prisma-client';

import { redondear } from './clasificador';
import { aporteAlPoteJefatura, cobraSinVender, repartirPote } from './reglas-calculo';

/**
 * El pago del equipo de marketing, que el sistema no hacía.
 *
 * Cristel y Araceli cobran la mitad del pote de jefatura cada una, pero **no
 * venden**: no tienen `vendedora_pk`, no aparecen en ninguna fila del export de
 * FileMaker y por tanto nunca llegaban a la liquidación. El cálculo descartaba
 * a quien no tuviera ventas (`if (suyas.length === 0) continue`), así que el
 * filtro por área de `aplicarBonos()` no encontraba a nadie y el pote de
 * publicidad se repartía entre cero personas: 66,69 USD (464,83 Bs) que la
 * planilla real SÍ paga y el sistema no, sin fallar ni avisar.
 *
 * Las cifras salen de `CALCULO COMISION DICIEMBRE 2025.xlsx`:
 *   hoja "CALCULO BONOS" filas 18-22 (el pote), 23 (la jefa) y 47-51 (marketing)
 *   hoja "GRAL COM" filas 75-76 (las dos como filas de planilla, comisión 0)
 */

const MARKETING = { tipo: TipoVendedora.VENDEDORA, area: AreaVendedora.PUBLICIDAD };
const JEFA = { tipo: TipoVendedora.JEFA, area: AreaVendedora.EJECUTIVA };
const EJECUTIVA = { tipo: TipoVendedora.VENDEDORA, area: AreaVendedora.EJECUTIVA };
const COORDINADORA_RA = { tipo: TipoVendedora.VENDEDORA, area: AreaVendedora.RA };

describe('cobraSinVender', () => {
  it('marketing entra en la planilla aunque no venda: es todo lo que cobra', () => {
    expect(cobraSinVender(MARKETING)).toBe(true);
  });

  /* Su bono también sale del pote del equipo, no de lo suyo: un mes sin vender
     no puede dejarla fuera de la planilla. */
  it('la jefa también', () => {
    expect(cobraSinVender(JEFA)).toBe(true);
  });

  /* Una ejecutiva sin ventas no cobra nada por comisión, así que una fila suya
     con todo en cero sería ruido en la planilla que se firma. */
  it('una ejecutiva sin ventas NO entra', () => {
    expect(cobraSinVender(EJECUTIVA)).toBe(false);
  });

  it('una coordinadora de RA tampoco: cobra por procedimiento realizado', () => {
    expect(cobraSinVender(COORDINADORA_RA)).toBe(false);
  });
});

describe('repartirPote · diciembre 2025', () => {
  /* El pote real del mes, reconstruido desde los excedentes de las cuatro
     ejecutivas (hoja "CALCULO BONOS", filas 18-21). */
  const pote = redondear(
    aporteAlPoteJefatura(26641.39, 15000, 0.002) + // Viviana
      aporteAlPoteJefatura(20759.43, 12000, 0.002) + // Yelca
      aporteAlPoteJefatura(18843.4, 12000, 0.002) + // Zuany
      aporteAlPoteJefatura(18098.82, 12000, 0.002), // Claudia
  );

  it('el pote del mes es el 66,69 USD de la planilla', () => {
    expect(pote).toBeCloseTo(66.69, 2);
  });

  /* El número que el sistema no pagaba. Dos personas en marketing → 33,35 cada
     una, que es exactamente lo que dice la hoja: 232,41 Bs al TC del mes. */
  it('con las dos de marketing, cada una cobra la mitad del pote', () => {
    const reparto = repartirPote(pote, 1, 2);

    expect(redondear(reparto.porPublicidad)).toBeCloseTo(33.35, 2);
    expect(redondear(reparto.porPublicidad * 6.97)).toBeCloseTo(232.41, 1);
  });

  /* El pote se paga DOS veces, no se parte en dos mitades: la jefa cobra los
     66,69 enteros y marketing otros 66,69 entre las dos. */
  it('la jefa cobra el pote ÍNTEGRO, no la mitad', () => {
    const reparto = repartirPote(pote, 1, 2);

    expect(redondear(reparto.porJefa)).toBeCloseTo(66.69, 2);
    expect(redondear(reparto.porPublicidad * 2)).toBeCloseTo(66.69, 1);
  });

  /* El estado en el que estaba el sistema hasta ahora: nadie de marketing en la
     liquidación. La jefa cobraba igual y el otro pote no se pagaba — que es
     correcto como reparto, pero es la señal de que falta darlas de alta (el
     cálculo deja un aviso en el log). */
  it('sin nadie en marketing, la jefa cobra igual y ese pote no se paga', () => {
    const reparto = repartirPote(pote, 1, 0);

    expect(redondear(reparto.porJefa)).toBeCloseTo(66.69, 2);
    expect(reparto.porPublicidad).toBe(0);
  });

  /* Y al revés: un lado vacío no le regala su parte al otro. Son dos pagos
     independientes que salen del mismo número, no una bolsa común. */
  it('sin jefa, marketing cobra lo suyo y nada más', () => {
    const reparto = repartirPote(pote, 0, 2);

    expect(reparto.porJefa).toBe(0);
    expect(redondear(reparto.porPublicidad)).toBeCloseTo(33.35, 2);
  });

  it('un mes en el que nadie supera su objetivo no paga bonos', () => {
    const reparto = repartirPote(0, 1, 2);

    expect(reparto).toEqual({ porJefa: 0, porPublicidad: 0 });
  });

  /* Si mañana entra una tercera persona a marketing, el mismo pote se reparte
     entre tres sin tocar código. */
  it('el pote se divide entre las que haya, sean dos o tres', () => {
    const reparto = repartirPote(90, 1, 3);

    expect(reparto.porPublicidad).toBe(30);
  });
});
