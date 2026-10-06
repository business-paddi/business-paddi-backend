import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { AuthGuardModule } from '../auth-guard/auth-guard.module';

@Global()
@Module({
  imports: [AuthGuardModule],
  providers: [AuditService],
  controllers: [AuditController],
  exports: [AuditService],
})
export class AuditModule {}
