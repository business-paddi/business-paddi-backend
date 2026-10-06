import { Module } from '@nestjs/common';
import { EmailChangeVerificationService } from './email-change-verification.service';

@Module({
  providers: [EmailChangeVerificationService],
  exports: [EmailChangeVerificationService],
})
export class EmailChangeVerificationModule {}
