-- AlterTable
ALTER TABLE "UserPreference" ADD COLUMN     "onboardingCompletedAt" TIMESTAMPTZ(3),
ADD COLUMN     "onboardingReferralDetails" VARCHAR(200),
ADD COLUMN     "onboardingReferralSource" VARCHAR(40),
ADD COLUMN     "onboardingUsage" VARCHAR(20),
ADD COLUMN     "onboardingUseCases" TEXT[] DEFAULT ARRAY[]::TEXT[];
