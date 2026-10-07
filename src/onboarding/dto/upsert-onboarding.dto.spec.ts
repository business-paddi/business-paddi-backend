import { ValidationPipe } from '@nestjs/common';
import { UpsertOnboardingDto } from './upsert-onboarding.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const parse = (body: unknown) =>
  pipe.transform(body, { type: 'body', metatype: UpsertOnboardingDto });

describe('Lightweight onboarding validation', () => {
  it('allows all questions to be omitted', async () => {
    await expect(parse({})).resolves.toEqual({});
  });

  it('allows clearing answers and trims optional referral details', async () => {
    await expect(
      parse({
        useCases: [],
        usage: null,
        referralSource: 'other',
        referralDetails: '  Forum  ',
      }),
    ).resolves.toMatchObject({
      useCases: [],
      usage: null,
      referralSource: 'other',
      referralDetails: 'Forum',
    });
    await expect(parse({ referralDetails: '   ' })).resolves.toMatchObject({
      referralDetails: null,
    });
  });

  it.each([
    { useCases: null },
    { useCases: ['unknown'] },
    { useCases: ['explore', 'explore'] },
    { usage: 'owner' },
    { referralSource: 'invalid' },
    { referralDetails: 'x'.repeat(201) },
    { business: { name: 'Old flow' } },
    { staff: [] },
    { completedAt: 'now' },
  ])('rejects malformed or legacy input %j', async (body) => {
    await expect(parse(body)).rejects.toThrow();
  });
});
