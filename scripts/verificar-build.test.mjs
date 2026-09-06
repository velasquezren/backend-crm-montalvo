import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

for (const estado of ['ausente', 'ruta equivocada', 'vacío', 'directorio', 'válido']) {
  test(`check:build con entrypoint ${estado}`, (t) => {
    const raiz = mkdtempSync(join(tmpdir(), 'crm-check-build-'));
    t.after(() => rmSync(raiz, { recursive: true, force: true }));
    mkdirSync(join(raiz, 'scripts'));
    mkdirSync(join(raiz, 'dist', 'src'), { recursive: true });
    const script = join(raiz, 'scripts', 'verificar-build.mjs');
    copyFileSync(new URL('./verificar-build.mjs', import.meta.url), script);

    if (estado === 'ruta equivocada') writeFileSync(join(raiz, 'dist', 'src', 'main.js'), '"use strict";');
    if (estado === 'vacío') writeFileSync(join(raiz, 'dist', 'main.js'), '');
    if (estado === 'directorio') mkdirSync(join(raiz, 'dist', 'main.js'));
    if (estado === 'válido') writeFileSync(join(raiz, 'dist', 'main.js'), '"use strict";');

    // Otro cwd prueba que se verifica la salida del proyecto, no la del llamador.
    const resultado = spawnSync(process.execPath, [script], { cwd: tmpdir(), encoding: 'utf8' });
    assert.ifError(resultado.error);
    assert.equal(resultado.status, estado === 'válido' ? 0 : 1, resultado.stderr);
    if (estado !== 'válido') assert.match(resultado.stderr, /Build inválido: se requiere dist\/main\.js/);
  });
}
