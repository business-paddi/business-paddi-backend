import { PayrollPaymentModule } from './payroll/payments/payroll-payment.module';
import { BanksModule } from './banks/banks.module';
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { OnboardingModule } from './onboarding/onboarding.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './identity/auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './database/prisma.module';
import { RedisModule } from './redis/redis.module';
import { LocationModule } from './location/location.module';
import { AuthGuardModule } from './identity/auth-guard/auth-guard.module';
import { AuditModule } from './audit/audit.module';
import { PasswordResetModule } from './identity/password-reset/password-reset.module';
import { SensitiveActionModule } from './identity/sensitive-action/sensitive-action.module';
import { validateEnvironment } from './config/environment';
import { BusinessModule } from './business/business.module';
import { InventoryModule } from './inventory/inventory.module';
import { TasksModule } from './tasks/tasks.module';
import { ContactModule } from './public-contact/contact.module';
import { PayrollModule } from './payroll/payroll.module';
import { PolicyModule } from './policies/policy.module';
import { ReferralsModule } from './referrals/referrals.module';

@Module({
  imports: [
    PayrollPaymentModule,
    BanksModule,
    ReferralsModule,
    PolicyModule,
    PayrollModule,
    TasksModule,
    ContactModule,
    InventoryModule,
    BusinessModule,
    OnboardingModule,
    UsersModule,
    AuthModule,
    PrismaModule,
    RedisModule,
    LocationModule,
    AuthGuardModule,
    AuditModule,
    PasswordResetModule,
    SensitiveActionModule,
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnvironment,
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
