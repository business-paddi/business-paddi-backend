import { Module } from '@nestjs/common';
import { LoginVerificationService } from './login-verification.service';

@Module({
  providers: [LoginVerificationService],
  exports: [LoginVerificationService],
})
export class LoginVerificationModule {}
