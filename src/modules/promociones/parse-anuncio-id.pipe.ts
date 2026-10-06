import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

import { ANUNCIO_ID } from './dto/promocion.dto';

/** El id de un anuncio de Meta viaja en la URL: se valida antes de llegar al service. */
@Injectable()
export class ParseAnuncioIdPipe implements PipeTransform<string, string> {
  transform(valor: string): string {
    if (!ANUNCIO_ID.test(valor)) throw new BadRequestException('Ese no parece el id de un anuncio de Meta (solo dígitos).');
    return valor;
  }
}
