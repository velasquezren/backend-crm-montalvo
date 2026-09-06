import { statSync } from 'node:fs';

// systemd ejecuta node dist/main.js; un build sin ese archivo no es desplegable.
const entrypoint = new URL('../dist/main.js', import.meta.url);

try {
  const archivo = statSync(entrypoint);
  if (!archivo.isFile() || archivo.size === 0) {
    throw new Error('el entrypoint no es un archivo regular con contenido');
  }
  console.log('✓ Build verificado: dist/main.js existe y tiene contenido.');
} catch (error) {
  console.error('Build inválido: se requiere dist/main.js.', error.message);
  process.exitCode = 1;
}
