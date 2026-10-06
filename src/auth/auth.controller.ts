import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthCookieService } from '../auth-cookie/auth-cookie.service';
import { LocationService } from '../location/location.service';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResendEmailVerificationDto } from './dto/resend-email-verification.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { RefreshRejectedException } from '../session/session.exceptions';
import { VerifyLoginDto } from './dto/verify-login.dto';
import { ResendLoginVerificationDto } from './dto/resend-login-verification.dto';
import { GoogleOAuthCallbackDto } from './dto/google-oauth-callback.dto';
import {
  GoogleAccountLinkRequiredError,
  GoogleOAuthFlowError,
} from '../google-auth/google-auth.exceptions';
import { AccessTokenGuard } from '../auth-guard/access-token.guard';
import type { AuthenticatedRequest } from '../auth-guard/authenticated-request';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly authCookies: AuthCookieService,
    private readonly locations: LocationService,
  ) {}

  @Get('google')
  async beginGoogleLogin(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const authorization = await this.authService.beginGoogleLogin(
      this.locations.getRequestContext(request),
    );
    this.authCookies.setGoogleOAuthStateCookie(
      response,
      authorization.state,
      authorization.expiresAt,
    );
    response.redirect(HttpStatus.FOUND, authorization.url);
  }

  @Get('google/callback')
  async completeGoogleLogin(
    @Query() query: GoogleOAuthCallbackDto,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const expectedState = this.authCookies.getGoogleOAuthState(request);
    const isLinkCallback = await this.authService.isGoogleLinkCallback(
      query.state,
    );
    this.authCookies.clearGoogleOAuthStateCookie(response);

    try {
      if (isLinkCallback) {
        await this.authService.linkGoogleAccount(
          {
            code: query.code,
            state: query.state,
            error: query.error,
            expectedState,
            accessToken: this.authCookies.getAccessToken(request),
          },
          this.locations.getRequestContext(request),
        );
        response.redirect(
          HttpStatus.FOUND,
          this.authService.googleLinkCallbackRedirect('success'),
        );
        return;
      }
      const result = await this.authService.loginWithGoogle(
        {
          code: query.code,
          state: query.state,
          error: query.error,
          expectedState,
        },
        this.locations.getRequestContext(request),
      );

      if (result.status === 'verification-required') {
        response.redirect(
          HttpStatus.FOUND,
          this.authService.googleCallbackRedirect(
            'verification-required',
            result.challengeId,
          ),
        );
        return;
      }

      this.authCookies.setAuthCookies(response, result.session.tokens);
      response.redirect(
        HttpStatus.FOUND,
        this.authService.googleCallbackRedirect('success'),
      );
    } catch (error: unknown) {
      const reason =
        error instanceof GoogleAccountLinkRequiredError
          ? 'account-link-required'
          : error instanceof GoogleOAuthFlowError
            ? `flow:${error.reason}`
            : error instanceof Error
              ? error.message
              : 'unknown';
      this.logger.warn(
        `Google ${isLinkCallback ? 'link' : 'login'} callback failed: ${reason} (state=${query.state ?? 'missing'}, providerError=${query.error ?? 'none'})`,
      );
      if (isLinkCallback) {
        response.redirect(
          HttpStatus.FOUND,
          this.authService.googleLinkCallbackRedirect('failed'),
        );
        return;
      }
      response.redirect(
        HttpStatus.FOUND,
        this.authService.googleCallbackRedirect(
          error instanceof GoogleAccountLinkRequiredError
            ? 'account-link-required'
            : 'failed',
        ),
      );
    }
  }

  @Post('google/link')
  @UseGuards(AccessTokenGuard)
  @HttpCode(HttpStatus.OK)
  async beginGoogleLink(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const authorization = await this.authService.beginGoogleLink(
      request.auth.userId,
      request.auth.userSessionId,
      this.locations.getRequestContext(request),
    );
    this.authCookies.setGoogleOAuthStateCookie(
      response,
      authorization.state,
      authorization.expiresAt,
    );
    return { url: authorization.url };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() loginDto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.login(
      loginDto,
      this.locations.getRequestContext(request),
    );

    if (result.status === 'verification-required') {
      return {
        message: 'A login verification code has been sent.',
        requiresTwoFactor: true,
        challengeId: result.challengeId,
      };
    }

    this.authCookies.setAuthCookies(response, result.session.tokens);

    return {
      message: 'Login successful',
      user: result.user,
    };
  }

  @Post('login-verification/verify')
  @HttpCode(HttpStatus.OK)
  async verifyLogin(
    @Body() verifyLoginDto: VerifyLoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.verifyLogin(
      verifyLoginDto,
      this.locations.getRequestContext(request),
    );
    this.authCookies.setAuthCookies(response, result.session.tokens);

    return {
      message: 'Login successful',
      user: result.user,
    };
  }

  @Post('login-verification/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  resendLoginVerification(
    @Body() resendDto: ResendLoginVerificationDto,
    @Req() request: Request,
  ) {
    return this.authService.resendLoginVerification(
      resendDto,
      this.locations.getRequestContext(request),
    );
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    try {
      const tokens = await this.authService.refreshAuthSession(
        this.authCookies.getRefreshToken(request),
        this.locations.getRequestContext(request),
      );
      this.authCookies.setAuthCookies(response, tokens);

      return { message: 'Session refreshed successfully' };
    } catch (error: unknown) {
      if (error instanceof RefreshRejectedException) {
        this.authCookies.clearAuthCookies(response);
      }

      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    try {
      await this.authService.logout(
        this.authCookies.getRefreshToken(request),
        this.locations.getRequestContext(request),
      );
    } finally {
      this.authCookies.clearAuthCookies(response);
    }
    return { message: 'Logged out successfully' };
  }

  @Post('register')
  register(@Body() registerDto: RegisterDto, @Req() request: Request) {
    return this.authService.registerUser(
      registerDto,
      this.locations.getRequestContext(request),
    );
  }

  @Post('email-verification/verify')
  @HttpCode(HttpStatus.OK)
  verifyEmail(@Body() verifyEmailDto: VerifyEmailDto, @Req() request: Request) {
    return this.authService.verifyEmail(
      verifyEmailDto,
      this.locations.getRequestContext(request),
    );
  }

  @Post('email-verification/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  resendEmailVerification(
    @Body() resendDto: ResendEmailVerificationDto,
    @Req() request: Request,
  ) {
    return this.authService.resendEmailVerification(
      resendDto,
      this.locations.getRequestContext(request),
    );
  }
}
