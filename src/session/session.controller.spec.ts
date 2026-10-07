import {
  type ExecutionContext,
  type INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthCookieService } from '../auth-cookie/auth-cookie.service';
import { AccessTokenGuard } from '../auth-guard/access-token.guard';
import { LocationService } from '../location/location.service';
import { SessionController } from './session.controller';
import { SessionService } from './session.service';

describe('Session location diagnostics', () => {
  let app: INestApplication;
  const context = {
    requestMetadata: { ipAddress: '197.210.29.1' },
    location: { city: 'Lagos', region: 'Lagos', country: 'Nigeria' },
  };
  const getRequestContext = jest.fn(() => context);

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [SessionController],
      providers: [
        { provide: SessionService, useValue: {} },
        { provide: AuthCookieService, useValue: {} },
        { provide: LocationService, useValue: { getRequestContext } },
      ],
    })
      .overrideGuard(AccessTokenGuard)
      .useValue({
        canActivate(execution: ExecutionContext) {
          const req = execution.switchToHttp().getRequest<{ headers: Record<string, string> }>();
          if (req.headers['x-test-auth'] !== 'authenticated') {
            throw new UnauthorizedException();
          }
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
    await app.init();
  });

  afterAll(async () => app.close());

  it('keeps diagnostics behind the controller authentication guard', async () => {
    getRequestContext.mockClear();
    await request(app.getHttpServer())
      .get('/api/sessions/location-diagnostics')
      .expect(401);
    expect(getRequestContext).not.toHaveBeenCalled();
  });

  it('returns the forwarding chain and current lookup without caching', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/sessions/location-diagnostics')
      .set('x-test-auth', 'authenticated')
      .set('x-forwarded-for', '197.210.29.1, 10.0.0.5')
      .expect(200)
      .expect('Cache-Control', 'no-store');
    expect(response.body).toMatchObject({
      trustProxy: 1,
      forwardedFor: '197.210.29.1, 10.0.0.5',
      resolvedIp: '197.210.29.1',
      location: context.location,
    });
    expect(response.body.socketIp).toEqual(expect.any(String));
  });
});
