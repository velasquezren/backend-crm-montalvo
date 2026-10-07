import { Module, Type } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AgendaConsultaClient } from './agenda-consulta.client';
import { tipoDeComprobante } from './agenda-reservas-crm.service';
import { AgendaVpsClient } from './agenda-vps.client';

describe('las cuentas de la agenda se inyectan con su configuración', () => {
  /* Heredar el constructor de `LectorAgenda` dejaba a Nest sin ConfigService: con
     `new` funcionaba, por inyección `config` llegaba undefined y la landing caía en 500. */
  it.each<Type<AgendaVpsClient | AgendaConsultaClient>>([AgendaVpsClient, AgendaConsultaClient])('%p', async Cliente => {
    @Module({
      imports: [ConfigModule.forRoot({ ignoreEnvFile: true, load: [() => ({ AGENDA_VPS_LECTURA: 'off', AGENDA_VPS_CONSULTA: 'off' })] })],
      providers: [Cliente],
    })
    class ModuloCliente {}
    const modulo = await NestFactory.createApplicationContext(ModuloCliente, { logger: false });
    const cliente = modulo.get(Cliente);
    expect(() => cliente.habilitada()).not.toThrow();
    expect(cliente.habilitada()).toBe(false);
    await expect(cliente.ejecutar(async () => 1)).rejects.toMatchObject({ status: 503 });
    await modulo.close();
  });
});

describe('tipo real de un comprobante', () => {
  it.each([
    ['ffd8ffe000104a464946', 'image/jpeg'],
    ['89504e470d0a1a0a0000', 'image/png'],
    ['47494638396101000100', 'image/gif'],
    ['524946462400000057454250565038', 'image/webp'],
    ['255044462d312e370a25', 'application/pdf'],
  ])('%s → %s', (hex, tipo) => {
    expect(tipoDeComprobante(Buffer.from(hex, 'hex'))?.tipo).toBe(tipo);
  });

  it('lo que no es imagen ni PDF no se entrega, diga lo que diga su nombre', () => {
    expect(tipoDeComprobante(Buffer.from('<svg onload="x">', 'utf8'))).toBeNull();
    expect(tipoDeComprobante(Buffer.from('00112233', 'hex'))).toBeNull();
    expect(tipoDeComprobante(Buffer.alloc(0))).toBeNull();
  });
});
