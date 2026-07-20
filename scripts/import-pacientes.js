/**
 * Import histórico de pacientes (FileMaker → CRM).
 * Ref: conversación sobre pacientes.xlsx — decisiones tomadas por el usuario:
 *   - Nombre:    columna "_Nombre" (calculada/normalizada en FileMaker)
 *   - Teléfono:  columna "_Celular" (calculada/normalizada), es la clave anti-duplicados (RF-02)
 *   - Fallecido: se EXCLUYEN por completo del CRM comercial
 *   - Alcance:   solo se importan pacientes con teléfono válido
 *
 * IMPORTANTE (privacidad): este script nunca imprime nombres, teléfonos, emails
 * ni ningún otro dato individual de paciente — solo contadores agregados.
 *
 * Uso:
 *   node scripts/import-pacientes.js "/ruta/a/pacientes.xlsx" --dry-run   (solo cuenta, no escribe)
 *   node scripts/import-pacientes.js "/ruta/a/pacientes.xlsx"            (importa de verdad)
 */
const path = require('path');
const XLSX = require('xlsx');
const { PrismaClient, OrigenLead } = require('@prisma/client');

const prisma = new PrismaClient();

const NOMBRE_COL = '_Nombre';
const NOMBRE_FALLBACK_COLS = ['Paciente', 'Paciente.reg'];
const TELEFONO_COL = 'Telef.Celular';
const EMAIL_COL = 'E.mail';
const FALLECIDO_COL = 'Fallecido';
const PK_COL = 'pk';

/* Columnas sin equivalente directo en el schema — se guardan como datosExtra (JSON) */
const CAMPOS_EXTRA = [
  'pk', 'CI.Pac', 'CI.Lug.Pac', 'Direccion', 'Nacionalidad', 'F_Naci', 'E_Civil',
  'Sexo', 'Profesion', 'EmpTrab', 'NIT', 'Edad.a', 'Edad.m', 'Categoria_Edad',
  'SaldoTotal', 'Movimientos', 'Con.Nombre', 'Con.Tel', 'Con.Cel', 'Con.Trabaja',
  'Con.Profesion', 'Telef.Dom', 'Telf.Ofic.', 'M_Consulta', 'Cod_Pac_Num',
];

function esFallecido(valor) {
  if (valor === null || valor === undefined) return false;
  /* En este export de FileMaker, "Fallecido" marca la defunción con "+".
     "No" / "NO" / vacío significan que el paciente está vivo. */
  return String(valor).trim() === '+';
}

/** Normaliza a formato E.164 aproximado para Bolivia (+591). */
function normalizarTelefono(valor) {
  if (!valor) return null;
  let limpio = String(valor).replace(/[^\d+]/g, '');
  if (!limpio) return null;

  if (limpio.startsWith('+')) {
    // ya viene con código de país
  } else if (limpio.startsWith('591') && limpio.length >= 10) {
    limpio = `+${limpio}`;
  } else if (limpio.length >= 7 && limpio.length <= 8) {
    limpio = `+591${limpio}`;
  } else {
    return null; // longitud rara, no confiable
  }

  const digitos = limpio.replace('+', '');
  if (digitos.length < 9 || digitos.length > 13) return null;
  return limpio;
}

function obtenerNombre(fila) {
  for (const col of [NOMBRE_COL, ...NOMBRE_FALLBACK_COLS]) {
    const valor = fila[col];
    if (valor && String(valor).trim().length >= 2) {
      return String(valor).trim();
    }
  }
  return null;
}

function construirDatosExtra(fila) {
  const extra = {};
  for (const col of CAMPOS_EXTRA) {
    const valor = fila[col];
    if (valor !== null && valor !== undefined && String(valor).trim() !== '') {
      extra[col] = valor;
    }
  }
  extra.origenImport = 'filemaker-pacientes';
  return extra;
}

async function main() {
  const archivo = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');

  if (!archivo) {
    console.error('Uso: node scripts/import-pacientes.js <ruta.xlsx> [--dry-run]');
    process.exit(1);
  }

  console.log(`Leyendo ${path.basename(archivo)}…`);
  const workbook = XLSX.readFile(archivo);
  const hoja = workbook.Sheets[workbook.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(hoja, { defval: null });

  const contadores = {
    total: filas.length,
    fallecidos: 0,
    sinNombre: 0,
    sinTelefonoValido: 0,
    duplicadosEnArchivo: 0,
    aImportar: 0,
  };

  const telefonosVistos = new Set();
  const registros = [];

  for (const fila of filas) {
    if (esFallecido(fila[FALLECIDO_COL])) {
      contadores.fallecidos++;
      continue;
    }

    const nombre = obtenerNombre(fila);
    if (!nombre) {
      contadores.sinNombre++;
      continue;
    }

    const telefono = normalizarTelefono(fila[TELEFONO_COL]);
    if (!telefono) {
      contadores.sinTelefonoValido++;
      continue;
    }

    if (telefonosVistos.has(telefono)) {
      contadores.duplicadosEnArchivo++;
      continue;
    }
    telefonosVistos.add(telefono);

    const emailRaw = fila[EMAIL_COL];
    const email = emailRaw && String(emailRaw).includes('@') ? String(emailRaw).trim() : null;

    registros.push({
      nombre,
      telefono,
      email,
      categoria: 'PROSPECTO',
      datosExtra: construirDatosExtra(fila),
      _pk: fila[PK_COL],
    });
    contadores.aImportar++;
  }

  console.log('\n=== Resumen (sin datos individuales) ===');
  console.log(`Filas totales en el Excel:        ${contadores.total}`);
  console.log(`Excluidos por fallecido:          ${contadores.fallecidos}`);
  console.log(`Excluidos sin nombre:             ${contadores.sinNombre}`);
  console.log(`Excluidos sin teléfono válido:    ${contadores.sinTelefonoValido}`);
  console.log(`Duplicados dentro del archivo:    ${contadores.duplicadosEnArchivo}`);
  console.log(`→ A importar:                     ${contadores.aImportar}`);

  if (dryRun) {
    console.log('\n(--dry-run) No se escribió nada en la base de datos.');
    await prisma.$disconnect();
    return;
  }

  console.log('\nImportando a PostgreSQL en lotes de 1000…');
  const TAMANO_LOTE = 1000;
  let insertados = 0;
  let omitidosPorConflicto = 0;

  for (let i = 0; i < registros.length; i += TAMANO_LOTE) {
    const lote = registros.slice(i, i + TAMANO_LOTE).map(({ _pk, ...cliente }) => cliente);
    const resultado = await prisma.cliente.createMany({ data: lote, skipDuplicates: true });
    insertados += resultado.count;
    omitidosPorConflicto += lote.length - resultado.count;
    process.stdout.write(`  ${Math.min(i + TAMANO_LOTE, registros.length)}/${registros.length}\r`);
  }

  console.log(`\n\nClientes insertados:                ${insertados}`);
  console.log(`Omitidos por teléfono ya existente:  ${omitidosPorConflicto}`);

  /* Traza histórica (RF-06): un Lead con origen IMPORTACION por cada cliente nuevo */
  console.log('\nRegistrando trazabilidad (Lead origen=IMPORTACION)…');
  const clientesImportados = await prisma.cliente.findMany({
    where: { telefono: { in: registros.map(r => r.telefono) } },
    select: { id: true },
  });
  const leadsData = clientesImportados.map(c => ({ clienteId: c.id, origen: OrigenLead.IMPORTACION }));
  for (let i = 0; i < leadsData.length; i += TAMANO_LOTE) {
    await prisma.lead.createMany({ data: leadsData.slice(i, i + TAMANO_LOTE), skipDuplicates: true });
  }

  console.log('\nListo.');
  await prisma.$disconnect();
}

main().catch(async err => {
  console.error('Error durante el import:', err.message);
  await prisma.$disconnect();
  process.exit(1);
});
