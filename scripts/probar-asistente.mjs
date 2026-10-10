// Prueba el asistente de IA contra Google de verdad, con datos SINTÉTICOS.
//
//   npm run build && npm run asistente:probar
//
// Usa el código COMPILADO del CRM (el mismo adaptador que corre en producción),
// no una copia: lo que se prueba es lo que se despliega. Lee las variables del
// `.env` (ASISTENTE_IA, GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION,
// GOOGLE_APPLICATION_CREDENTIALS, ASISTENTE_MODELO…). Ninguna paciente, ninguna
// base de datos: el filtro, una vuelta con herramienta y la lectura de un
// comprobante dibujado aquí. Termina con código 1 si algo falla.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
if (!existsSync(new URL('../dist/modules/asistente/prueba-conexion.js', import.meta.url))) {
  console.error('Falta compilar: corre `npm run build` primero.');
  process.exit(1);
}
require('reflect-metadata');
const { ConfiguracionIA, ClienteVertex, ModeloVertex, ClasificadorVertex, LectorVertex } = require('../dist/modules/asistente/vertex/proveedor-vertex.js');
const { ImagenHorarioService } = require('../dist/modules/asistente/imagen-horario.service.js');
const { probarProveedor } = require('../dist/modules/asistente/prueba-conexion.js');

const config = { get: clave => process.env[clave] };
const cfg = new ConfiguracionIA(config);
const cliente = new ClienteVertex(cfg);
const resultado = await probarProveedor({
  estado: cfg.estado(),
  modelo: new ModeloVertex(cliente, cfg),
  clasificador: new ClasificadorVertex(cliente, cfg),
  lector: new LectorVertex(cliente, cfg),
  dibujar: svg => new ImagenHorarioService({}, {}).dibujar(svg),
});

const NOMBRE = { CONFIGURACION: 'Configuración', FILTRO: 'Filtro de entrada', CONVERSACION: 'Conversación con herramienta', COMPROBANTE: 'Lectura de comprobante' };
for (const p of resultado.pasos) {
  console.log(`${p.ok ? '✓' : '✗'} ${NOMBRE[p.paso].padEnd(30)} ${p.ms ? `${String(p.ms).padStart(5)} ms  ` : '          '}${p.detalle}`);
}
console.log(resultado.ok ? '\nListo: el asistente puede encenderse por línea desde el CRM.' : '\nTodavía no: corrige lo marcado con ✗ y vuelve a correrlo.');
process.exitCode = resultado.ok ? 0 : 1;
