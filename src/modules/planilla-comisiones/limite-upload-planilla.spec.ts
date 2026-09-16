import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { AnaliticaComisionesService } from './analitica-comisiones.service';
import { CalculoComisionesService } from './calculo-comisiones.service';
import { ConfiguracionComisionesService } from './configuracion-comisiones.service';
import { ExportacionComisionesService } from './exportacion-comisiones.service';
import { ExportacionMetricasService } from './exportacion-metricas.service';
import { ExportacionWordService } from './exportacion-word.service';
import { PlanillaComisionesController } from './planilla-comisiones.controller';
import { PlanillaComisionesService } from './planilla-comisiones.service';
import { ResumenAnualService } from './resumen-anual.service';

/**
 * El tope del Excel se comprobaba DESPUÉS de tener el archivo entero en RAM.
 *
 * `FileInterceptor('archivo')` iba sin `limits`, así que multer materializaba
 * cualquier tamaño antes de que el handler mirase `archivo.size`. En un VPS de
 * un núcleo con `MemoryMax=400M` compartido con el webhook de WhatsApp, eso es
 * un OOM por subir el archivo equivocado — que es el caso realista, porque solo
 * SUPER_ADMIN llega aquí y los guards corren antes que los interceptores.
 *
 * Estas pruebas fijan las dos mitades del arreglo: que multer corte el flujo, y
 * que el margen entre su tope y el de negocio siga dejando pasar el mensaje
 * legible. No usan PostgreSQL: el service va con doble, porque lo que se prueba
 * es el transporte.
 */

const importar = jest.fn();
const vacio = {};

@Module({
  controllers: [PlanillaComisionesController],
  providers: [
    { provide: PlanillaComisionesService, useValue: { importar } },
    { provide: CalculoComisionesService, useValue: vacio },
    { provide: ConfiguracionComisionesService, useValue: vacio },
    { provide: AnaliticaComisionesService, useValue: vacio },
    { provide: ExportacionComisionesService, useValue: vacio },
    { provide: ExportacionWordService, useValue: vacio },
    { provide: ExportacionMetricasService, useValue: vacio },
    { provide: ResumenAnualService, useValue: vacio },
  ],
})
class ModuloSoloImportar {}

let app: INestApplication;
let base: string;

/**
 * Sin guards: el alcance por rol ya lo cubre `autorizacion-http.integracion`.
 * El handler necesita `request.user` porque lee `usuario.sub`, así que lo pone
 * un middleware — el sitio donde el guard real lo dejaría.
 */
beforeAll(async () => {
  app = await NestFactory.create(ModuloSoloImportar, { logger: false, abortOnError: false });
  app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { sub: 'super-ficticio', email: 'super@test', nombre: 'Super', rol: 'SUPER_ADMIN' };
    next();
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: false } }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
}, 30_000);

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  importar.mockReset();
  importar.mockResolvedValue({ ok: true });
});

const LIMITE = '--------------------------crm-planilla';

/**
 * Un multipart de verdad: es el flujo que multer tiene que cortar.
 *
 * Devuelve un `ArrayBuffer` y no el `Buffer` de `concat`. Desde TypeScript 5.7
 * los arrays tipados son genéricos sobre `ArrayBufferLike`, y ningún miembro de
 * `BodyInit` acepta esa forma: `Buffer.concat(...)`, un `Uint8Array` nuevo y
 * cualquier vista sobre su `.buffer` fallan los tres contra `fetch`. Corren
 * igual, pero el typecheck estricto de los tests los rechaza, y aquí eso es un
 * error. `ArrayBuffer` sí entra sin condiciones.
 */
function cuerpoMultipart(archivos: Array<{ nombre: string; bytes: number }>): ArrayBuffer {
  const partes: Buffer[] = [];
  for (const { nombre, bytes } of archivos) {
    partes.push(
      Buffer.from(
        `--${LIMITE}\r\n` +
          `Content-Disposition: form-data; name="archivo"; filename="${nombre}"\r\n` +
          'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n',
      ),
      Buffer.alloc(bytes, 0x41),
      Buffer.from('\r\n'),
    );
  }
  partes.push(Buffer.from(`--${LIMITE}--\r\n`));
  const cuerpo = Buffer.concat(partes);
  const salida = new ArrayBuffer(cuerpo.byteLength);
  new Uint8Array(salida).set(cuerpo);
  return salida;
}

async function importarCon(archivos: Array<{ nombre: string; bytes: number }>) {
  const respuesta = await fetch(`${base}/planilla-comisiones/importar`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${LIMITE}` },
    body: cuerpoMultipart(archivos),
  });
  const texto = await respuesta.text();
  return { status: respuesta.status, texto };
}

const MB = 1024 * 1024;

describe('límite de subida de la planilla', () => {
  it('multer corta un archivo desmesurado y el handler nunca lo ve', async () => {
    const { status } = await importarCon([{ nombre: 'planilla.xlsx', bytes: 25 * MB }]);

    /* 413, no 400: el 400 con «pesa 25,0 MB» era precisamente la señal de que
       el archivo había llegado entero a la RAM antes de rechazarse. */
    expect(status).toBe(413);
    expect(importar).not.toHaveBeenCalled();
  }, 30_000);

  it('deja pasar el mensaje legible a quien se pasa poco del tope de negocio', async () => {
    const { status, texto } = await importarCon([{ nombre: 'planilla.xlsx', bytes: 16 * MB }]);

    /* El margen de 5 MB entre el corte de multer y `TAMANO_MAXIMO_BYTES` existe
       para esto: un 413 pelado no dice cuál es el máximo ni cuánto pesa el
       archivo, y administración necesita las dos cifras. */
    expect(status).toBe(400);
    expect(texto).toContain('el máximo es 15 MB');
    expect(importar).not.toHaveBeenCalled();
  }, 30_000);

  it('un Excel de tamaño normal sigue llegando al service', async () => {
    const { status } = await importarCon([{ nombre: 'planilla.xlsx', bytes: 64 * 1024 }]);

    expect(status).toBe(201);
    expect(importar).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('no se cuela una segunda parte de archivo', async () => {
    const { status } = await importarCon([
      { nombre: 'planilla.xlsx', bytes: 64 * 1024 },
      { nombre: 'otra.xlsx', bytes: 64 * 1024 },
    ]);

    /* Quien corta aquí es el `.single()` de `FileInterceptor`, no el `files: 1`
       que lo acompaña: se comprobó quitándolo y esta prueba seguía en verde.
       El `files: 1` se queda por decir la intención en el mismo sitio que sus
       dos vecinos (Ventas y Memoria), no porque sea lo que sostiene el límite.
       Lo que fija esta prueba es la conducta: una segunda parte no entra. */
    expect(status).toBe(400);
    expect(importar).not.toHaveBeenCalled();
  }, 30_000);
});
