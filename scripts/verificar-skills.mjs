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
import { dirname, resolve, join, relative, sep } from 'node:path';

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

// ── 4. Todo webhook público va firmado y responde 200 ─────────────────────────
// Esta comprobación mira el CÓDIGO, no la documentación, y existe por lo que pasó
// el 2026-08-04: había DOS webhooks de Meta (`webhooks/whatsapp` y `webhooks/meta`)
// `@Public()`, sin rate-limit y escribiendo en base, sin verificar la firma. Bastaba
// conocer la URL —que es pública por necesidad— para dar de alta pacientes e
// inyectar mensajes en el hilo de cualquiera.
//
// Es la clase de agujero que no vuelve a aparecer por un descuido, sino por un
// webhook NUEVO escrito meses después copiando el patrón de otro. Por eso se
// comprueba automáticamente en vez de confiar en que alguien recuerde la regla.
function verificarWebhooks() {
  const dir = resolve(RAIZ, 'src', 'modules');
  if (!existsSync(dir)) return;

  const controladores = indexar(dir).filter(
    r => r.includes(`${sep}webhooks${sep}`) && r.endsWith('.controller.ts'),
  );

  for (const ruta of controladores) {
    const codigo = readFileSync(ruta, 'utf8');
    const rel = relative(RAIZ, ruta);

    /* Solo aplica a los POST: el GET de estas rutas es la verificación de alta de
       suscripción, que se defiende con META_VERIFY_TOKEN y no lleva cuerpo firmado. */
    if (!/@Post\(/.test(codigo)) continue;

    if (!/@UseGuards\(\s*MetaSignatureGuard\s*\)/.test(codigo)) {
      señala(
        'crm-backend-module',
        `${rel}: webhook con @Post() sin @UseGuards(MetaSignatureGuard). ` +
          'Meta firma TODOS sus webhooks igual (WhatsApp, Lead Ads, Messenger, Instagram): ' +
          'sin la firma el endpoint queda abierto a internet.',
      );
    }

    if (!/@HttpCode\(200\)/.test(codigo)) {
      señala(
        'crm-backend-module',
        `${rel}: webhook sin @HttpCode(200). Nest responde 201 a un POST por defecto y ` +
          'Meta documenta que espera 200; si lo trata como fallo, reintenta y acaba ' +
          'desactivando la suscripción.',
      );
    }
  }

  /* El guard falla cerrado: sin la variable, ningún mensaje entra. Que esté
     documentada en el .env.example es lo único que separa un despliegue nuevo
     de un inbox mudo sin explicación. */
  const ejemplo = resolve(RAIZ, '.env.example');
  if (controladores.length > 0 && existsSync(ejemplo)) {
    if (!/^META_APP_SECRET=/m.test(readFileSync(ejemplo, 'utf8'))) {
      señala(
        'crm-backend-module',
        '.env.example no documenta META_APP_SECRET, y sin esa variable el guard ' +
          'rechaza todos los webhooks (falla cerrado a propósito).',
      );
    }
  }
}

// ── 5. Ningún DTO sin decoradores de validación ───────────────────────────────
// El `ValidationPipe` global corre con `whitelist: true`, que **descarta toda
// propiedad sin decorador de class-validator**. Un DTO sin decoradores por tanto
// no llega a medias al service: llega VACÍO, siempre, sin lanzar ni registrar nada.
//
// Pasó con `SuscribirPushDto` el 2026-08-10: el endpoint aceptaba la suscripción,
// devolvía 200 y guardaba cero. Las notificaciones nunca funcionaron y no había
// un solo error en el log que lo insinuara. Es un fallo mudo, y los fallos mudos
// son justo los que no encuentra una revisión a ojo — por eso se comprueba aquí.
function verificarDtos() {
  const dtos = indexar(resolve(RAIZ, 'src')).filter(r => r.endsWith('.dto.ts'));

  for (const ruta of dtos) {
    const codigo = readFileSync(ruta, 'utf8');
    const rel = relative(RAIZ, ruta);

    for (const [, nombre, cuerpo] of codigo.matchAll(
      /export class (\w+)\s*{([\s\S]*?)\n}/g,
    )) {
      /* Propiedades declaradas: `nombre!: tipo` o `nombre?: tipo`. */
      const propiedades = [...cuerpo.matchAll(/^\s{2}(\w+)[!?]?:\s/gm)].map(m => m[1]);
      if (propiedades.length === 0) continue;

      /* La familia entera de class-validator, no solo `@IsAlgo`: `@Matches`,
         `@MaxLength`, `@Min`… también registran metadatos y por tanto también
         salvan a la propiedad del `whitelist`. Con el patrón anterior un DTO
         validado solo con `@Matches` se marcaba como sin validar — pasó con
         `DescargarMediaDto`. */
      const DECORADORES_VALIDOS =
        /@(Is[A-Z]\w*|Matches|Length|MaxLength|MinLength|Min|Max|Contains|NotContains|Equals|NotEquals|ArrayNotEmpty|ArrayMinSize|ArrayMaxSize|ValidateNested|ValidateIf|Allow)\s*\(/;

      if (!DECORADORES_VALIDOS.test(cuerpo)) {
        señala(
          'crm-backend-module',
          `${rel}: la clase ${nombre} no tiene ni un decorador de class-validator. ` +
            'Con `whitelist: true` el ValidationPipe vacía el objeto entero y el ' +
            'endpoint recibe {} sin avisar. Pon @IsString()/@IsInt()/… en cada campo.',
        );
      }
    }
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

/* Global, no por skill: mira el código, no la documentación. */
verificarWebhooks();
verificarDtos();

if (problemas.length === 0) {
  console.log('✓ Los skills coinciden con el código.');
  process.exit(0);
}

console.error(`✗ ${problemas.length} desajuste(s) entre los skills y el código:\n`);
for (const { skill, mensaje } of problemas) console.error(`  ${skill}: ${mensaje}`);
console.error('\nCorrige el SKILL.md (o el código) antes de commitear.');
process.exit(1);
