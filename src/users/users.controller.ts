import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth-guard/authenticated-request';
import { AccessTokenGuard } from '../auth-guard/access-token.guard';
import { LocationService } from '../location/location.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ConfirmEmailChangeDto } from './dto/confirm-email-change.dto';
import { RequestEmailChangeDto } from './dto/request-email-change.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';

@Controller('account')
@UseGuards(AccessTokenGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly locations: LocationService,
  ) {}

  @Get('me')
  @Header('Cache-Control', 'no-store')
  getCurrentUser(@Req() request: AuthenticatedRequest) {
    return this.users.getCurrentUser(request.auth.userId);
  }

  @Patch('profile')
  updateProfile(
    @Req() request: AuthenticatedRequest,
    @Body() input: UpdateUserDto,
  ) {
    return this.users.updateProfile(
      request.auth.userId,
      input,
      this.locations.getRequestContext(request),
    );
  }

  @Patch('preferences')
  updatePreferences(
    @Req() request: AuthenticatedRequest,
    @Body() input: UpdatePreferencesDto,
  ) {
    return this.users.updatePreferences(
      request.auth.userId,
      request.auth.userSessionId,
      input,
      this.locations.getRequestContext(request),
    );
  }

  @Patch('password')
  changePassword(
    @Req() request: AuthenticatedRequest,
    @Body() input: ChangePasswordDto,
  ) {
    return this.users.changePassword(
      request.auth.userId,
      request.auth.userSessionId,
      input,
      this.locations.getRequestContext(request),
    );
  }

  @Post('email-change/request')
  @HttpCode(HttpStatus.ACCEPTED)
  requestEmailChange(
    @Req() request: AuthenticatedRequest,
    @Body() input: RequestEmailChangeDto,
  ) {
    return this.users.requestEmailChange(
      request.auth.userId,
      request.auth.userSessionId,
      input,
      this.locations.getRequestContext(request),
    );
  }

  @Post('email-change/confirm')
  @HttpCode(HttpStatus.OK)
  confirmEmailChange(
    @Req() request: AuthenticatedRequest,
    @Body() input: ConfirmEmailChangeDto,
  ) {
    return this.users.confirmEmailChange(
      request.auth.userId,
      request.auth.userSessionId,
      input,
      this.locations.getRequestContext(request),
    );
  }
}
