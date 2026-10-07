export const PUBLIC_PREFERENCES_SELECT = {
  desktopNotifications: true,
  twoFactorEnabled: true,
  onboardingUseCases: true,
  onboardingUsage: true,
  onboardingReferralSource: true,
  onboardingReferralDetails: true,
  onboardingCompletedAt: true,
} as const;

interface StoredPreferences {
  desktopNotifications: boolean;
  twoFactorEnabled: boolean;
  onboardingUseCases: string[];
  onboardingUsage: string | null;
  onboardingReferralSource: string | null;
  onboardingReferralDetails: string | null;
  onboardingCompletedAt: Date | null;
}

export function toOnboardingPreferences(preferences: StoredPreferences | null) {
  return {
    useCases: preferences?.onboardingUseCases ?? [],
    usage: preferences?.onboardingUsage ?? null,
    referralSource: preferences?.onboardingReferralSource ?? null,
    referralDetails: preferences?.onboardingReferralDetails ?? null,
    completedAt: preferences?.onboardingCompletedAt ?? null,
  };
}

export function toPublicPreferences(preferences: StoredPreferences | null) {
  return {
    desktopNotifications: preferences?.desktopNotifications ?? true,
    twoFactorEnabled: preferences?.twoFactorEnabled ?? false,
    onboarding: toOnboardingPreferences(preferences),
  };
}
