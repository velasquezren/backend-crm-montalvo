import { constants, createCipheriv, createDecipheriv, generateKeyPairSync, publicEncrypt, randomBytes } from 'node:crypto';
import { cifrarRespuestaFlow, descifrarPeticionFlow, ErrorDeCifradoFlow } from './cifrado-flow';
import { abrirTokenFlow, sellarTokenFlow } from './token-flow';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

/** Lo que hace el cliente de WhatsApp: clave AES nueva, cifrada con nuestra llave pública. */
function comoMeta(datos: unknown) {
  const clave = randomBytes(16);
  const vector = randomBytes(16);
  const c = createCipheriv('aes-128-gcm', clave, vector);
  const cuerpo = Buffer.concat([c.update(JSON.stringify(datos), 'utf8'), c.final(), c.getAuthTag()]);
  return {
    clave, vector,
    peticion: {
      encrypted_flow_data: cuerpo.toString('base64'),
      encrypted_aes_key: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, clave).toString('base64'),
      initial_vector: vector.toString('base64'),
    },
  };
}

describe('cifrado del endpoint de Flows', () => {
  it('descifra la petición y cifra la respuesta con el vector invertido, como espera Meta', () => {
    const { peticion, clave, vector } = comoMeta({ action: 'ping', version: '3.0' });
    const d = descifrarPeticionFlow(peticion, privateKey);
    expect(d.datos).toEqual({ action: 'ping', version: '3.0' });
    const respuesta = Buffer.from(cifrarRespuestaFlow({ data: { status: 'active' } }, d.clave, d.vector), 'base64');
    const descifrador = createDecipheriv('aes-128-gcm', clave, Buffer.from(vector.map(b => b ^ 0xff)));
    descifrador.setAuthTag(respuesta.subarray(respuesta.length - 16));
    const claro = Buffer.concat([descifrador.update(respuesta.subarray(0, respuesta.length - 16)), descifrador.final()]);
    expect(JSON.parse(claro.toString('utf8'))).toEqual({ data: { status: 'active' } });
  });

  it('una petición alterada o con otra llave no se descifra (421 para que el cliente refresque)', () => {
    const { peticion } = comoMeta({ action: 'INIT' });
    const alterada = { ...peticion, encrypted_flow_data: Buffer.from('x'.repeat(40)).toString('base64') };
    expect(() => descifrarPeticionFlow(alterada, privateKey)).toThrow(ErrorDeCifradoFlow);
    const otra = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    expect(() => descifrarPeticionFlow(peticion, otra)).toThrow(ErrorDeCifradoFlow);
  });
});

describe('token del Flow', () => {
  const original = process.env['WHATSAPP_INTERACCIONES_KEY'];
  beforeAll(() => { process.env['WHATSAPP_INTERACCIONES_KEY'] = randomBytes(32).toString('base64'); });
  afterAll(() => { process.env['WHATSAPP_INTERACCIONES_KEY'] = original; });

  it('lleva el teléfono sellado, cabe en 256 caracteres y vence a las 24 h', () => {
    const ahora = Date.now();
    const token = sellarTokenFlow('59170012345', ahora);
    expect(token.length).toBeLessThanOrEqual(256);
    expect(token).not.toContain('70012345');
    expect(abrirTokenFlow(token, ahora)).toEqual({ telefono: '59170012345', vence: ahora + 86_400_000 });
    expect(abrirTokenFlow(token, ahora + 86_400_001)).toBeNull();
  });

  it('uno alterado, ajeno o de otro tipo no abre', () => {
    const token = sellarTokenFlow('59170012345');
    const partes = token.split('.');
    expect(abrirTokenFlow([...partes.slice(0, 3), partes[3].slice(0, -2) + 'AA'].join('.'))).toBeNull();
    expect(abrirTokenFlow(randomBytes(32).toString('hex'))).toBeNull(); // la correlación aleatoria de otros Flows
    expect(abrirTokenFlow(undefined)).toBeNull();
    expect(() => sellarTokenFlow('70012345; drop')).toThrow();
  });
});
