/**
 * F06-R2: el reproductor con dobles fue sustituido por regresiones PostgreSQL.
 * Se conserva este punto de entrada para los enlaces de la auditoría histórica.
 * Requiere la base LOCAL desechable crm_test en :5433 (ver documentación F06-R2).
 * No usa Meta/R2 reales. Los fallos ahora los provoca PostgreSQL con triggers.
 */
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

const resultado = spawnSync(process.execPath, [
  'node_modules/jest/bin/jest.js',
  '--runInBand',
  '--testPathIgnorePatterns=/node_modules/',
  '--runTestsByPath',
  'src/modules/leads/primer-contacto.integracion.spec.ts',
], { cwd: resolve(__dirname, '../..'), stdio: 'inherit' });

if (resultado.error) throw resultado.error;
process.exitCode = resultado.status ?? 1;
