import { PickType } from '@nestjs/mapped-types';

import { UpdateUsuarioDto } from '../../usuarios/dto/update-usuario.dto';

/** El perfil propio no es una puerta a la gestión administrativa de Usuarios. */
export class UpdatePerfilDto extends PickType(
  UpdateUsuarioDto,
  ['nombre', 'email', 'password', 'foto'] as const,
) {}
