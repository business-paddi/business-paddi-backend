import { toPublicPreferences } from './onboarding-preferences';

describe('Public user preferences', () => {
  it('provides a stable nested onboarding shape for users without preferences', () => {
    expect(toPublicPreferences(null)).toEqual({
      desktopNotifications: true,
      twoFactorEnabled: false,
      onboarding: {
        useCases: [],
        usage: null,
        referralSource: null,
        referralDetails: null,
        completedAt: null,
      },
    });
  });

  it('exposes onboarding inside preferences without leaking database column names', () => {
    const completedAt = new Date('2026-10-07T12:00:00Z');
    expect(
      toPublicPreferences({
        desktopNotifications: false,
        twoFactorEnabled: true,
        onboardingUseCases: ['personal_records', 'calculate_taxes'],
        onboardingUsage: 'employee',
        onboardingReferralSource: 'search_engine',
        onboardingReferralDetails: null,
        onboardingCompletedAt: completedAt,
      }),
    ).toEqual({
      desktopNotifications: false,
      twoFactorEnabled: true,
      onboarding: {
        useCases: ['personal_records', 'calculate_taxes'],
        usage: 'employee',
        referralSource: 'search_engine',
        referralDetails: null,
        completedAt,
      },
    });
  });
});
