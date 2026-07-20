/**
 * Crea el primer usuario administrador si no existe ninguno.
 * Uso: node scripts/seed-admin.js [email] [password]
 * Por defecto: admin@crm.local / CambiarYa123!  (cámbiala en el primer login)
 */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2] ?? 'admin@crm.local';
  const password = process.argv[3] ?? 'CambiarYa123!';

  const existeAdmin = await prisma.usuario.findFirst({ where: { rol: 'ADMIN' } });
  if (existeAdmin) {
    console.log('Ya existe al menos un administrador — no se creó nada.');
    return;
  }

  await prisma.usuario.create({
    data: {
      nombre: 'Administrador',
      email,
      passwordHash: await bcrypt.hash(password, 10),
      rol: 'ADMIN',
    },
  });

  console.log(`Administrador creado: ${email}`);
  console.log('IMPORTANTE: cambia la contraseña después del primer login.');
}

main()
  .catch(err => {
    console.error(err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
