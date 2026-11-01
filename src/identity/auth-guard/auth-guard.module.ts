import { Global, Module } from '@nestjs/common';
import { AuthTokenModule } from '../auth-token/auth-token.module';
import { AccessTokenGuard } from './access-token.guard';

@Global()
@Module({
  imports: [AuthTokenModule],
  providers: [AccessTokenGuard],
  exports: [AccessTokenGuard, AuthTokenModule],
})
export class AuthGuardModule {}
