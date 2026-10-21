import { Module } from '@nestjs/common';
import { BusinessAccessService } from '../business/business-access.service';
import { PolicyController } from './policy.controller';
import { PolicyService } from './policy.service';
import { PolicyChatService } from './policy-chat.service';
// AI drafting temporarily disabled.
// import { PolicyInferenceProvider } from './policy-inference.provider';
// AI drafting temporarily disabled.
// import { PolicyInferenceService } from './policy-inference.service';

@Module({
  controllers: [PolicyController],
  providers: [
    PolicyService,
    PolicyChatService,
    BusinessAccessService,
    // PolicyInferenceProvider,
    // PolicyInferenceService,
  ],
})
export class PolicyModule {}
