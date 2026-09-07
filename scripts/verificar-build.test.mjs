import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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

test('npm run build conserva el entrypoint en builds limpios y consecutivos', async (t) => {
  const proyecto = fileURLToPath(new URL('../', import.meta.url));
  const raiz = mkdtempSync(join(tmpdir(), 'crm-build-consecutivo-'));
  t.after(() => rmSync(raiz, { recursive: true, force: true }));

  // Copia el código actual, incluido Prisma generado, pero nunca dist, cachés o .env.
  // Usa las dependencias instaladas: esta prueba no instala ni descarga paquetes.
  for (const ruta of ['src', 'scripts', 'prisma', '.claude', '.env.example',
    'package.json', 'nest-cli.json', 'tsconfig.json', 'tsconfig.build.json']) {
    cpSync(join(proyecto, ruta), join(raiz, ruta), { recursive: true });
  }
  symlinkSync(join(proyecto, 'node_modules'), join(raiz, 'node_modules'), 'dir');

  const ejecutarBuild = () => {
    const resultado = spawnSync('npm', ['run', 'build'], {
      cwd: raiz,
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.ifError(resultado.error);
    return resultado;
  };

  for (const estado of ['limpio', 'consecutivo']) {
    await t.test(`build ${estado}`, () => {
      const resultado = ejecutarBuild();
      assert.equal(resultado.status, 0, resultado.stdout + resultado.stderr);
      const entrypoint = statSync(join(raiz, 'dist', 'main.js'));
      assert.ok(entrypoint.isFile() && entrypoint.size > 0, 'Falta dist/main.js con contenido');
    });
  }

  await t.test('el comando completo falla si el compilador no emite JavaScript', () => {
    // Fuerza una compilación sin errores y sin JS: comprueba que npm encadena
    // realmente el verificador, además de probar el script por separado arriba.
    renameSync(join(raiz, 'tsconfig.build.json'), join(raiz, 'tsconfig.build.base.json'));
    writeFileSync(join(raiz, 'tsconfig.build.json'), JSON.stringify({
      extends: './tsconfig.build.base.json',
      compilerOptions: { noEmit: true },
    }));
    const resultado = ejecutarBuild();
    assert.equal(resultado.status, 1, resultado.stdout + resultado.stderr);
    assert.match(resultado.stdout + resultado.stderr, /Build inválido: se requiere dist\/main\.js/);
  });
});
