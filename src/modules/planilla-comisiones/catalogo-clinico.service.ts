import { Injectable } from '@nestjs/common';

import { CacheMemoria } from '../../common/cache/cache-memoria';
import { PrismaService } from '../../prisma/prisma.service';

/** Un servicio que la clínica ya ha facturado alguna vez. */
export interface ServicioCatalogo {
  /** Tal cual está escrito en FileMaker — es lo que reconoce la agente. */
  readonly nombre: string;
  /** Módulo operativo de FileMaker: LABORATORIO, CONSULTA, PLANES, INTERNACION. */
  readonly modulo: string | null;
  /** Cuántas veces se ha vendido. Ordena las sugerencias. */
  readonly veces: number;
}

export interface MedicoCatalogo {
  readonly nombre: string;
  readonly veces: number;
}

export interface CatalogoClinico {
  readonly servicios: readonly ServicioCatalogo[];
  readonly medicos: readonly MedicoCatalogo[];
  readonly modulos: readonly string[];
  /** Para que la interfaz pueda decir de dónde salen estas sugerencias. */
  readonly ventasAnalizadas: number;
}

/* Cambia solo cuando se importa un Excel nuevo, o sea una vez al mes. Una hora
   de TTL evita repetir tres agregaciones sobre 7.400 filas en cada apertura del
   modal, que es justo lo que la agente hace veinte veces al día. */
const TTL_MS = 60 * 60 * 1000;
const CLAVE = 'catalogo';

/**
 * Catálogo de servicios y médicos derivado de lo que la clínica ya facturó.
 *
 * Nace de un problema concreto: el modal de ventas sugería ocho procedimientos
 * escritos a mano —rinoplastia, lipoescultura, aumento mamario— mientras que el
 * 64% de las ventas reales son de laboratorio. La agente que registraba un
 * hemograma, que es la venta más común, no encontraba nada y lo tecleaba a mano,
 * distinto cada vez. Aquí las sugerencias salen de las 7.399 ventas importadas:
 * 246 servicios y 65 médicos que existen de verdad, ordenados por frecuencia.
 *
 * **Es de solo lectura sobre `VentaImportada`.** No la escribe, no la interpreta
 * y no toca el clasificador de comisiones: la planilla mensual sigue siendo la
 * autoridad y esto es únicamente su reflejo para autocompletar.
 *
 * Vive en este módulo, y no en Ventas, porque `VentaImportada` es de aquí. Ventas
 * lo consume por el service, no por la tabla.
 */
@Injectable()
export class CatalogoClinicoService {
  private readonly cache = new CacheMemoria<CatalogoClinico>({ ttlMs: TTL_MS, maxEntradas: 1 });

  constructor(private readonly prisma: PrismaService) {}

  async obtener(): Promise<CatalogoClinico> {
    return this.cache.resolver(CLAVE, () => this.construir());
  }

  /** Se llama tras importar un periodo: el catálogo acaba de crecer. */
  invalidar(): void {
    this.cache.invalidar(CLAVE);
  }

  private async construir(): Promise<CatalogoClinico> {
    const [porServicio, porMedico, total] = await Promise.all([
      this.prisma.ventaImportada.groupBy({
        by: ['detalle', 'modulo'],
        _count: { _all: true },
        orderBy: { _count: { detalle: 'desc' } },
      }),
      this.prisma.ventaImportada.groupBy({
        by: ['medico'],
        _count: { _all: true },
        where: { medico: { not: null } },
        orderBy: { _count: { medico: 'desc' } },
      }),
      this.prisma.ventaImportada.count(),
    ]);

    /* Un mismo servicio puede aparecer bajo más de un módulo; se queda con el
       más frecuente en vez de duplicar la entrada en el desplegable. */
    const servicios = new Map<string, ServicioCatalogo>();
    for (const fila of porServicio) {
      const nombre = fila.detalle.trim();
      if (!nombre) continue;
      const veces = fila._count._all;
      const previo = servicios.get(nombre);
      if (previo) {
        servicios.set(nombre, { ...previo, veces: previo.veces + veces });
      } else {
        servicios.set(nombre, { nombre, modulo: fila.modulo, veces });
      }
    }

    const medicos = porMedico
      .map(fila => ({ nombre: (fila.medico ?? '').trim(), veces: fila._count._all }))
      .filter(m => m.nombre.length > 0)
      .sort((a, b) => b.veces - a.veces);

    return {
      servicios: [...servicios.values()].sort((a, b) => b.veces - a.veces),
      medicos,
      modulos: [...new Set(porServicio.map(f => f.modulo).filter((m): m is string => !!m))].sort(),
      ventasAnalizadas: total,
    };
  }
}
