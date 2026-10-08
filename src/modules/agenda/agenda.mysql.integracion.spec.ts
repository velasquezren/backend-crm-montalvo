import { Global, INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { createConnection, RowDataPacket } from 'mysql2/promise';
import { constants, createCipheriv, createDecipheriv, createHmac, generateKeyPairSync, publicEncrypt, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sellarTokenFlow } from '../../common/whatsapp/flows/token-flow';
import { readFileSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo, connect } from 'node:net';
import { AuditModule } from '../../common/audit/audit.module';
import { imagenSintetica } from '../../common/storage/imagen-sintetica';
import { UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { DirectorioService } from '../directorio/directorio.service';
import { AgendaMedicosCrmService } from './agenda-medicos-crm.service';
import { AgendaReservasCrmService } from './agenda-reservas-crm.service';
import { AgendaModule } from './agenda.module';
import { AgendaReservasService } from './agenda-reservas.service';
import { abrirCierreReserva } from '../../common/whatsapp/flows/token-flow';
import { AgendaVpsClient } from './agenda-vps.client';

// Suite separada: scripts/probar-agenda-mysql.sh crea y destruye SU MySQL.
const ejecutar = process.env.AGENDA_MYSQL_TEST === 'on' ? describe : describe.skip;
const VALORES = {
  AGENDA_VPS_LECTURA: 'on', AGENDA_VPS_RESERVAS: 'on', AGENDA_MYSQL_HOST: '127.0.0.1', AGENDA_MYSQL_PUERTO: '3307',
  AGENDA_MYSQL_USUARIO: 'crm_agenda_lectura', AGENDA_MYSQL_PASSWORD: 'solo-pruebas-sinteticas-no-produccion-2026',
  AGENDA_RESERVA_USUARIO: 'crm_agenda_reserva', AGENDA_RESERVA_PASSWORD: 'solo-pruebas-sinteticas-reserva-no-produccion-2026',
  AGENDA_RESERVA_SECRETO: 'secreto-sintetico-de-referencias-de-pago-2026',
  AGENDA_VPS_CONSULTA: 'on', AGENDA_CONSULTA_USUARIO: 'crm_agenda_consulta',
  AGENDA_CONSULTA_PASSWORD: 'solo-pruebas-sinteticas-consulta-no-produccion-2026',
  AGENDA_VPS_ADMIN: 'on', AGENDA_ADMIN_USUARIO: 'crm_agenda_admin',
  AGENDA_ADMIN_PASSWORD: 'solo-pruebas-sinteticas-admin-no-produccion-2026',
  AGENDA_MYSQL_CA_ARCHIVO: process.env.AGENDA_MYSQL_TEST_CA ?? '',
  AGENDA_MYSQL_TLS_IDENTIDAD: 'MySQL_Server_8.0.44_Auto_Generated_Server_Certificate',
};
/* Flow de reserva: llave sintética del endpoint, secreto de la app y clave de interacciones, solo de prueba. */
const LLAVES_FLOW = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ARCHIVO_LLAVE_FLOW = join(tmpdir(), `montalvo-flow-${process.pid}.pem`);
writeFileSync(ARCHIVO_LLAVE_FLOW, LLAVES_FLOW.privateKey.export({ type: 'pkcs8', format: 'pem' }));
const SECRETO_APP_META = 'secreto-sintetico-de-la-app-de-meta';
Object.assign(VALORES, {
  WHATSAPP_FLOWS_LLAVE_ARCHIVO: ARCHIVO_LLAVE_FLOW,
  META_APP_SECRET: SECRETO_APP_META,
  WHATSAPP_INTERACCIONES_KEY: randomBytes(32).toString('base64'),
});
const config = new ConfigService(VALORES);
/* La pantalla Reservas también lee Postgres (el chat y la constancia del comprobante): la base descartable. */
const prisma = new PrismaService('postgresql://crm_app@127.0.0.1:5433/crm_test');
@Global()
@Module({ providers: [{ provide: PrismaService, useValue: prisma }], exports: [PrismaService] })
class PrismaPrueba {}
@Module({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), PrismaPrueba, AuditModule, AgendaModule], providers: [] })
class ModuloPrueba {}

const PNG_QR = imagenSintetica('png', 400, 400);
const WEBP_FOTO = imagenSintetica('webp', 400, 500);

function fecha(dias: number) {
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/La_Paz', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return new Date(Date.parse(`${hoy}T00:00:00Z`) + dias * 86400000).toISOString().slice(0, 10);
}

ejecutar('Agenda HTTP → adaptador TLS → MySQL real descartable', () => {
  let app: INestApplication;
  let base: string;
  let qr: Server;
  beforeAll(async () => {
    // Valores sintéticos por entorno del proceso de prueba; nunca se lee un .env.
    qr = createServer((req, res) => {
      if (req.url === '/img/QR%20sintetico.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG_QR); return; }
      if (req.url === '/img/Foto%20sintetica.webp') { res.writeHead(200, { 'content-type': 'image/webp' }); res.end(WEBP_FOTO); return; }
      res.writeHead(404); res.end();
    });
    await new Promise<void>(listo => qr.listen(0, '127.0.0.1', listo));
    Object.assign(process.env, VALORES, { AGENDA_QR_BASE_URL: `http://127.0.0.1:${(qr.address() as AddressInfo).port}/img/` });
    app = await NestFactory.create(ModuloPrueba, { logger: false, rawBody: true });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); qr?.close(); await prisma.$disconnect(); });
  const get = (ruta: string) => fetch(`${base}/publico/agenda/${ruta}`);

  it('catálogo real paginado y proyección sin campos privados', async () => {
    const r = await get('especialidades');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const p = await r.json() as { total: number; datos: { id: string; nombre: string }[] };
    expect(p.total).toBe(2);
    const especialidad = p.datos.find(e => e.nombre === 'Especialidad sintética')!;
    const med = await (await get(`medicos?especialidadId=${especialidad.id}`)).json() as { datos: Record<string, unknown>[] };
    expect(med.datos).toHaveLength(2);
    expect(med.datos[0].precio).toEqual({ importeCentavos: 40025, moneda: 'BOB' });
    expect(med.datos[1].precio).toBeNull();
    expect(Object.keys(med.datos[0]).sort()).toEqual(['especialidadId','fotoUrl','horarioInformativo','id','modalidad','nombre','precio']);
    expect(med.datos[0].fotoUrl).toMatch(/^\/publico\/agenda\/fotos\/1\/[0-9a-f]{16}$/);
    expect(med.datos[1].fotoUrl).toBeNull();
    expect(JSON.stringify(med)).not.toMatch(/secreto|privado|<b>|paciente/);
  });
  it('un médico por su número, con su especialidad: lo que abre la reserva desde su ficha web', async () => {
    const r = await get('medicos/1');
    expect(r.status).toBe(200);
    const cuerpo = await r.json() as { medico: Record<string, unknown>; especialidad: { id: string; nombre: string } };
    expect(cuerpo.especialidad.nombre).toBe('Especialidad sintética');
    expect(cuerpo.medico).toMatchObject({ id: '1', especialidadId: cuerpo.especialidad.id, modalidad: 'ONLINE' });
    expect(JSON.stringify(cuerpo)).not.toMatch(/secreto|privado|<b>|paciente/);
    expect(((await (await get('medicos/3')).json()) as { medico: { modalidad: string } }).medico.modalidad).toBe('A_SOLICITUD');
    for (const id of ['4', '999']) expect((await get(`medicos/${id}`)).status).toBe(404); // inactivo, inexistente
    expect((await get('medicos/1%27')).status).toBe(400);
  });

  it('ocupan solo las citas vigentes de agenda_med (CREADO) y las reservas web PENDIENTE/PAGADO', async () => {
    const r = await get(`disponibilidad?medicoId=1&fecha=${fecha(1)}`);
    const d = await r.json() as { estado: string; horarios: { hora: string }[] };
    expect(r.status).toBe(200);
    expect(d.estado).toBe('DISPONIBLE');
    // 09:00 CREADO en agenda_med ocupa; 10:00 BORRADO (cita anulada en FileMaker) NO:
    // la vista de ScriptCase la seguía dando por ocupada para siempre.
    // 13:00 PENDIENTE en para_agendar ocupa; 11:00 ATENDIDO (ya gestionada) no.
    expect(d.horarios.map(h => h.hora)).toEqual(['10:00', '11:00', '14:00', '15:00']);
  });
  it('la foto del médico se sirve por el CRM, solo con su versión y solo si está activo', async () => {
    const med = await (await get(`medicos?especialidadId=${(await (await get('especialidades')).json() as { datos: { id: string; nombre: string }[] }).datos.find(e => e.nombre === 'Especialidad sintética')!.id}`)).json() as { datos: { id: string; fotoUrl: string | null }[] };
    const url = med.datos.find(m => m.id === '1')!.fotoUrl!;
    const r = await fetch(`${base}${url}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/webp');
    expect(r.headers.get('cache-control')).toContain('immutable');
    expect(r.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(Buffer.compare(Buffer.from(await r.arrayBuffer()), WEBP_FOTO)).toBe(0);
    expect((await fetch(`${base}${url.replace(/[0-9a-f]{16}$/, '0000000000000000')}`)).status).toBe(404);
    expect((await fetch(`${base}${url.replace('/fotos/1/', '/fotos/4/')}`)).status).toBe(404);
    expect((await fetch(`${base}/publico/agenda/fotos/1/..%2F..%2Fetc`)).status).toBe(404);
  });
  it('los días ofrecidos son solo los que tienen al menos una hora libre', async () => {
    const dias = async (id: number) => ((await (await get(`dias?medicoId=${id}`)).json()) as { fechas: string[] }).fechas;
    // El horario sintético es un solo día de la semana: se repite cada 7 días en los 30 de la vista.
    // Dos médicos seguidos por la MISMA conexión: así se vio que MySQL 8.0.44 re-ejecuta mal la
    // sentencia preparada de horasLibres (la segunda ignoraba las citas). Por eso va con query().
    expect(await dias(1)).toEqual([fecha(1), fecha(8), fecha(15), fecha(22), fecha(29)]);
    expect(await dias(2)).toEqual([fecha(8), fecha(15), fecha(22), fecha(29)]); // el día 1 tiene su única hora ocupada
    expect(await dias(3)).toEqual([]); // a solicitud
    expect((await get('dias?medicoId=4')).status).toBe(503); // inactivo
  });
  it('distingue sin cupos, sin atención y a solicitud', async () => {
    for (const [id, dias, estado] of [[2,1,'SIN_CUPOS'],[1,2,'SIN_ATENCION'],[3,1,'A_SOLICITUD']] as const) {
      const d = await (await get(`disponibilidad?medicoId=${id}&fecha=${fecha(dias)}`)).json() as { estado: string; horarios: unknown[] };
      expect(d.estado).toBe(estado); expect(d.horarios).toEqual([]);
    }
  });
  it('fecha fuera de horizonte, inexistente y payload inválido no acceden como cupos', async () => {
    for (const consulta of [`medicoId=1&fecha=${fecha(30)}`, 'medicoId=1&fecha=2026-02-30', `medicoId=1%27OR1&fecha=${fecha(1)}`]) {
      expect((await get(`disponibilidad?${consulta}`)).status).toBe(400);
    }
    expect((await get(`disponibilidad?medicoId=4&fecha=${fecha(1)}`)).status).toBe(503);
  });
  it('el usuario real del adaptador no puede leer privados ni escribir', async () => {
    const conn = await createConnection({
      host: config.getOrThrow<string>('AGENDA_MYSQL_TLS_IDENTIDAD'),
      stream: () => connect({ host: '127.0.0.1', port: 3307 }),
      user: 'crm_agenda_lectura', password: 'solo-pruebas-sinteticas-no-produccion-2026', database: 'clinica',
      ssl: { ca: readFileSync(process.env.AGENDA_MYSQL_TEST_CA!), rejectUnauthorized: true, verifyIdentity: true },
    });
    try {
      for (const sql of ['SELECT password FROM medicos','SELECT paciente FROM agenda_med','SELECT ci_age FROM para_agendar',"UPDATE medicos SET nombre='Cambio no autorizado' WHERE 1=0"]) {
        await expect(conn.query(sql)).rejects.toMatchObject({ code: expect.stringMatching(/ACCESS_DENIED/) });
      }
      const [rows] = await conn.query("SHOW STATUS LIKE 'Ssl_cipher'");
      expect(JSON.stringify(rows)).toMatch(/TLS|AES/);
    } finally { await conn.end(); }
  });
  it('reconecta tras destruir el pool y conserva el catálogo en el VPS', async () => {
    // Cliente nuevo representa un proceso nuevo, sin necesitar estado persistido.
    const nuevo = new AgendaVpsClient(config);
    try { expect(await nuevo.leer('especialidades', new URLSearchParams({pagina:'1',limite:'25'}))).toMatchObject({total:2}); }
    finally { await nuevo.onModuleDestroy(); }
  });
  it('una identidad TLS incorrecta falla cerrada', async () => {
    // ConfigService prioriza el entorno del proceso: se cambia ahí, y se restaura.
    const original = process.env.AGENDA_MYSQL_TLS_IDENTIDAD;
    process.env.AGENDA_MYSQL_TLS_IDENTIDAD = 'servidor-incorrecto.invalid';
    const incorrecto = new AgendaVpsClient(new ConfigService());
    try { await expect(incorrecto.leer('especialidades', new URLSearchParams({pagina:'1',limite:'25'}))).rejects.toMatchObject({status:503}); }
    finally { process.env.AGENDA_MYSQL_TLS_IDENTIDAD = original; await incorrecto.onModuleDestroy(); }
  });
  /* ── Reservas: escriben en para_agendar como ScriptCase ─────────────── */

  const conexionRoot = () => createConnection({ host: '127.0.0.1', port: 3307, user: 'root', database: 'clinica', dateStrings: true });
  const reservar = (cuerpo: Record<string, string>) => fetch(`${base}/publico/agenda/reservas`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ medicoId: '1', fecha: fecha(1), nombre: '  Paciente   Web ', telefono: '+591 70012345', ci: '1234567 SC', observaciones: 'Primera consulta', ...cuerpo }),
  });
  const pagar = (referencia: string, archivo: Buffer, nit = '1234567') => {
    const form = new FormData();
    form.append('referencia', referencia);
    form.append('nit', nit);
    form.append('razonSocial', 'Razón sintética');
    form.append('comprobante', new Blob([Uint8Array.from(archivo)], { type: 'image/png' }), 'comprobante.png');
    return fetch(`${base}/publico/agenda/reservas/pago`, { method: 'POST', body: form });
  };
  let referencia = '';
  let codigo = 0;

  it('reserva con las mismas columnas y valores que el formulario de ScriptCase', async () => {
    const r = await reservar({ hora: '14:00' });
    expect(r.status).toBe(201);
    const cuerpo = await r.json() as { codigo: number; referencia: string; estado: string; pago: unknown; medico: string };
    expect(cuerpo).toMatchObject({ estado: 'PENDIENTE', medico: 'Profesional sintético A', pago: { precio: { importeCentavos: 40025, moneda: 'BOB' }, bancoId: 7 } });
    expect(cuerpo.codigo).toBe(6); // MAX(para_age) + 1, como ScriptCase
    ({ referencia, codigo } = cuerpo);
    const db = await conexionRoot();
    try {
      const [[fila]] = await db.query<RowDataPacket[]>('SELECT * FROM para_agendar WHERE para_age = ?', [codigo]);
      const hoy = fecha(0);
      expect(fila).toMatchObject({
        medico_pk: 1, fecha: fecha(1), hora: '14:00:00', nombre_age: 'Paciente Web', telefono_age: '70012345',
        ci_age: '1234567 SC', obs: 'Primera consulta', estado: 'PENDIENTE', nom_med: 'Profesional sintético A',
        uno: 1, fecha_registro: hoy, nit: '', razon_social: '', precio_con: '400.25', banco: 7, comprobante: null, sucursal: null,
      });
    } finally { await db.end(); }
    // La hora deja de ofrecerse.
    const d = await (await get(`disponibilidad?medicoId=1&fecha=${fecha(1)}`)).json() as { horarios: { hora: string }[] };
    expect(d.horarios.map(h => h.hora)).toEqual(['10:00', '11:00', '15:00']);
  });

  it('una hora ocupada (agenda_med, reserva web o ya pasada) no se reserva', async () => {
    for (const hora of ['09:00', '13:00', '14:00', '12:00']) {
      const r = await reservar({ hora });
      expect(r.status).toBe(409);
      expect(await r.json()).toMatchObject({ codigo: 'HORA_NO_DISPONIBLE' });
    }
    expect((await reservar({ hora: '11:00', medicoId: '4' })).status).toBe(404);
    expect((await reservar({ hora: '11:00', sitio: 'https://spam.invalid' })).status).toBe(400);
    expect((await reservar({ hora: '11:00', telefono: '22223333' })).status).toBe(400);
  });

  it('dos pacientes confirmando la misma hora a la vez: una sola la obtiene', async () => {
    const [a, b] = await Promise.all([reservar({ hora: '15:00', nombre: 'Paciente A' }), reservar({ hora: '15:00', nombre: 'Paciente B' })]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const db = await conexionRoot();
    try {
      const [[{ total }]] = await db.query<RowDataPacket[]>("SELECT COUNT(*) AS total FROM para_agendar WHERE medico_pk = 1 AND fecha = ? AND hora = '15:00:00'", [fecha(1)]);
      expect(Number(total)).toBe(1);
    } finally { await db.end(); }
  });

  it('el comprobante deja la reserva en PAGADO (a verificar) una sola vez', async () => {
    const archivo = imagenSintetica('png', 600, 900);
    const r = await pagar(referencia, archivo);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ codigo, estado: 'PAGADO' });
    const db = await conexionRoot();
    try {
      const [[fila]] = await db.query<RowDataPacket[]>('SELECT estado, nit, razon_social, comprobante FROM para_agendar WHERE para_age = ?', [codigo]);
      expect(fila.estado).toBe('PAGADO');
      expect(fila.nit).toBe('1234567');
      expect(fila.razon_social).toBe('Razón sintética');
      expect(Buffer.compare(fila.comprobante as Buffer, archivo)).toBe(0);
    } finally { await db.end(); }
    expect((await pagar(referencia, archivo)).status).toBe(409);
    // Referencia manipulada (otro id con la firma del primero) o un archivo que no es imagen.
    const [, vence, firma] = referencia.split('.');
    expect((await pagar(`1.${vence}.${firma}`, archivo)).status).toBe(410);
    expect((await pagar(referencia, Buffer.from('%PDF-1.4 no es una imagen'))).status).toBe(400);
  });

  it('el usuario de reservas solo puede lo que hace ScriptCase', async () => {
    const conn = await createConnection({
      host: config.getOrThrow<string>('AGENDA_MYSQL_TLS_IDENTIDAD'),
      stream: () => connect({ host: '127.0.0.1', port: 3307 }),
      user: 'crm_agenda_reserva', password: VALORES.AGENDA_RESERVA_PASSWORD, database: 'clinica',
      ssl: { ca: readFileSync(process.env.AGENDA_MYSQL_TEST_CA!), rejectUnauthorized: true, verifyIdentity: true },
    });
    try {
      for (const sql of [
        'SELECT password FROM medicos', 'SELECT telefono_age FROM para_agendar', 'SELECT comprobante FROM para_agendar',
        'SELECT paciente FROM agenda_med', "UPDATE para_agendar SET nombre_age = 'x' WHERE 1=0", 'DELETE FROM para_agendar WHERE 1=0',
        "UPDATE medicos SET precio_con = 1 WHERE 1=0", "INSERT INTO agenda_med (cod_med) VALUES ('x')",
      ]) {
        await expect(conn.query(sql)).rejects.toMatchObject({ code: expect.stringMatching(/ACCESS_DENIED|DENIED/) });
      }
    } finally { await conn.end(); }
  });

  it('el QR del banco del médico se sirve por HTTPS del CRM; uno vencido no', async () => {
    const r = await fetch(`${base}/publico/agenda/qr/7`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(Buffer.compare(Buffer.from(await r.arrayBuffer()), PNG_QR)).toBe(0);
    expect((await fetch(`${base}/publico/agenda/qr/8`)).status).toBe(404);
    expect((await fetch(`${base}/publico/agenda/qr/99`)).status).toBe(404);
  });
  /* ── Flow de WhatsApp «Reservar una cita»: endpoint cifrado ────────── */

  /** Lo que hace WhatsApp: cifra con nuestra llave pública, Meta firma con el App Secret. */
  async function pantallaDelFlow(peticion: Record<string, unknown>, firma = true) {
    const clave = randomBytes(16);
    const vector = randomBytes(16);
    const c = createCipheriv('aes-128-gcm', clave, vector);
    const datos = Buffer.concat([c.update(JSON.stringify({ version: '3.0', ...peticion }), 'utf8'), c.final(), c.getAuthTag()]);
    const cuerpo = JSON.stringify({
      encrypted_flow_data: datos.toString('base64'),
      encrypted_aes_key: publicEncrypt({ key: LLAVES_FLOW.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, clave).toString('base64'),
      initial_vector: vector.toString('base64'),
    });
    const r = await fetch(`${base}/whatsapp/flows/agenda`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', firma ? SECRETO_APP_META : 'otro').update(cuerpo).digest('hex')}` },
      body: cuerpo,
    });
    if (r.status !== 200) return { status: r.status, respuesta: null as Record<string, unknown> | null };
    const cifrada = Buffer.from(await r.text(), 'base64');
    const d = createDecipheriv('aes-128-gcm', clave, Buffer.from(vector.map(b => b ^ 0xff)));
    d.setAuthTag(cifrada.subarray(cifrada.length - 16));
    const claro = Buffer.concat([d.update(cifrada.subarray(0, cifrada.length - 16)), d.final()]).toString('utf8');
    return { status: 200, respuesta: JSON.parse(claro) as Record<string, unknown> };
  }

  it('Flow de reserva: de la especialidad a la reserva en para_agendar, cifrado de punta a punta', async () => {
    expect((await pantallaDelFlow({ action: 'ping' })).respuesta).toEqual({ data: { status: 'active' } });
    process.env['WHATSAPP_INTERACCIONES'] = 'on';
    process.env['WHATSAPP_INTERACCIONES_LINEAS'] = 'linea-flow-sintetica';
    const token = sellarTokenFlow('59170012345', Date.now(), 'linea-flow-sintetica');
    type Opcion = { id: string; title: string; description?: string };
    const paso = async (data: Record<string, unknown>) => (await pantallaDelFlow({ action: 'data_exchange', flow_token: token, screen: 'X', data })).respuesta as { screen: string; data: Record<string, unknown> };

    const inicio = (await pantallaDelFlow({ action: 'INIT', flow_token: token })).respuesta as { screen: string; data: { especialidades: Opcion[] } };
    expect(inicio.screen).toBe('ESPECIALIDAD');
    // Solo especialidades con médicos que se reservan en línea: «Otra especialidad» es a solicitud.
    expect(inicio.data.especialidades.map(e => e.title)).toEqual(['Especialidad sintética']);
    const medicosPantalla = await paso({ paso: 'especialidad', especialidad: inicio.data.especialidades[0].id });
    expect(medicosPantalla.screen).toBe('MEDICO');
    expect((medicosPantalla.data['medicos'] as Opcion[]).map(m => m.id)).toEqual(['1', '2']);
    const fechas = await paso({ paso: 'medico', especialidad: inicio.data.especialidades[0].id, medico: '1' });
    expect(fechas.screen).toBe('FECHA');
    expect((fechas.data['fechas'] as Opcion[])[0].id).toBe(fecha(1));
    const datos = await paso({ paso: 'fecha', medico: '1', fecha: fecha(1) });
    expect(datos.screen).toBe('DATOS');
    // 09:00 cita vigente, 13:00/14:00 reservas web PENDIENTE, 15:00 la otra: quedan 10:00 (cita anulada) y 11:00.
    expect((datos.data['horas'] as Opcion[]).map(h => h.id)).toEqual(['10:00', '11:00']);
    expect(datos.data['precio']).toBe('Consulta: Bs 400,25');

    // Un carnet con símbolos vuelve a la misma pantalla con aviso y lo escrito precargado.
    const mal = await paso({ paso: 'confirmar', medico: '1', fecha: fecha(1), hora: '10:00', nombre: 'Paciente Flow', ci: '12*34', observaciones: '' });
    expect(mal).toMatchObject({ screen: 'DATOS', data: { hay_aviso: true, nombre: 'Paciente Flow', ci: '12*34' } });

    const fin = await paso({ paso: 'confirmar', medico: '1', fecha: fecha(1), hora: '10:00', nombre: '  Paciente   Flow ', ci: '7654321', observaciones: 'Control' });
    expect(fin.screen).toBe('SUCCESS');
    const params = (fin.data['extension_message_response'] as { params: Record<string, string> }).params;
    expect(params).toMatchObject({ flow_token: token, flow_version: 'reserva-cita.v1' });
    expect(params['resumen']).toContain('10:00');
    expect(abrirCierreReserva(params['pago'], token)).toMatchObject({ telefono:'59170012345', reserva:Number(params['reserva']), montoCentavos:null, qrClave:null });
    const db = await conexionRoot();
    try {
      const [[fila]] = await db.query<RowDataPacket[]>('SELECT * FROM para_agendar WHERE para_age = ?', [Number(params['reserva'])]);
      expect(fila).toMatchObject({ medico_pk: 1, fecha: fecha(1), hora: '10:00:00', nombre_age: 'Paciente Flow', telefono_age: '70012345', ci_age: '7654321', obs: 'Control', estado: 'PENDIENTE', uno: 1 });
    } finally { await db.end(); }

    // La misma hora otra vez: ya está tomada, vuelve con las horas al día.
    const tarde = await paso({ paso: 'confirmar', medico: '1', fecha: fecha(1), hora: '10:00', nombre: 'Otra paciente', ci: '1112223', observaciones: '' });
    expect(tarde).toMatchObject({ screen: 'DATOS', data: { hay_aviso: true, aviso: 'Esa hora acaba de ocuparse. Elige otra.' } });
    expect((tarde.data['horas'] as Opcion[]).map(h => h.id)).toEqual(['11:00']);
  });

  it('Flow de reserva: token ajeno 427, cifrado roto 421, firma falsa 403; un celular extranjero no reserva', async () => {
    expect((await pantallaDelFlow({ action: 'INIT', flow_token: 'token-inventado' })).status).toBe(427);
    expect((await pantallaDelFlow({ action: 'INIT', flow_token: sellarTokenFlow('59170012345', Date.now(), 'linea-flow-sintetica') }, false)).status).toBe(403);
    const roto = await fetch(`${base}/whatsapp/flows/agenda`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', SECRETO_APP_META).update('{"encrypted_flow_data":"AAAAAAAAAAAAAAAAAAAAAAAA","encrypted_aes_key":"AAAAAAAAAAAAAAAAAAAAAAAA","initial_vector":"AAAAAAAAAAAA"}').digest('hex')}` },
      body: '{"encrypted_flow_data":"AAAAAAAAAAAAAAAAAAAAAAAA","encrypted_aes_key":"AAAAAAAAAAAAAAAAAAAAAAAA","initial_vector":"AAAAAAAAAAAA"}',
    });
    expect(roto.status).toBe(421);
    const extranjero = (await pantallaDelFlow({ action: 'data_exchange', flow_token: sellarTokenFlow('15551948320', Date.now(), 'linea-flow-sintetica'), data: { paso: 'confirmar', medico: '1', fecha: fecha(1), hora: '11:00', nombre: 'Prueba', ci: '1234567' } })).respuesta;
    expect(extranjero).toMatchObject({ screen: 'DATOS', data: { aviso: expect.stringContaining('celulares de Bolivia') } });
  });

  describe('pantalla Reservas del CRM (cuenta de consulta, solo lectura)', () => {
    const TELEFONO = '+59170987654';
    let reservas: AgendaReservasCrmService;
    const usuarios: Record<'recepcion' | 'conAcceso' | 'sinAcceso', UsuarioJwt> = {} as never;
    let chat: string;

    async function limpiar() {
      const ids = (await prisma.usuario.findMany({ where: { email: { endsWith: '@agenda-crm.test' } }, select: { id: true } })).map(u => u.id);
      await prisma.auditLog.deleteMany({ where: { OR: [{ usuarioId: { in: ids } }, { entidad: 'ReservaAgenda' }] } });
      await prisma.cliente.deleteMany({ where: { telefono: TELEFONO } });
      await prisma.lineaWhatsapp.deleteMany({ where: { nombre: 'AGENDA-CRM-ventas' } });
      await prisma.usuario.deleteMany({ where: { id: { in: ids } } });
    }
    beforeAll(async () => {
      reservas = app.get(AgendaReservasCrmService);
      await limpiar();
      const linea = await prisma.lineaWhatsapp.create({ data: { nombre: 'AGENDA-CRM-ventas', telefono: '+59170009901', phoneNumberId: 'meta-agenda-crm', tokenEnv: 'TOKEN_INEXISTENTE_AGENDA', comercial: true } });
      const definiciones = [['recepcion', 'RECEPCION', true], ['conAcceso', 'AGENTE', true], ['sinAcceso', 'AGENTE', false]] as const;
      for (const [clave, rol, acceso] of definiciones) {
        const u = await prisma.usuario.create({ data: {
          nombre: `Persona ${clave}`, email: `${clave}@agenda-crm.test`, passwordHash: 'sin-uso', rol, activo: true,
          ...(acceso ? { lineasWhatsapp: { create: { lineaId: linea.id } } } : {}),
        } });
        usuarios[clave] = { sub: u.id, email: u.email, nombre: u.nombre, rol };
      }
      const cliente = await prisma.cliente.create({ data: { nombre: 'Paciente de agenda sintética', telefono: TELEFONO } });
      chat = (await prisma.conversacion.create({ data: { clienteId: cliente.id, lineaId: linea.id } })).id;
    });
    afterAll(limpiar);

    it('lista el rango con la cuenta por estado, el precio en centavos y el teléfono listo para abrir su chat', async () => {
      const r = await reservas.listar({ desde: fecha(2), hasta: fecha(3) }, usuarios.recepcion);
      expect(r).toMatchObject({ total: 2, desde: fecha(2), hasta: fecha(3), porEstado: { PAGADO: 1, PENDIENTE: 1 } });
      expect(r.datos.map(d => d.id)).toEqual([2, 3]);
      expect(r.datos[0]).toMatchObject({
        estado: 'PAGADO', paciente: 'María Sintética', medico: 'Profesional sintético A', especialidad: 'Especialidad sintética',
        precio: { importeCentavos: 40025, moneda: 'BOB' }, telefono: '+591 709-87654', telefonoE164: TELEFONO,
        nit: '123456', razonSocial: 'Razón sintética', tieneComprobante: true, hora: '09:00',
      });
      /* Sin rango: hoy y los próximos 30 días; lo de ayer no aparece. */
      const porDefecto = await reservas.listar({}, usuarios.recepcion);
      expect(porDefecto.desde).toBe(fecha(0));
      expect(porDefecto.datos.map(d => d.id)).toEqual(expect.arrayContaining([2, 3]));
      expect(porDefecto.datos.map(d => d.id)).not.toContain(4);
    });

    it('filtra por estado y busca por nombre (con % literal), carnet, número o teléfono con cualquier formato', async () => {
      /* Mañana tiene las reservas que crean las pruebas de arriba: los estados se miran en los días 2 y 3. */
      const soloSinteticas = { desde: fecha(2), hasta: fecha(3) };
      expect((await reservas.listar({ ...soloSinteticas, estado: 'PAGADO' }, usuarios.recepcion)).datos.map(d => d.id)).toEqual([2]);
      const rango = { desde: fecha(-1), hasta: fecha(3) };
      const ids = async (extra: Record<string, string>) => (await reservas.listar({ ...rango, ...extra }, usuarios.recepcion)).datos.map(d => d.id);
      expect(await ids({ buscar: '100%' })).toEqual([3]);
      expect(await ids({ buscar: '%' })).toEqual([3]);
      expect(await ids({ buscar: '111222' })).toEqual([4, 2]);
      expect(await ids({ buscar: '709 87 654' })).toEqual([4, 2, 3]);
      expect(await ids({ buscar: '3' })).toEqual(expect.arrayContaining([3]));
      /* El filtro de estado no cambia la cuenta por estado: los chips siguen mostrando todo el rango. */
      expect((await reservas.listar({ ...soloSinteticas, estado: 'PAGADO' }, usuarios.recepcion)).porEstado).toEqual({ PAGADO: 1, PENDIENTE: 1 });
    });

    it('la agenda completa no la ve una agente de ventas; un rango imposible o de más de un trimestre se rechaza', async () => {
      await expect(reservas.listar({}, usuarios.conAcceso)).rejects.toMatchObject({ status: 403 });
      await expect(reservas.listar({ desde: '2026-02-31' }, usuarios.recepcion)).rejects.toMatchObject({ status: 400 });
      await expect(reservas.listar({ desde: fecha(3), hasta: fecha(2) }, usuarios.recepcion)).rejects.toMatchObject({ status: 400 });
      await expect(reservas.listar({ desde: fecha(0), hasta: fecha(92) }, usuarios.recepcion)).rejects.toMatchObject({ status: 400 });
      expect((await reservas.listar({ desde: fecha(0), hasta: fecha(91) }, usuarios.recepcion)).hasta).toBe(fecha(91));
    });

    it('desde el chat: las próximas de esa paciente (con y sin 591), solo para quien puede ver el chat', async () => {
      const deAgente = await reservas.deConversacion(chat, usuarios.conAcceso);
      expect(deAgente.map(r => r.id)).toEqual([2, 3]);
      await expect(reservas.deConversacion(chat, usuarios.sinAcceso)).rejects.toMatchObject({ status: 404 });
      await expect(reservas.deConversacion('00000000-0000-4000-8000-000000000000', usuarios.recepcion)).rejects.toMatchObject({ status: 404 });
    });

    it('el comprobante se entrega por su tipo real y deja constancia de quién lo abrió', async () => {
      const archivo = await reservas.comprobante(2, usuarios.recepcion);
      expect(archivo.getHeaders()).toMatchObject({ type: 'image/png', disposition: 'inline; filename="comprobante-2.png"' });
      const partes: Buffer[] = [];
      for await (const parte of archivo.getStream()) partes.push(Buffer.from(parte as Uint8Array));
      expect(Buffer.concat(partes).subarray(0, 4).toString('hex')).toBe('89504e47');
      expect(await prisma.auditLog.count({ where: { entidad: 'ReservaAgenda', entidadId: '2', accion: 'COMPROBANTE_AGENDA_VISTO', usuarioId: usuarios.recepcion.sub } })).toBe(1);
      await expect(reservas.comprobante(3, usuarios.recepcion)).rejects.toMatchObject({ status: 415 });
      await expect(reservas.comprobante(4, usuarios.recepcion)).rejects.toMatchObject({ status: 404 });
      await expect(reservas.comprobante(2, usuarios.conAcceso)).rejects.toMatchObject({ status: 403 });
    });

    it('el usuario de consulta solo lee lo que la pantalla muestra: no escribe ni ve otras tablas', async () => {
      const conn = await createConnection({
        host: config.getOrThrow<string>('AGENDA_MYSQL_TLS_IDENTIDAD'),
        stream: () => connect({ host: '127.0.0.1', port: 3307 }),
        user: 'crm_agenda_consulta', password: 'solo-pruebas-sinteticas-consulta-no-produccion-2026', database: 'clinica',
        ssl: { ca: readFileSync(process.env.AGENDA_MYSQL_TEST_CA!), rejectUnauthorized: true, verifyIdentity: true },
      });
      try {
        for (const sql of [
          'SELECT paciente FROM agenda_med', 'SELECT password FROM medicos', 'SELECT banco FROM para_agendar',
          "UPDATE para_agendar SET estado = 'ATENDIDO' WHERE 1=0", 'DELETE FROM para_agendar WHERE 1=0',
          "INSERT INTO para_agendar (para_age) VALUES (999)",
        ]) {
          await expect(conn.query(sql)).rejects.toMatchObject({ code: expect.stringMatching(/ACCESS_DENIED/) });
        }
      } finally { await conn.end(); }
    });
  });

  describe('Directorio del CRM: médicos y horarios de la agenda (cuenta de administración)', () => {
    let medicos: AgendaMedicosCrmService;
    const usuarios: Record<'recepcion' | 'asistente' | 'agente', UsuarioJwt> = {} as never;
    const datos = { nombre: 'Profesional editado', sigla: 'Dra.', especialidad: 'Especialidad sintética', telefono: null, estado: 'ACTIVO' as const, precio: '350.5', bancoId: 8, orden: 5 };

    async function limpiar() {
      const ids = (await prisma.usuario.findMany({ where: { email: { endsWith: '@agenda-admin.test' } }, select: { id: true } })).map(u => u.id);
      await prisma.auditLog.deleteMany({ where: { OR: [{ usuarioId: { in: ids } }, { entidad: { in: ['MedicoAgenda', 'EspecialidadAgenda'] } }] } });
      await prisma.usuario.deleteMany({ where: { id: { in: ids } } });
    }
    beforeAll(async () => {
      medicos = app.get(AgendaMedicosCrmService);
      await limpiar();
      for (const [clave, rol] of [['recepcion', 'RECEPCION'], ['asistente', 'ASISTENTE'], ['agente', 'AGENTE']] as const) {
        const u = await prisma.usuario.create({ data: { nombre: `Persona ${clave}`, email: `${clave}@agenda-admin.test`, passwordHash: 'sin-uso', rol, activo: true } });
        usuarios[clave] = { sub: u.id, email: u.email, nombre: u.nombre, rol };
      }
    });
    afterAll(limpiar);
    const filasDe = async <T,>(sql: string, valores: unknown[] = []) => {
      const db = await conexionRoot();
      try { return (await db.query<RowDataPacket[]>(sql, valores))[0] as T[]; } finally { await db.end(); }
    };

    it('lista activos e inactivos con su cuenta por estado, y las especialidades como están escritas', async () => {
      const r = await medicos.listar({}, usuarios.asistente);
      expect(r).toMatchObject({ total: 4, porEstado: { ACTIVO: 3, INACTIVO: 1 } });
      expect(r.datos.map(m => m.id)).toEqual([1, 2, 3, 4]);
      expect(r.datos[0]).toMatchObject({ codigo: 'A', reservaEnLinea: true, casillasActivas: 6, precio: '400.25', bancoId: 7 });
      // El teléfono del médico sí lo ve el personal; su login y contraseña, nunca.
      expect(JSON.stringify(r)).not.toMatch(/secreto|"privado"|login|password/);
      expect((await medicos.listar({ estado: 'INACTIVO' }, usuarios.recepcion)).datos.map(m => m.id)).toEqual([4]);
      expect((await medicos.listar({ buscar: 'solicitud' }, usuarios.recepcion)).datos.map(m => m.id)).toEqual([3]);
      const esp = await medicos.especialidades({});
      expect(esp.datos).toEqual([
        { nombre: 'Especialidad sintética', medicos: 2, activos: 2, pagina: null },
        { nombre: 'Oculta', medicos: 1, activos: 0, pagina: null },
        { nombre: 'Otra especialidad', medicos: 1, activos: 1, pagina: null },
      ]);
      expect(await medicos.bancos()).toEqual([
        { id: 7, nombre: 'Banco sintético', vence: fecha(30) }, { id: 8, nombre: 'Banco vencido', vence: fecha(-1) },
      ]);
    });

    it('un pico de pedidos a la vez (abrir el Directorio son tres) espera su turno: ninguno falla', async () => {
      // La cuenta usa 2 conexiones; sin la fila de espera, el tercer pedido salía 503 al azar.
      const pedidos = Array.from({ length: 8 }, (_, i) =>
        i % 3 === 0 ? medicos.listar({}, usuarios.recepcion) : i % 3 === 1 ? medicos.especialidades({}) : medicos.bancos(),
      );
      await expect(Promise.all(pedidos)).resolves.toHaveLength(8);
    });

    it('enciende casillas nuevas como el formulario de ScriptCase y regenera el recuadro de horario', async () => {
      const ficha = await medicos.ficha(3, usuarios.recepcion);
      expect(ficha.casillas).toEqual([]);
      expect(ficha.grilla.horas).toHaveLength(28);
      const activas = [
        { dia: 'Lunes', hora: '09:00' }, { dia: 'Lunes', hora: '09:30' }, { dia: 'Lunes', hora: '14:00' }, { dia: 'Sabado', hora: '10:00' },
      ] as const;
      const nueva = await medicos.guardarHorario(3, { version: ficha.version, activas: [...activas] }, usuarios.recepcion);
      expect(nueva.medico).toMatchObject({ reservaEnLinea: true, casillasActivas: 4 });
      const filas = await filasDe<Record<string, unknown>>('SELECT dia, hora, estado, orden, cod_med FROM horarios WHERE medico_pk = 3 ORDER BY dia, hora');
      expect(filas).toEqual([
        { dia: 'Lunes', hora: '09:00:00', estado: 'ACTIVO', orden: 0, cod_med: 'C' },
        { dia: 'Lunes', hora: '09:30:00', estado: 'ACTIVO', orden: 0, cod_med: 'C' },
        { dia: 'Lunes', hora: '14:00:00', estado: 'ACTIVO', orden: 0, cod_med: 'C' },
        { dia: 'Sabado', hora: '10:00:00', estado: 'ACTIVO', orden: 0, cod_med: 'C' },
      ]);
      const [{ horario_html: html }] = await filasDe<{ horario_html: string }>('SELECT horario_html FROM medicos WHERE medico_pk = 3');
      expect(html).toContain('>9:00-9:30</td>');
      expect(html).toContain('>14:00</td>');
      expect(html).toContain('>10:00</td>');
      // La web pública lo ofrece ya en línea: tiene días con horas libres.
      expect(((await (await get('dias?medicoId=3')).json()) as { fechas: string[] }).fechas.length).toBeGreaterThan(0);
      expect(await prisma.auditLog.count({ where: { entidad: 'MedicoAgenda', entidadId: '3', accion: 'HORARIO_AGENDA_GUARDADO', usuarioId: usuarios.recepcion.sub } })).toBe(1);
    });

    it('apagar casillas no borra filas; sin ninguna encendida el médico vuelve a «a solicitud»', async () => {
      let ficha = await medicos.ficha(3, usuarios.recepcion);
      ficha = await medicos.guardarHorario(3, { version: ficha.version, activas: [{ dia: 'Lunes', hora: '09:00' }] }, usuarios.recepcion);
      expect(ficha.casillas.map(c => [c.dia, c.hora, c.activa])).toEqual([
        ['Lunes', '09:00', true], ['Lunes', '09:30', false], ['Lunes', '14:00', false], ['Sabado', '10:00', false],
      ]);
      ficha = await medicos.guardarHorario(3, { version: ficha.version, activas: [] }, usuarios.recepcion);
      expect(ficha.medico.reservaEnLinea).toBe(false);
      expect(await filasDe('SELECT 1 FROM horarios WHERE medico_pk = 3')).toHaveLength(4);
      expect(((await (await get('dias?medicoId=3')).json()) as { fechas: string[] }).fechas).toEqual([]);
    });

    it('no guarda encima de un cambio que la persona no vio, ni casillas inventadas', async () => {
      const ficha = await medicos.ficha(3, usuarios.recepcion);
      await medicos.guardarHorario(3, { version: ficha.version, activas: [{ dia: 'Martes', hora: '08:00' }] }, usuarios.recepcion);
      await expect(medicos.guardarHorario(3, { version: ficha.version, activas: [] }, usuarios.recepcion))
        .rejects.toMatchObject({ status: 409 });
      await expect(medicos.actualizar(3, { ...datos, version: ficha.version }, usuarios.recepcion)).rejects.toMatchObject({ status: 409 });
      const actual = await medicos.ficha(3, usuarios.recepcion);
      await expect(medicos.guardarHorario(3, { version: actual.version, activas: [{ dia: 'Lunes', hora: '09:15' }] }, usuarios.recepcion))
        .rejects.toMatchObject({ status: 400 });
      // El rechazo no dejó nada a medias.
      expect((await medicos.ficha(3, usuarios.recepcion)).version).toBe(actual.version);
    });

    it('edita los datos sin tocar el código de FileMaker y deja constancia de antes y después', async () => {
      const ficha = await medicos.ficha(2, usuarios.recepcion);
      const editada = await medicos.actualizar(2, { ...datos, version: ficha.version }, usuarios.recepcion);
      expect(editada.medico).toMatchObject({ codigo: 'B', nombre: 'Profesional editado', sigla: 'Dra.', precio: '350.50', bancoId: 8, orden: 5 });
      const [fila] = await filasDe<Record<string, unknown>>('SELECT codigo, telefono, login, password FROM medicos WHERE medico_pk = 2');
      expect(fila).toEqual({ codigo: 'B', telefono: '', login: 'privado', password: 'secreto-sintetico' });
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { entidad: 'MedicoAgenda', entidadId: '2', accion: 'MEDICO_AGENDA_EDITADO' } });
      expect(audit.cambios).toMatchObject({ antes: { nombre: 'Profesional sintético B', precio: null, bancoId: 8 }, despues: { nombre: 'Profesional editado', precio: '350.5' } });
      await expect(medicos.actualizar(2, { ...datos, bancoId: 99, version: editada.version }, usuarios.recepcion)).rejects.toMatchObject({ status: 400 });
      await expect(medicos.actualizar(99, { ...datos, version: editada.version }, usuarios.recepcion)).rejects.toMatchObject({ status: 404 });
    });

    it('da de alta un médico con id MAX+1 y su código; un código repetido se rechaza', async () => {
      await expect(medicos.crear({ ...datos, codigo: 'a' }, usuarios.recepcion)).rejects.toMatchObject({ status: 409 });
      const nuevo = await medicos.crear({ ...datos, codigo: 'NUEVO-1', nombre: 'Profesional nuevo', precio: null, bancoId: null }, usuarios.recepcion);
      expect(nuevo.medico).toMatchObject({ id: 5, codigo: 'NUEVO-1', reservaEnLinea: false, casillasActivas: 0 });
      const [fila] = await filasDe<Record<string, unknown>>('SELECT * FROM medicos WHERE medico_pk = 5');
      expect(fila).toMatchObject({ codigo: 'NUEVO-1', nombre: 'Profesional nuevo', sigla: 'Dra.', telefono: '', estado: 'ACTIVO', horario_html: '', orden: 5, precio_con: null, banco: null, login: null, password: null });
      // Con código, ya puede recibir casillas.
      const ficha = await medicos.guardarHorario(5, { version: nuevo.version, activas: [{ dia: 'Viernes', hora: '16:00' }] }, usuarios.recepcion);
      expect(ficha.medico.casillasActivas).toBe(1);
      expect(await filasDe('SELECT 1 FROM horarios WHERE medico_pk = 5 AND cod_med = ?', ['NUEVO-1'])).toHaveLength(1);
    });

    it('la página web de cada especialidad se crea desde la agenda y la acompaña al renombrarla', async () => {
      await prisma.especialidad.deleteMany({ where: { nombre: { in: ['Oculta', 'Oculta renombrada', 'Especialidad sintética', 'Otra especialidad'] } } });
      // Solo las que existen en la agenda; escrita distinto («oculta») es la misma.
      expect(await medicos.crearPaginas(['oculta', 'Inventada'], usuarios.recepcion)).toEqual({ creadas: 1 });
      expect(await medicos.crearPaginas(['Oculta'], usuarios.recepcion)).toEqual({ creadas: 0 });
      await expect(medicos.crearPaginas(['Inventada'], usuarios.recepcion)).rejects.toMatchObject({ status: 404 });
      await expect(medicos.crearPaginas(['Oculta'], usuarios.asistente)).rejects.toMatchObject({ status: 403 });
      let pagina = (await medicos.especialidades({})).datos.find(e => e.nombre === 'Oculta')!.pagina!;
      expect(pagina).toMatchObject({ nombre: 'Oculta', slug: 'oculta', activa: true, publicados: 0 }); // con el nombre de la agenda
      await medicos.actualizarPagina(pagina.id, { descripcion: 'Descripción sintética' }, usuarios.recepcion);
      // Renombrar en la agenda renombra la página; su dirección no cambia.
      await medicos.renombrarEspecialidad({ actual: 'Oculta', nueva: 'Oculta renombrada' }, usuarios.recepcion);
      pagina = (await medicos.especialidades({})).datos.find(e => e.nombre === 'Oculta renombrada')!.pagina!;
      expect(pagina).toMatchObject({ nombre: 'Oculta renombrada', slug: 'oculta', descripcion: 'Descripción sintética' });
      await medicos.renombrarEspecialidad({ actual: 'Oculta renombrada', nueva: 'Oculta' }, usuarios.recepcion);
      await prisma.especialidad.deleteMany({ where: { id: pagina.id } });
    });

    it('renombrar una especialidad la unifica en todos sus médicos', async () => {
      expect(await medicos.renombrarEspecialidad({ actual: 'Otra especialidad', nueva: 'Especialidad sintética' }, usuarios.recepcion)).toEqual({ medicos: 1 });
      expect((await medicos.especialidades({})).datos.map(e => e.nombre)).toEqual(['Especialidad sintética', 'Oculta']);
      await expect(medicos.renombrarEspecialidad({ actual: 'No existe', nueva: 'X' }, usuarios.recepcion)).rejects.toMatchObject({ status: 404 });
    });

    it('la ficha web nace oculta, enlazada, con el nombre, precio y horario de la agenda, y se mantiene al día', async () => {
      await prisma.perfilMedico.deleteMany({ where: { agendaMedicoId: { not: null } } });
      const especialidad = await prisma.especialidad.upsert({
        where: { nombre: 'Especialidad web sintética' }, update: {}, create: { nombre: 'Especialidad web sintética', slug: 'especialidad-web-sintetica' },
      });
      let ficha = await medicos.crearPresentacion(1, usuarios.recepcion);
      expect(ficha.presentacion).toMatchObject({ agendaMedicoId: 1, nombrePublico: 'Dra. Profesional sintético A', publicado: false, precioConsulta: 400.25, orden: 1, especialidades: [] });
      expect(ficha.presentacion!.horario.length).toBeGreaterThan(0);
      await expect(medicos.crearPresentacion(1, usuarios.recepcion)).rejects.toMatchObject({ status: 409 });
      // Sin especialidad web no se publica; con ella, sí. La foto pública de la reserva sale del directorio solo si hay foto.
      await expect(medicos.publicarPresentacion(1, true, usuarios.recepcion)).rejects.toMatchObject({ status: 400 });
      // Con la página de su especialidad de la agenda ya creada, la ficha nace en ella.
      await medicos.crearPaginas(['Especialidad sintética'], usuarios.recepcion);
      const conPagina = await medicos.crearPresentacion(2, usuarios.recepcion);
      expect(conPagina.presentacion!.especialidades.map(e => e.nombre)).toEqual(['Especialidad sintética']);
      await prisma.perfilMedico.deleteMany({ where: { agendaMedicoId: 2 } });
      await prisma.especialidad.deleteMany({ where: { nombre: 'Especialidad sintética' } });
      ficha = await medicos.actualizarPresentacion(1, { version: ficha.presentacion!.version, resumen: 'Control prenatal', especialidadIds: [especialidad.id] }, usuarios.recepcion);
      ficha = await medicos.publicarPresentacion(1, true, usuarios.recepcion);
      expect(ficha.presentacion).toMatchObject({ publicado: true, resumen: 'Control prenatal' });
      const lista = await medicos.listar({ buscar: 'sintético A' }, usuarios.recepcion);
      expect(lista.datos[0].web).toEqual({ perfilId: ficha.presentacion!.id, publicado: true, fotoUrl: null });
      // Guardar el horario en la agenda lo lleva a la web: un solo turno el viernes de 16:00 a 16:30.
      ficha = await medicos.guardarHorario(1, { version: ficha.version, activas: [{ dia: 'Viernes', hora: '16:00' }] }, usuarios.recepcion);
      expect(ficha.presentacion!.horario).toEqual([{ diaSemana: 5, desde: '16:00', hasta: '16:30', lugar: null }]);
      // El precio de una ficha enlazada no se edita por el directorio.
      await expect(app.get(DirectorioService).actualizarFicha(ficha.presentacion!.id, { version: ficha.presentacion!.version, precioConsulta: 1 }, usuarios.recepcion.sub))
        .rejects.toMatchObject({ status: 400 });
      await expect(medicos.crearPresentacion(2, usuarios.asistente)).rejects.toMatchObject({ status: 403 });
      await prisma.perfilMedico.deleteMany({ where: { agendaMedicoId: { not: null } } });
      await prisma.especialidad.delete({ where: { id: especialidad.id } });
    });

    it('los ve cualquier sesión (ventas sin el teléfono del médico); editan recepción y administración', async () => {
      const deVentas = await medicos.listar({}, usuarios.agente);
      expect(deVentas.total).toBeGreaterThan(0);
      expect(deVentas.datos.every(m => m.telefono === null)).toBe(true);
      expect((await medicos.ficha(1, usuarios.agente)).medico.telefono).toBeNull();
      expect((await medicos.ficha(1, usuarios.asistente)).medico.telefono).toBe('telefono-privado');
      const ficha = await medicos.ficha(1, usuarios.asistente);
      await expect(medicos.actualizar(1, { ...datos, version: ficha.version }, usuarios.asistente)).rejects.toMatchObject({ status: 403 });
      await expect(medicos.guardarHorario(1, { version: ficha.version, activas: [] }, usuarios.asistente)).rejects.toMatchObject({ status: 403 });
      await expect(medicos.crear({ ...datos, codigo: 'Z' }, usuarios.asistente)).rejects.toMatchObject({ status: 403 });
    });

    it('el usuario de administración no borra, no cambia códigos ni contraseñas y no ve pacientes', async () => {
      const conn = await createConnection({
        host: config.getOrThrow<string>('AGENDA_MYSQL_TLS_IDENTIDAD'),
        stream: () => connect({ host: '127.0.0.1', port: 3307 }),
        user: 'crm_agenda_admin', password: VALORES.AGENDA_ADMIN_PASSWORD, database: 'clinica',
        ssl: { ca: readFileSync(process.env.AGENDA_MYSQL_TEST_CA!), rejectUnauthorized: true, verifyIdentity: true },
      });
      try {
        for (const sql of [
          'SELECT password FROM medicos', 'SELECT login FROM medicos', "UPDATE medicos SET codigo = 'X' WHERE 1=0",
          "UPDATE medicos SET password = 'x' WHERE 1=0", 'DELETE FROM medicos WHERE 1=0', 'DELETE FROM horarios WHERE 1=0',
          "UPDATE horarios SET cod_med = 'X' WHERE 1=0", 'SELECT nombre_age FROM para_agendar', 'SELECT paciente FROM agenda_med',
          "INSERT INTO agenda_med (cod_med) VALUES ('x')", "UPDATE pagos_qr SET banco = 'x' WHERE 1=0",
        ]) {
          await expect(conn.query(sql)).rejects.toMatchObject({ code: expect.stringMatching(/ACCESS_DENIED|DENIED/) });
        }
      } finally { await conn.end(); }
    });
  });
  it('comprobante de chat: guarda la imagen real una vez sin confirmar el pago ni sobrescribir', async () => {
    const db = await conexionRoot();
    try {
      await db.query("INSERT INTO para_agendar (para_age, medico_pk, fecha, hora, nombre_age, telefono_age, ci_age, estado) VALUES (99999,1,CURRENT_DATE(),'23:59:00','Sintético','70012345','1234567','PENDIENTE')");
      const servicio=app.get(AgendaReservasService);
      expect(await servicio.registrarPagoDesdeChat(99999,PNG_QR)).toBe('REGISTRADO');
      expect(await servicio.registrarPagoDesdeChat(99999,WEBP_FOTO)).toBe('YA_NO_PENDIENTE');
      const [[r]]=await db.query<RowDataPacket[]>('SELECT estado, comprobante FROM para_agendar WHERE para_age=99999');
      expect(r.estado).toBe('PAGADO');
      expect(Buffer.from(r.comprobante)).toEqual(PNG_QR);
      expect(await servicio.registrarPagoDesdeChat(99998,PNG_QR)).toBe('NO_ENCONTRADA');
      expect(await servicio.registrarPagoDesdeChat(99999,Buffer.from('no-imagen'))).toBe('NO_ES_IMAGEN');
    } finally { await db.end(); }
  });
  it('un Flow emitido para una línea apagada o sin línea no consulta ni reserva', async () => {
    const token=sellarTokenFlow('59170012345',Date.now(),'linea-apagada');
    expect((await pantallaDelFlow({action:'INIT',flow_token:token})).status).toBe(427);
    expect((await pantallaDelFlow({action:'INIT',flow_token:sellarTokenFlow('59170012345')})).status).toBe(427);
  });

});
