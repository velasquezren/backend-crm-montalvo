/*
 * Aislamiento de las pruebas. Se carga como `setupFiles` de jest, antes de cada
 * archivo de pruebas (unitarias e integración), y falla en lugar de adivinar.
 *
 * Por qué existe: `ConfigModule.forRoot()` lee el `.env` de la carpeta, y ese
 * archivo local puede traer las credenciales REALES de Meta y la URL de una base
 * real. Una prueba que montara el módulo equivocado podía hablar con Meta o
 * escribir fuera de la base descartable sin que nadie lo notara.
 *
 * Cuatro garantías, todas verificadas por `src/aislamiento-pruebas.spec.ts`:
 *
 *  1. El `.env` no se lee. `existsSync` dice que no existe y `readFileSync` lanza.
 *     (`.env.example` no se toca: no tiene secretos.)
 *  2. No quedan credenciales en `process.env`: se borra todo lo que parezca
 *     token, secreto, contraseña o identificador de cuenta de Meta. Las pruebas
 *     que necesitan un valor lo fijan ellas mismas, con datos sintéticos.
 *  3. `DATABASE_URL`, si existe, apunta a loopback y a una base `*_test`. Otra
 *     cosa detiene la suite entera: ninguna prueba escribe en una base real.
 *  4. Ninguna conexión sale de la máquina. Todo (fetch, http, https, Postgres,
 *     Socket.IO) pasa por `net.Socket.connect`: un destino que no sea loopback
 *     lanza `ConexionExternaBloqueada`. No hay forma de enviar un mensaje a Meta.
 */
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ES_DOTENV = /(^|[\\/])\.env$/;
const PARECE_CREDENCIAL = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|API_?KEY|ACCESS_?KEY|APP_ID|WABA|PHONE_ID|VERIFY)/i;
const HOSTS_LOCALES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', '::']);

class ConexionExternaBloqueada extends Error {
  constructor(destino) {
    super(`Prueba bloqueada: intentó conectarse a «${destino}». Las pruebas solo hablan con loopback.`);
    this.name = 'ConexionExternaBloqueada';
  }
}

/** ¿`url` es una base de pruebas local? Devuelve el motivo si no lo es. */
function motivoDeBaseNoPermitida(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'DATABASE_URL no es una URL válida';
  }
  if (!HOSTS_LOCALES.has(u.hostname)) return `el servidor «${u.hostname}» no es loopback`;
  const base = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!/(^|_)test$/.test(base)) return `la base «${base}» no termina en _test`;
  return null;
}

function esDestinoLocal(host) {
  if (!host) return true; // conexión por socket Unix o sin host explícito
  return HOSTS_LOCALES.has(String(host).toLowerCase());
}

/** 4. Ninguna conexión sale de la máquina. También sirve para un proceso que NO es de pruebas (`node -r`). */
function bloquearRedExterna() {
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    /* `net.connect()` llama a `socket.connect([opciones, callback])` con los
       argumentos YA normalizados dentro de un arreglo; quien llama a
       `socket.connect(opciones)` o `connect(puerto, host)` pasa los suyos tal cual. */
    const normalizados = Array.isArray(args[0]) ? args[0] : args;
    const [primero, segundo] = normalizados;
    let host;
    if (primero && typeof primero === 'object') host = primero.path ? undefined : primero.host;
    else if (typeof primero === 'string') host = undefined; // ruta de socket Unix
    else host = typeof segundo === 'string' ? segundo : undefined;
    if (!esDestinoLocal(host)) throw new ConexionExternaBloqueada(host);
    return connect.apply(this, args);
  };
}

function instalar() {
  /* 1. El .env no existe para las pruebas. */
  const existsSync = fs.existsSync;
  fs.existsSync = function (p) {
    return typeof p === 'string' && ES_DOTENV.test(path.normalize(p)) ? false : existsSync.apply(this, arguments);
  };
  for (const nombre of ['readFileSync', 'readFile', 'openSync', 'open', 'statSync']) {
    const original = fs[nombre];
    fs[nombre] = function (p) {
      if (typeof p === 'string' && ES_DOTENV.test(path.normalize(p))) {
        const err = new Error(`ENOENT: las pruebas no leen el .env (${nombre})`);
        err.code = 'ENOENT';
        throw err;
      }
      return original.apply(this, arguments);
    };
  }

  /* 2. Sin credenciales heredadas del entorno. */
  for (const clave of Object.keys(process.env)) {
    if (PARECE_CREDENCIAL.test(clave)) delete process.env[clave];
  }
  process.env.NODE_ENV = 'test';
  process.env.CRM_PRUEBAS_AISLADAS = '1';

  /* 3. Solo una base descartable y local. */
  const url = process.env.DATABASE_URL;
  if (url) {
    const motivo = motivoDeBaseNoPermitida(url);
    if (motivo) {
      throw new Error(
        `Pruebas detenidas: ${motivo}. Usa una base descartable, p. ej. postgresql://…@localhost:5433/crm_test.`,
      );
    }
  }

  bloquearRedExterna();
}

module.exports = { instalar, bloquearRedExterna, motivoDeBaseNoPermitida, esDestinoLocal, ConexionExternaBloqueada };

if (process.env.JEST_WORKER_ID !== undefined) instalar();
