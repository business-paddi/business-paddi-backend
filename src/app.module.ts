import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { OnboardingModule } from './onboarding/onboarding.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './database/prisma.module';
import { RedisModule } from './redis/redis.module';
import { LocationModule } from './location/location.module';
import { AuthGuardModule } from './auth-guard/auth-guard.module';
import { AuditModule } from './audit/audit.module';
import { PasswordResetModule } from './password-reset/password-reset.module';
import { SensitiveActionModule } from './sensitive-action/sensitive-action.module';
import { validateEnvironment } from './config/environment';
import { BusinessModule } from './business/business.module';
import { InventoryModule } from './inventory/inventory.module';
import { TasksModule } from './tasks/tasks.module';
import { ContactModule } from './public-contact/contact.module';

@Module({
  imports: [
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
