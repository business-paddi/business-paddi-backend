import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthCookieService } from '../auth-cookie/auth-cookie.service';
import { LocationService } from '../location/location.service';
import { ConfirmPasswordResetDto } from './dto/confirm-password-reset.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { PasswordResetService } from './password-reset.service';

@Controller('auth/password-reset')
export class PasswordResetController {
  constructor(
    private readonly passwordReset: PasswordResetService,
    private readonly locations: LocationService,
    private readonly authCookies: AuthCookieService,
  ) {}

  @Post('request')
  @HttpCode(HttpStatus.ACCEPTED)
  request(@Body() input: RequestPasswordResetDto, @Req() request: Request) {
    return this.passwordReset.request(
      input,
      this.locations.getRequestContext(request),
    );
  }

  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(
    @Body() input: ConfirmPasswordResetDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.passwordReset.confirm(
      input,
      this.locations.getRequestContext(request),
    );
    this.authCookies.clearAuthCookies(response);
    return result;
  }
}
