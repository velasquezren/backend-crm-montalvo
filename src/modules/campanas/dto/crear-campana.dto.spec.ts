import { ValidationPipe } from '@nestjs/common';
import { CrearCampanaDto } from './crear-campana.dto';

const valido = {
  nombre: 'Campaña Gold', lineaId: '00000000-0000-4000-8000-000000000001',
  plantilla: 'promo', idioma: 'es', variables: [],
  filtro: { categorias: ['GOLD'], diasSinCampana: 30, soloConversaron: false },
  tarifaUsd: 0.055, elegiblesVistas: 1,
};
const pipe = new ValidationPipe({ transform: true, whitelist: true });
const validar = (body: unknown) => pipe.transform(body, { type: 'body', metatype: CrearCampanaDto });

describe('contrato HTTP de creación de campañas', () => {
  it.each([undefined, null, {}, []])('rechaza filtros ausentes o incompletos (%p) antes del servicio', async filtro => {
    await expect(validar({ ...valido, filtro })).rejects.toMatchObject({ status: 400 });
  });

  it('valida longitudes después de recortar los textos', async () => {
    await expect(validar({ ...valido, nombre: '   ' })).rejects.toMatchObject({ status: 400 });
    await expect(validar({ ...valido, variables: [{ tipo: 'TEXTO', texto: '  ' }] })).rejects.toMatchObject({ status: 400 });
    expect(await validar({ ...valido, nombre: '  Campaña Gold  ' })).toMatchObject({ nombre: 'Campaña Gold', filtro: valido.filtro });
  });
});
