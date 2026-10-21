import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { BusinessAccessService } from '../business/business-access.service';
import {
  PolicyInferenceProvider,
  validateExtraction,
  groundExtraction,
} from './policy-inference.provider';
import { PolicyInferenceService } from './policy-inference.service';
import type { PolicyExtraction } from './policy-inference.types';

const extraction = (
  changes: Partial<PolicyExtraction> = {},
): PolicyExtraction => ({
  name: 'Engineering vacation',
  summary: 'Engineering employees have seven days off.',
  groupIds: ['eng'],
  employeeIds: [],
  employmentTypeIds: [],
  allEmployees: false,
  durationDays: 7,
  startsOn: '2027-12-18',
  endsOn: '2027-12-24',
  constraints: [],
  missing: [],
  ...changes,
});
const refs = {
  selectedClass: { id: 'vac', name: 'Vacation' },
  groups: [{ id: 'eng', name: 'Engineering' }],
  employees: [],
  employmentTypes: [],
  canViewEmployees: false,
  employeeDirectoryTruncated: false,
};
function harness(changes: Partial<PolicyExtraction> = {}) {
  const prisma = {
    policyClass: { findFirst: jest.fn().mockResolvedValue(refs.selectedClass) },
    employeeGroup: { findMany: jest.fn().mockResolvedValue(refs.groups) },
    employeeType: {
      findMany: jest.fn().mockResolvedValue([{ id: 'ft', name: 'Full time' }]),
    },
    businessEmployee: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'emeka', fullName: 'Emeka Obi' }]),
      count: jest.fn().mockResolvedValue(4),
    },
  };
  const access = {
    require: jest.fn().mockResolvedValue({
      permissions: ['policies:view', 'policies:create', 'employees:view'],
    }),
  };
  const provider = {
    extract: jest.fn().mockResolvedValue({
      extraction: extraction(changes),
      model: 'sample:free',
    }),
  };
  const service = new PolicyInferenceService(
    prisma as unknown as PrismaService,
    access as unknown as BusinessAccessService,
    provider as unknown as PolicyInferenceProvider,
  );
  return { service, prisma, access, provider };
}

describe('policy AI draft boundary', () => {
  it('validates references against the tenant and produces a compatible form payload without saving', async () => {
    const { service, prisma } = harness();
    const result = await service.infer(
      'user',
      'business',
      'vac',
      'Engineering gets seven days, December 18–24, 2027.',
    );
    expect(prisma.policyClass.findFirst).toHaveBeenCalledWith({
      where: { businessId: 'business', id: 'vac' },
      select: { id: true, name: true },
    });
    expect(prisma.employeeGroup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { businessId: 'business', status: 'active' },
      }),
    );
    expect(result.status).toBe('ready_for_review');
    expect(result.persistence.createPayload).toMatchObject({
      classId: 'vac',
      groupId: 'eng',
      startsOn: '2027-12-18',
      endsOn: '2027-12-24',
    });
    expect(result.affectedPeople).toMatchObject({
      candidateCount: 4,
      constraintsEvaluated: false,
    });
  });
  it('preserves constraints, employment types and individual audiences but prevents lossy saving', async () => {
    const { service, prisma } = harness({
      employeeIds: ['emeka'],
      employmentTypeIds: ['ft'],
      constraints: ['Only after 3 months tenure'],
    });
    const result = await service.infer(
      'user',
      'business',
      'vac',
      'Emeka and full-time Engineering after three months.',
    );
    expect(result.draft.constraints).toEqual(['Only after 3 months tenure']);
    expect(result.persistence.canCreateWithCurrentApi).toBe(false);
    expect(result.persistence.createPayload).toBeNull();
    expect(result.affectedPeople.employees).toEqual([
      { id: 'emeka', name: 'Emeka Obi' },
    ]);
    expect(prisma.businessEmployee.count).toHaveBeenCalledWith({
      where: {
        businessId: 'business',
        status: 'active',
        OR: [
          { groups: { some: { groupId: { in: ['eng'] } } } },
          { id: { in: ['emeka'] } },
        ],
        employeeTypeId: { in: ['ft'] },
      },
    });
  });
  it('returns AI missing questions with current choices and retains clarification history', async () => {
    const { service, provider } = harness({
      startsOn: null,
      endsOn: null,
      missing: [{ field: 'startsOn', message: 'Which exact dates and year?' }],
    });
    const result = await service.infer(
      'user',
      'business',
      'vac',
      'A week in December',
      ['Engineering'],
    );
    expect(result.status).toBe('needs_input');
    expect(result.questions[0].message).toBe('Which exact dates and year?');
    expect(result.continuation).toMatchObject({
      text: 'A week in December',
      followUps: ['Engineering'],
    });
    expect(provider.extract).toHaveBeenCalledWith(
      'A week in December',
      ['Engineering'],
      expect.any(Object),
    );
  });
  it('adds missing audience and date validation even when the model claims completeness', async () => {
    const { service } = harness({
      groupIds: [],
      allEmployees: null,
      startsOn: '2027-02-30',
      endsOn: null,
    });
    const result = await service.infer('u', 'b', 'vac', 'Some leave');
    expect(result.questions.map((q) => q.field)).toEqual(
      expect.arrayContaining(['audience', 'startsOn', 'endsOn']),
    );
    expect(result.affectedPeople.candidateCount).toBeNull();
    expect(result.persistence.createPayload).toBeNull();
  });
  it('blocks reversed dates and an allowance exceeding the date window', async () => {
    const { service, provider } = harness({
      startsOn: '2027-12-24',
      endsOn: '2027-12-18',
    });
    expect(
      (await service.infer('u', 'b', 'vac', 'Reversed dates')).questions.some(
        (q) => q.field === 'endsOn',
      ),
    ).toBe(true);
    provider.extract.mockResolvedValue({
      extraction: extraction({ durationDays: 8 }),
      model: 'sample:free',
    });
    expect(
      (
        await service.infer('u', 'b', 'vac', 'Eight days in seven')
      ).questions.some((q) => q.field === 'durationDays'),
    ).toBe(true);
  });
  it('does not require vacation dates for non-temporal equipment drafts', async () => {
    const { service } = harness({
      durationDays: null,
      startsOn: null,
      endsOn: null,
      constraints: ['One laptop during onboarding'],
    });
    const result = await service.infer(
      'u',
      'b',
      'vac',
      'HR receives one laptop during onboarding.',
    );
    expect(result.questions).toEqual([]);
    expect(result.persistence.createPayload).toBeNull();
    expect(result.draft.constraints).toHaveLength(1);
  });
  it('asks for exact allowance dates even if the model omits its missing-information questions', async () => {
    const { service } = harness({ startsOn: null, endsOn: null, missing: [] });
    const result = await service.infer(
      'u',
      'b',
      'vac',
      'Engineering gets one week in December',
    );
    expect(result.status).toBe('needs_input');
    expect(result.questions.map((q) => q.field)).toEqual([
      'startsOn',
      'endsOn',
    ]);
  });
  it('rejects foreign model references and unauthorized or foreign class requests before inference', async () => {
    const { service, provider, access, prisma } = harness({
      groupIds: ['foreign-group'],
    });
    await expect(
      service.infer('u', 'b', 'vac', 'Leave'),
    ).rejects.toBeInstanceOf(BadGatewayException);
    provider.extract.mockClear();
    prisma.policyClass.findFirst.mockResolvedValue(null);
    await expect(
      service.infer('u', 'b', 'foreign', 'Leave'),
    ).rejects.toBeInstanceOf(NotFoundException);
    access.require.mockRejectedValue(new ForbiddenException());
    await expect(
      service.infer('u', 'b', 'vac', 'Leave'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(provider.extract).not.toHaveBeenCalled();
  });
  it('withholds employee directory and counts without employee-view permission', async () => {
    const { service, access, prisma, provider } = harness();
    access.require.mockResolvedValue({
      permissions: ['policies:view', 'policies:create'],
    });
    const result = await service.infer('u', 'b', 'vac', 'Engineering leave');
    expect(prisma.businessEmployee.findMany).not.toHaveBeenCalled();
    expect(prisma.businessEmployee.count).not.toHaveBeenCalled();
    expect(result.affectedPeople.candidateCount).toBeNull();
    const calls = provider.extract.mock.calls as unknown[][];
    expect(calls[0][2]).toMatchObject({
      employees: [],
      canViewEmployees: false,
    });
  });
  it('bounds input and blocks concurrent and excessive calls', async () => {
    const { service, provider } = harness();
    await expect(
      service.infer('u', 'b', 'vac', 'x'.repeat(2001)),
    ).rejects.toBeInstanceOf(BadRequestException);
    let release!: (value: unknown) => void;
    provider.extract.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = service.infer('u', 'b', 'vac', 'Leave');
    while (!release)
      await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(
      service.infer('u', 'b', 'vac', 'Duplicate'),
    ).rejects.toMatchObject({ status: 429 });
    release({ extraction: extraction(), model: 'sample:free' });
    await first;
    for (let i = 0; i < 9; i++) await service.infer('u', 'b', 'vac', 'Leave');
    await expect(
      service.infer('u', 'b', 'vac', 'Too many'),
    ).rejects.toMatchObject({ status: 429 });
  });
});

describe('free OpenRouter inference provider', () => {
  it('does not accept invented years, days or people that were only present in context', () => {
    const draft = extraction({
      employeeIds: ['emeka'],
      startsOn: '2027-12-18',
      endsOn: '2027-12-24',
    });
    const context = {
      ...refs,
      employees: [{ id: 'emeka', name: 'Emeka Obi' }],
    };
    const first = groundExtraction(
      draft,
      'Engineering gets one week in December',
      [],
      context,
    );
    expect(first.startsOn).toBeNull();
    expect(first.endsOn).toBeNull();
    expect(first.employeeIds).toEqual([]);
    expect(first.missing.map((q) => q.field)).toEqual(['startsOn', 'endsOn']);
    const followUp = groundExtraction(
      draft,
      'Engineering gets one week in December',
      ['Emeka Obi too, December 18–24, 2027'],
      context,
    );
    expect(followUp.startsOn).toBe('2027-12-18');
    expect(followUp.employeeIds).toEqual(['emeka']);
    expect(
      groundExtraction(draft, 'One week in December 2027', [], context)
        .startsOn,
    ).toBeNull();
  });
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });
  const provider = (key: string | null = 'test-secret') =>
    new PolicyInferenceProvider({ get: () => key } as unknown as ConfigService);
  it('uses only the free router, zero-priced routes, schema output and no tools', async () => {
    const request = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'test:free',
          choices: [
            {
              finish_reason: 'stop',
              message: { content: JSON.stringify(extraction()) },
            },
          ],
        }),
      ),
    );
    global.fetch = request;
    expect((await provider().extract('Policy', [], refs)).model).toBe(
      'test:free',
    );
    const calls = request.mock.calls as unknown[][];
    const options = calls[0][1] as RequestInit;
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'xingchen-agi/xing4.0-29b-a4b:free',
      provider: { max_price: { prompt: 0, completion: 0 } },
      response_format: { type: 'json_object' },
    });
    expect(body.tools).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('test-secret');
  });
  it('handles missing configuration, quota errors and provider errors without leaking secrets', async () => {
    const request = jest.fn();
    global.fetch = request;
    await expect(
      provider(null).extract('Policy', [], refs),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValue(new Response('provider-secret', { status: 429 }));
    await expect(provider().extract('Policy', [], refs)).rejects.toMatchObject({
      status: 429,
    });
    request.mockResolvedValue(new Response('provider-secret', { status: 401 }));
    await expect(provider().extract('Policy', [], refs)).rejects.toThrow(
      'temporarily unavailable',
    );
    request.mockRejectedValue(new Error('test-secret'));
    try {
      await provider().extract('Policy', [], refs);
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as Error).message).not.toContain('test-secret');
    }
  });
  it('rejects truncated, malformed and schema-invalid output', async () => {
    for (const [content, finish_reason] of [
      ['{}', 'stop'],
      [JSON.stringify(extraction()), 'length'],
      ['not JSON', 'stop'],
    ]) {
      global.fetch = jest.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ finish_reason, message: { content } }],
          }),
        ),
      );
      await expect(
        provider().extract('Policy', [], refs),
      ).rejects.toBeInstanceOf(HttpException);
    }
    for (const invalid of [
      null,
      [],
      {},
      extraction({ groupIds: ['eng', 'eng'] }),
      extraction({ durationDays: -1 }),
      { ...extraction(), extra: 'unexpected' },
      extraction({ missing: [{ field: 'audience', message: '' }] }),
    ])
      expect(() => validateExtraction(invalid)).toThrow(BadGatewayException);
  });
});
