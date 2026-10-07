import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { createConnection, RowDataPacket } from 'mysql2/promise';
import { readFileSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo, connect } from 'node:net';
import { imagenSintetica } from '../../common/storage/imagen-sintetica';
import { AgendaModule } from './agenda.module';
import { AgendaVpsClient } from './agenda-vps.client';

// Suite separada: scripts/probar-agenda-mysql.sh crea y destruye SU MySQL.
const ejecutar = process.env.AGENDA_MYSQL_TEST === 'on' ? describe : describe.skip;
const VALORES = {
  AGENDA_VPS_LECTURA: 'on', AGENDA_VPS_RESERVAS: 'on', AGENDA_MYSQL_HOST: '127.0.0.1', AGENDA_MYSQL_PUERTO: '3307',
  AGENDA_MYSQL_USUARIO: 'crm_agenda_lectura', AGENDA_MYSQL_PASSWORD: 'solo-pruebas-sinteticas-no-produccion-2026',
  AGENDA_RESERVA_USUARIO: 'crm_agenda_reserva', AGENDA_RESERVA_PASSWORD: 'solo-pruebas-sinteticas-reserva-no-produccion-2026',
  AGENDA_RESERVA_SECRETO: 'secreto-sintetico-de-referencias-de-pago-2026',
  AGENDA_MYSQL_CA_ARCHIVO: process.env.AGENDA_MYSQL_TEST_CA ?? '',
  AGENDA_MYSQL_TLS_IDENTIDAD: 'MySQL_Server_8.0.44_Auto_Generated_Server_Certificate',
};
const config = new ConfigService(VALORES);
@Module({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), AgendaModule], providers: [] })
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
    app = await NestFactory.create(ModuloPrueba, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); qr?.close(); });
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
  it('respeta ocupación de agenda_med (incluso BORRADO) y oculta reservas web PENDIENTE/PAGADO', async () => {
    const r = await get(`disponibilidad?medicoId=1&fecha=${fecha(1)}`);
    const d = await r.json() as { estado: string; horarios: { hora: string }[] };
    expect(r.status).toBe(200);
    expect(d.estado).toBe('DISPONIBLE');
    // 09:00 CREADO y 10:00 BORRADO en agenda_med; 13:00 PENDIENTE en para_agendar;
    // 11:00 tiene una reserva ATENDIDO histórica, que no ocupa.
    expect(d.horarios.map(h => h.hora)).toEqual(['11:00', '14:00', '15:00']);
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
    expect(d.horarios.map(h => h.hora)).toEqual(['11:00', '15:00']);
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
});
