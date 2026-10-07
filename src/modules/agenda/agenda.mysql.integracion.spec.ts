import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { createConnection } from 'mysql2/promise';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { AgendaModule } from './agenda.module';
import { AgendaVpsClient } from './agenda-vps.client';

// Suite separada: scripts/probar-agenda-mysql.sh crea y destruye SU MySQL.
const ejecutar = process.env.AGENDA_MYSQL_TEST === 'on' ? describe : describe.skip;
const config = new ConfigService({
  AGENDA_VPS_LECTURA: 'on', AGENDA_MYSQL_HOST: '127.0.0.1', AGENDA_MYSQL_PUERTO: '3307',
  AGENDA_MYSQL_USUARIO: 'crm_agenda_lectura', AGENDA_MYSQL_PASSWORD: 'solo-pruebas-sinteticas-no-produccion-2026',
  AGENDA_MYSQL_CA_ARCHIVO: process.env.AGENDA_MYSQL_TEST_CA,
  AGENDA_MYSQL_TLS_IDENTIDAD: 'MySQL_Server_8.0.44_Auto_Generated_Server_Certificate',
});
@Module({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), AgendaModule], providers: [] })
class ModuloPrueba {}

function fecha(dias: number) {
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/La_Paz', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return new Date(Date.parse(`${hoy}T00:00:00Z`) + dias * 86400000).toISOString().slice(0, 10);
}

ejecutar('Agenda HTTP → adaptador TLS → MySQL real descartable', () => {
  let app: INestApplication;
  let base: string;
  beforeAll(async () => {
    // ConfigModule es global en producción; aquí se inyecta sin leer .env.
    app = await NestFactory.create(ModuloPrueba, { logger: false });
    const vps = app.get(AgendaVpsClient);
    Object.defineProperty(vps, 'config', { value: config });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); });
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
    expect(Object.keys(med.datos[0]).sort()).toEqual(['especialidadId','horarioInformativo','id','modalidad','nombre','precio']);
    expect(JSON.stringify(med)).not.toMatch(/secreto|privado|<b>|paciente/);
  });
  it('respeta ocupación incluso BORRADO, no inventa bloqueo por para_agendar', async () => {
    const r = await get(`disponibilidad?medicoId=1&fecha=${fecha(1)}`);
    const d = await r.json() as { estado: string; horarios: { hora: string }[] };
    expect(r.status).toBe(200);
    expect(d.estado).toBe('DISPONIBLE');
    expect(d.horarios.map(h => h.hora)).toEqual(['11:00']);
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
    const incorrecto = new AgendaVpsClient(new ConfigService({
      ...Object.fromEntries(['AGENDA_VPS_LECTURA','AGENDA_MYSQL_HOST','AGENDA_MYSQL_PUERTO','AGENDA_MYSQL_USUARIO','AGENDA_MYSQL_PASSWORD','AGENDA_MYSQL_CA_ARCHIVO'].map(k => [k, config.get(k)])),
      AGENDA_MYSQL_TLS_IDENTIDAD: 'servidor-incorrecto.invalid',
    }));
    try { await expect(incorrecto.leer('especialidades', new URLSearchParams({pagina:'1',limite:'25'}))).rejects.toMatchObject({status:503}); }
    finally { await incorrecto.onModuleDestroy(); }
  });
});
