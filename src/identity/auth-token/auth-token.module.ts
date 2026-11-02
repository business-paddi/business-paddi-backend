import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthTokenService } from './auth-token.service';

@Module({
  imports: [JwtModule.register({})],
  providers: [AuthTokenService],
  exports: [AuthTokenService],
})
export class AuthTokenModule {}
