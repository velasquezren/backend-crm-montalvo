import { NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { ServiciosService } from './servicios.service';

/**
 * Contra PostgreSQL real (`crm_test` en el :5433 local). Aquí no hay nada que
 * mockear que valga la pena: lo que se prueba SON las agregaciones —`count`,
 * `sum`, `count(DISTINCT …)`, `GROUP BY`, el `LEFT JOIN` contra la ficha— y eso
 * lo resuelve Postgres, no nuestro código. Una base falsa daría por buena una
 * consulta mal escrita.
 *
 * Se ejecutan con `npm run test:integracion`.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';

if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService({ datasources: { db: { url: URL_TEST } } });
let service: ServiciosService;
let periodoId: string;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.ventaImportada.deleteMany();
  await prisma.periodoComision.deleteMany();
  await prisma.cliente.deleteMany();

  const periodo = await prisma.periodoComision.create({
    data: { anio: 2026, mes: 3, tipoCambio: 6.96 },
  });
  periodoId = periodo.id;
  service = new ServiciosService(prisma);
});

/** Fila del Excel con lo mínimo que exige el schema; el resto se pasa por encima. */
async function venta(campos: {
  medicoPk?: string | null;
  medico?: string | null;
  pac?: string | null;
  paciente?: string | null;
  detalle?: string;
  modulo?: string;
  precio?: number;
  fecha?: string;
}) {
  return prisma.ventaImportada.create({
    data: {
      periodoId,
      detalle: campos.detalle ?? 'Consulta general',
      modulo: campos.modulo ?? 'CONSULTA',
      precio: campos.precio ?? 100,
      fecha: campos.fecha ? new Date(campos.fecha) : new Date('2026-03-15'),
      medicoPk: campos.medicoPk ?? null,
      medico: campos.medico ?? null,
      pac: campos.pac ?? null,
      paciente: campos.paciente ?? null,
      canal: 'PROPIO',
      ingresoNeto: (campos.precio ?? 100) * 0.87,
      unidadNegocio: 'VARIOS',
      clasif: 'CONSULTA',
      tipo: 'A',
    },
  });
}

describe('ServiciosService.perfilMedico contra Postgres real', () => {
  describe('resumen', () => {
    it('suma servicios, ingreso y ticket promedio del médico', async () => {
      await venta({ medicoPk: 'M1', medico: 'Dra. Rojas', pac: 'P1', precio: 100 });
      await venta({ medicoPk: 'M1', medico: 'Dra. Rojas', pac: 'P2', precio: 300 });
      /* De otro médico: no debe contarse. */
      await venta({ medicoPk: 'M2', medico: 'Dr. Vera', pac: 'P3', precio: 999 });

      const perfil = await service.perfilMedico('M1');

      expect(perfil.nombre).toBe('Dra. Rojas');
      expect(perfil.resumen.servicios).toBe(2);
      expect(perfil.resumen.ingreso).toBe(400);
      expect(perfil.resumen.ticketPromedio).toBe(200);
    });

    /* `count(DISTINCT pac)`: el mismo paciente atendido tres veces es UN paciente.
       Es justo el tipo de cifra que un doble de base daría por buena mal escrita. */
    it('cuenta pacientes DISTINTOS, no visitas', async () => {
      await venta({ medicoPk: 'M1', pac: 'P1' });
      await venta({ medicoPk: 'M1', pac: 'P1' });
      await venta({ medicoPk: 'M1', pac: 'P1' });
      await venta({ medicoPk: 'M1', pac: 'P2' });

      const perfil = await service.perfilMedico('M1');

      expect(perfil.resumen.servicios).toBe(4);
      expect(perfil.resumen.pacientes).toBe(2);
    });

    it('devuelve la primera y la última atención', async () => {
      await venta({ medicoPk: 'M1', pac: 'P1', fecha: '2026-03-05' });
      await venta({ medicoPk: 'M1', pac: 'P2', fecha: '2026-03-28' });
      await venta({ medicoPk: 'M1', pac: 'P3', fecha: '2026-03-14' });

      const { resumen } = await service.perfilMedico('M1');

      expect(resumen.primeraAtencion?.toISOString().slice(0, 10)).toBe('2026-03-05');
      expect(resumen.ultimaAtencion?.toISOString().slice(0, 10)).toBe('2026-03-28');
    });
  });

  describe('desgloses', () => {
    it('agrupa por módulo, de mayor a menor', async () => {
      await venta({ medicoPk: 'M1', modulo: 'LABORATORIO', precio: 50 });
      await venta({ medicoPk: 'M1', modulo: 'CONSULTA', precio: 200 });
      await venta({ medicoPk: 'M1', modulo: 'CONSULTA', precio: 200 });

      const { porModulo } = await service.perfilMedico('M1');

      expect(porModulo).toEqual([
        { etiqueta: 'CONSULTA', total: 2, ingreso: 400 },
        { etiqueta: 'LABORATORIO', total: 1, ingreso: 50 },
      ]);
    });

    it('ordena los servicios más frecuentes primero', async () => {
      await venta({ medicoPk: 'M1', detalle: 'Ecografía' });
      await venta({ medicoPk: 'M1', detalle: 'Ecografía' });
      await venta({ medicoPk: 'M1', detalle: 'Control' });

      const { topServicios } = await service.perfilMedico('M1');

      expect(topServicios[0]).toMatchObject({ etiqueta: 'Ecografía', total: 2 });
      expect(topServicios[1]).toMatchObject({ etiqueta: 'Control', total: 1 });
    });

    it('enlaza al paciente con su ficha del CRM cuando existe, y deja null cuando no', async () => {
      await prisma.cliente.create({
        data: { nombre: 'Ana Registrada', telefono: '+59170000001', pac: 'P1' },
      });
      await venta({ medicoPk: 'M1', pac: 'P1', paciente: 'Ana del Excel' });
      await venta({ medicoPk: 'M1', pac: 'P9', paciente: 'Sin ficha' });

      const { topPacientes } = await service.perfilMedico('M1');

      const conFicha = topPacientes.find(p => p.pac === 'P1');
      const sinFicha = topPacientes.find(p => p.pac === 'P9');
      expect(conFicha?.clienteId).toEqual(expect.any(String));
      expect(sinFicha?.clienteId).toBeNull();
    });

    it('ordena los pacientes por número de visitas', async () => {
      await venta({ medicoPk: 'M1', pac: 'P1', precio: 10 });
      await venta({ medicoPk: 'M1', pac: 'P2', precio: 10 });
      await venta({ medicoPk: 'M1', pac: 'P2', precio: 10 });

      const { topPacientes } = await service.perfilMedico('M1');

      expect(topPacientes[0]).toMatchObject({ pac: 'P2', servicios: 2, gastado: 20 });
      expect(topPacientes[1]).toMatchObject({ pac: 'P1', servicios: 1 });
    });

    it('agrupa la actividad por mes', async () => {
      const otro = await prisma.periodoComision.create({
        data: { anio: 2026, mes: 4, tipoCambio: 6.96 },
      });
      await venta({ medicoPk: 'M1', precio: 100 });
      await prisma.ventaImportada.create({
        data: {
          periodoId: otro.id, detalle: 'x', precio: 250, fecha: new Date('2026-04-02'),
          medicoPk: 'M1', canal: 'PROPIO', ingresoNeto: 217.5, unidadNegocio: 'VARIOS',
          clasif: 'CONSULTA', tipo: 'A',
        },
      });

      const { porMes } = await service.perfilMedico('M1');

      expect(porMes).toEqual([
        { anio: 2026, mes: 3, total: 1, ingreso: 100 },
        { anio: 2026, mes: 4, total: 1, ingreso: 250 },
      ]);
    });
  });

  describe('bordes', () => {
    it('404 si el médico no tiene ningún servicio', async () => {
      await venta({ medicoPk: 'M1' });
      await expect(service.perfilMedico('NO_EXISTE')).rejects.toThrow(NotFoundException);
    });

    it('404 sin consultar la base ante un código vacío o absurdo', async () => {
      await expect(service.perfilMedico('   ')).rejects.toThrow(NotFoundException);
      /* `medicoPk` es VarChar(40): más largo no es un médico, es ruido. */
      await expect(service.perfilMedico('X'.repeat(41))).rejects.toThrow(NotFoundException);
    });

    it('ignora las filas sin médico asignado', async () => {
      await venta({ medicoPk: null, pac: 'P1' });
      await venta({ medicoPk: 'M1', pac: 'P2' });

      const perfil = await service.perfilMedico('M1');

      expect(perfil.resumen.servicios).toBe(1);
    });

    it('tolera un médico cuyos servicios no traen código de paciente', async () => {
      await venta({ medicoPk: 'M1', pac: null, precio: 80 });

      const perfil = await service.perfilMedico('M1');

      expect(perfil.resumen.pacientes).toBe(0);
      expect(perfil.resumen.ingreso).toBe(80);
      expect(perfil.topPacientes).toEqual([]);
    });
  });
});
