import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

/*
 * El aislamiento de las pruebas (`test/aislamiento-pruebas.cjs`) se prueba a sí
 * mismo: si alguien lo quita de la configuración de jest o lo debilita, esto
 * falla. Ver el motivo en la cabecera de ese archivo.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const aislamiento = require('../test/aislamiento-pruebas.cjs') as {
  motivoDeBaseNoPermitida: (url: string) => string | null;
  esDestinoLocal: (host?: string) => boolean;
};

describe('aislamiento de las pruebas', () => {
  it('se cargó antes de esta prueba', () => {
    expect(process.env['CRM_PRUEBAS_AISLADAS']).toBe('1');
  });

  describe('el .env real no se lee', () => {
    const dotenv = path.resolve(__dirname, '..', '.env');

    it('existsSync dice que no existe, aunque exista en disco', () => {
      expect(fs.existsSync(dotenv)).toBe(false);
    });

    it('readFileSync lanza ENOENT en lugar de devolver credenciales', () => {
      expect(() => fs.readFileSync(dotenv)).toThrow(/ENOENT/);
    });

    it('no confunde otros archivos: .env.example sigue legible', () => {
      expect(fs.existsSync(path.resolve(__dirname, '..', '.env.example'))).toBe(true);
    });
  });

  it('no quedan credenciales en process.env', () => {
    const sospechosas = Object.keys(process.env).filter(k =>
      /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|API_?KEY|ACCESS_?KEY|APP_ID|WABA|PHONE_ID|VERIFY)/i.test(k),
    );
    expect(sospechosas).toEqual([]);
  });

  describe('la base de pruebas', () => {
    it.each([
      'postgresql://crm_app:x@localhost:5433/crm_test?schema=public',
      'postgresql://crm_app@127.0.0.1:5433/crm_test',
      'postgresql://u@[::1]:5432/otra_test',
    ])('acepta %s', url => {
      expect(aislamiento.motivoDeBaseNoPermitida(url)).toBeNull();
    });

    it.each([
      ['postgresql://crm_app:x@107.175.132.15:5432/crm_test', /no es loopback/],
      ['postgresql://crm_app:x@db.interna.example:5432/crm_test', /no es loopback/],
      ['postgresql://crm_app:x@localhost:5432/crm', /no termina en _test/],
      ['postgresql://crm_app:x@localhost:5432/crm_produccion', /no termina en _test/],
      ['esto no es una url', /no es una URL válida/],
    ])('rechaza %s', (url, motivo) => {
      expect(aislamiento.motivoDeBaseNoPermitida(url)).toMatch(motivo);
    });
  });

  describe('ninguna conexión sale de la máquina', () => {
    /* Destinos reservados (RFC 6761 / TEST-NET): aunque la guarda fallara, no llegarían a ningún servidor real. */
    it.each(['graph.facebook.invalid', 'crm.nip.invalid', '192.0.2.1', '198.51.100.7'])(
      'una conexión TCP a %s lanza antes de abrir el socket',
      host => {
        expect(() => net.connect({ host, port: 443 })).toThrow(/Prueba bloqueada/);
      },
    );

    it('fetch hacia Meta falla y no llega a la red', async () => {
      await expect(fetch('https://graph.facebook.invalid/v21.0/123/messages', { method: 'POST' })).rejects.toThrow();
    });

    it('loopback sigue permitido: las pruebas HTTP y Postgres locales dependen de eso', async () => {
      const servidor = net.createServer(s => s.end());
      await new Promise<void>(ok => servidor.listen(0, '127.0.0.1', ok));
      const { port } = servidor.address() as net.AddressInfo;
      await new Promise<void>((ok, mal) => {
        const s = net.connect({ host: '127.0.0.1', port }, () => { s.end(); ok(); });
        s.on('error', mal);
      });
      await new Promise<void>(ok => servidor.close(() => ok()));
    });

    it('la lista de destinos locales es cerrada', () => {
      expect(aislamiento.esDestinoLocal('localhost')).toBe(true);
      expect(aislamiento.esDestinoLocal('graph.facebook.invalid')).toBe(false);
      expect(aislamiento.esDestinoLocal('127.0.0.1.evil.example')).toBe(false);
    });
  });
});
