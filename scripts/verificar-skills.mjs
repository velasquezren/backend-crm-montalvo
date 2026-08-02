#!/usr/bin/env node
/**
 * Verifica que lo que afirma .claude/skills/ siga siendo cierto en el código.
 *
 *   node scripts/verificar-skills.mjs    → informa y falla (exit 1) si hay drift
 *
 * Por qué existe: un skill es la autoridad que lee quien programa aquí (humano o
 * agente). Cuando envejece no se rompe ruidosamente como el código — empieza a
 * mentir en silencio, y quien lo lee escribe algo mal con total confianza. Ya
 * pasó: el skill siguió enseñando el escopado por rol a mano (`rol === 'ADMIN'`)
 * después de que `alcanceAgente()` existiera precisamente para reemplazarlo, y
 * de que SUPER_ADMIN rompiera esa comparación.
 *
 * La prosa (decisiones, cicatrices, el porqué de cada patrón) envejece bien y no
 * se puede verificar sola. Lo que se pudre son los DATOS: rutas de archivo,
 * nombres de roles, símbolos exportados. Eso es lo que revisa este script.
 *
 * El frontend vive en un repositorio hermano. Si no está clonado, sus rutas se
 * omiten en vez de fallar: es una red de seguridad de desarrollo, no un
 * requisito de despliegue.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = resolve(RAIZ, '.claude', 'skills');
const SCHEMA = resolve(RAIZ, 'prisma', 'schema.prisma');
const ROLES_TS = resolve(RAIZ, 'src', 'common', 'auth', 'roles.ts');
const HERMANO = resolve(RAIZ, '..', 'frontend-crm-montalvo');

const IGNORAR = new Set(['node_modules', '.git', 'dist', '.angular', '.claude', '.agents']);
const EXTENSIONES = /\.(ts|css|html|md|mjs|js|json|prisma)$/;

const problemas = [];
const señala = (skill, mensaje) => problemas.push({ skill, mensaje });

function indexar(raiz, acumulado = []) {
  if (!existsSync(raiz)) return acumulado;
  for (const entrada of readdirSync(raiz)) {
    if (IGNORAR.has(entrada)) continue;
    const ruta = join(raiz, entrada);
    if (statSync(ruta).isDirectory()) indexar(ruta, acumulado);
    else acumulado.push(ruta);
  }
  return acumulado;
}

const ARCHIVOS = [
  ...indexar(resolve(RAIZ, 'src')),
  ...indexar(resolve(RAIZ, 'prisma')),
  ...readdirSync(RAIZ)
    .map(e => join(RAIZ, e))
    .filter(r => statSync(r).isFile()),
  ...indexar(resolve(HERMANO, 'src')),
  ...(existsSync(HERMANO)
    ? readdirSync(HERMANO)
        .map(e => join(HERMANO, e))
        .filter(r => statSync(r).isFile())
    : []),
];

const sinCodigo = texto => texto.replace(/```[\s\S]*?```/g, '');
const entrecomillado = texto => [...texto.matchAll(/`([^`\n]+)`/g)].map(m => m[1]);

// ── 1. Rutas de archivo citadas en la prosa ───────────────────────────────────
// El skill cita archivos del frontend (`CRM_MANIFESTO.md`). Sin el repo hermano
// clonado —un build de CI que solo trae el backend— esas rutas no se pueden
// resolver, y marcarlas como rotas sería un falso positivo que tumba el build.
// Las demás comprobaciones son locales y siguen siendo estrictas.
function verificarRutas(skill, texto) {
  if (!existsSync(HERMANO)) return;

  const candidatas = entrecomillado(sinCodigo(texto))
    .filter(t => EXTENSIONES.test(t) && !t.includes(' ') && !t.includes('<'))
    .map(t => t.replace(/^\.\//, ''))
    .filter(t => !t.startsWith('.')); // `.dto.ts` suelto es prosa, no una ruta

  for (const ruta of new Set(candidatas)) {
    const existe = ARCHIVOS.some(a => a.replaceAll('\\', '/').endsWith(`/${ruta}`));
    if (!existe) señala(skill, `ruta inexistente: \`${ruta}\``);
  }
}

// ── 2. Roles contra el enum de Prisma ─────────────────────────────────────────
function verificarRoles(skill, texto) {
  const bloque = readFileSync(SCHEMA, 'utf8').match(/enum\s+Rol\s*\{([^}]*)\}/)?.[1] ?? '';
  const reales = new Set(
    bloque
      .split('\n')
      .map(l => l.replace(/\/\/.*$/, '').trim())
      .filter(l => /^[A-Z_]+$/.test(l)),
  );

  const citados = new Set([...texto.matchAll(/@Roles\('(\w+)'\)/g)].map(m => m[1]));
  for (const rol of citados) {
    if (!reales.has(rol)) señala(skill, `@Roles('${rol}') — ese rol no existe en schema.prisma`);
  }
  for (const rol of reales) {
    if (!texto.includes(rol)) señala(skill, `el rol ${rol} existe en schema.prisma pero el skill no lo menciona`);
  }
}

// ── 3. Helpers de rol citados como API ────────────────────────────────────────
function verificarHelpers(skill, texto) {
  if (!existsSync(ROLES_TS)) return;
  const exportados = new Set(
    [...readFileSync(ROLES_TS, 'utf8').matchAll(/export\s+(?:function|const)\s+(\w+)/g)].map(
      m => m[1],
    ),
  );
  for (const helper of ['alcanceAgente', 'cubreRol', 'tieneAlcanceGlobal', 'RANGO_ROL']) {
    if (texto.includes(helper) && !exportados.has(helper))
      señala(skill, `\`${helper}\` ya no se exporta desde common/auth/roles.ts`);
  }
}

// ── Ejecución ─────────────────────────────────────────────────────────────────
if (!existsSync(SKILLS)) {
  console.log('· No hay .claude/skills/ — nada que verificar.');
  process.exit(0);
}

if (!existsSync(HERMANO)) {
  console.log('· Repo del frontend no encontrado — se omiten las rutas cruzadas.');
}

for (const nombre of readdirSync(SKILLS)) {
  const archivo = join(SKILLS, nombre, 'SKILL.md');
  if (!existsSync(archivo)) continue;

  const texto = readFileSync(archivo, 'utf8');
  verificarRutas(nombre, texto);
  verificarRoles(nombre, texto);
  verificarHelpers(nombre, texto);
}

if (problemas.length === 0) {
  console.log('✓ Los skills coinciden con el código.');
  process.exit(0);
}

console.error(`✗ ${problemas.length} desajuste(s) entre los skills y el código:\n`);
for (const { skill, mensaje } of problemas) console.error(`  ${skill}: ${mensaje}`);
console.error('\nCorrige el SKILL.md (o el código) antes de commitear.');
process.exit(1);
