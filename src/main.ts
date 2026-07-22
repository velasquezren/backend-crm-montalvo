import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io';
import compression from 'compression';
import helmet from 'helmet';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  /**
   * Confiar en el proxy SOLO cuando el peer inmediato es loopback (Apache, que
   * corre en 127.0.0.1). Así `req.ip` toma la IP real del cliente del
   * `X-Forwarded-For` que agrega Apache, en vez de ver siempre 127.0.0.1.
   *
   * Sin esto, el rate-limit por IP no existía: TODAS las peticiones caían en
   * el mismo bucket (127.0.0.1), así que el límite de login (5/min) y el
   * general (120/min) se compartían entre todos los usuarios — 5 claves mal
   * escritas y quedaban todos bloqueados. `loopback` (no `true`) evita que un
   * atacante externo falsifique su IP mandando su propio X-Forwarded-For:
   * solo se confía en la cabecera si quien conecta es el propio Apache local.
   */
  app.set('trust proxy', 'loopback');

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

  /* Sin esto, Nest no sabe con qué adapter servir los WebSocketGateway
     (ConversacionesGateway) y las conexiones fallarían en silencio. */
  app.useWebSocketAdapter(new IoAdapter(app));

  app.useGlobalPipes(
    new ValidationPipe({
      /**
       * `whitelist` descarta las propiedades no declaradas en el DTO, así que
       * ningún campo inesperado llega a la lógica de negocio.
       *
       * NO se usa `forbidNonWhitelisted`: además de descartar, rechazaría la
       * petición con 400. Eso rompe los webhooks de Meta (WhatsApp y Lead Ads),
       * cuyos payloads traen decenas de campos que no modelamos y que cambian
       * con el tiempo; tras varios 400 Meta desactiva la suscripción. Como los
       * pipes globales se aplican siempre —un @UsePipes en el controlador se
       * suma, no lo reemplaza— la única forma de recibirlos es no activarlo.
       */
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  /**
   * En producción se escucha solo en loopback: el tráfico público entra por
   * Apache, que termina el TLS y hace de proxy inverso. Así el puerto de la
   * app nunca queda expuesto a internet sin cifrar, aunque cambie el firewall.
   * En desarrollo se deja abierto para poder probar desde otros dispositivos.
   */
  const host = process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0';
  await app.listen(process.env.PORT ?? 3001, host);
}

bootstrap();
