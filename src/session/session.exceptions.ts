import { ConflictException, UnauthorizedException } from '@nestjs/common';

export class RefreshAlreadyRotatedException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      code: 'REFRESH_ALREADY_ROTATED',
      message: 'The refresh token has already been rotated',
    });
  }
}

export class RefreshRejectedException extends UnauthorizedException {
  constructor() {
    super({
      statusCode: 401,
      code: 'REFRESH_REJECTED',
      message: 'The refresh session is invalid',
    });
  }
}
