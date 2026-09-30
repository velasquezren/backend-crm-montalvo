import { ConflictException, Logger, NotFoundException } from '@nestjs/common';

import { candidatosDeChoqueUnico } from '../../prisma/choque-unico';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { SELECT_LINEA, whereAccesoConversacion as whereVisibilidad } from './acceso-conversacion';

/*
 * Lo que comparten los dos caminos de envío de una persona: el texto
 * (`ConversacionesService.enviarMensaje`) y las plantillas
 * (`EnvioPlantillasService`). Son funciones y no métodos para que ninguno de
 * los dos servicios tenga que depender del otro.
 */

/** Versión liviana del chequeo de propiedad de `findOne`, sin traer mensajes:
 *  la usan `enviarMensaje`/`asignarAgente`, que solo necesitan confirmar
 *  dueño + el teléfono del cliente, no el historial completo del chat. */
export async function obtenerConversacionPropia(prisma: PrismaService, id: string, soloAgenteId?: string) {
  const conversacion = await prisma.conversacion.findFirst({
    where: { id, ...whereVisibilidad(soloAgenteId) },
    select: {
      id: true,
      agenteId: true,
      clienteId: true,
      linea: { select: SELECT_LINEA },
      cliente: { select: { telefono: true, agenteId: true } },
    },
  });
  if (!conversacion) {
    throw new NotFoundException(`Conversación ${id} no encontrada`);
  }
  return conversacion;
}

/**
 * Traduce el rebote del índice único en la fila que ya existía.
 *
 * Devuelve `null` si el error no es el choque de `clientMessageId`: cualquier
 * otro fallo tiene que seguir subiendo tal cual. Confundirlos convertiría un
 * error real en un "ya estaba enviado", que es la peor mentira posible aquí.
 *
 * **La fila recuperada tiene que ser de ESTA conversación.** El índice único
 * es de toda la tabla, no por chat, así que el P2002 rebota igual venga de
 * donde venga; sin esta comprobación, un POST al chat de una paciente con una
 * clave ya usada en el de otra respondía con el mensaje de la primera —su
 * texto, su id y su conversación— y el envío que se pedía no salía nunca, sin
 * error y sin rastro. Dos daños en el mismo camino: contenido cruzando entre
 * pacientes y un mensaje tragado que la agente ve como enviado.
 *
 * La respuesta correcta a ese cruce no es devolver la fila ajena ni crear
 * otra con la misma clave —el índice lo impide—, sino declarar el conflicto
 * sin contar nada del chat original: quien pregunta no tiene por qué
 * enterarse de que existe, ni de a quién pertenece.
 */
export async function recuperarEnvioDuplicado(
  prisma: PrismaService,
  logger: Logger,
  error: unknown,
  conversacionId: string,
  clientMessageId?: string,
) {
  if (!clientMessageId) return null;
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return null;

  if (!candidatosDeChoqueUnico(error).some(campo => campo.includes('clientMessageId'))) return null;

  /* La otra petición ya la creó: para cuando el índice rebotó, la fila
     existe. Si aun así no aparece, el error no era lo que parecía y se
     devuelve null para que suba. */
  const yaCreado = await prisma.mensaje.findUnique({ where: { clientMessageId } });
  if (!yaCreado) return null;

  if (yaCreado.conversacionId !== conversacionId) {
    logger.warn(
      `clientMessageId reutilizado entre conversaciones: la clave del envío a ${conversacionId} ya pertenece a otro mensaje`,
    );
    throw new ConflictException(
      'Esta clave de envío ya pertenece a otro mensaje. Vuelve a enviarlo como un mensaje nuevo.',
    );
  }

  return yaCreado;
}
