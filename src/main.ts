import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import compression from 'compression';
import helmet from 'helmet';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  /* Cabeceras de seguridad HTTP (RNF-01). */
  app.use(helmet());

  /* Compresión de respuestas: los listados con includes pesan bastante. */
  app.use(compression());

  /**
   * CORS restringido al origen del frontend.
   * Antes era `enableCors()` sin argumentos, que acepta CUALQUIER origen.
   * Configurable por env para dev/producción (lista separada por comas).
   */
  const origenes = (process.env.CORS_ORIGINS ?? 'http://localhost:4200')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: origenes,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      /* Rechaza propiedades no declaradas en el DTO en vez de ignorarlas
         en silencio: evita que un cliente mande campos inesperados. */
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  await app.listen(process.env.PORT ?? 3001);
}

bootstrap();
