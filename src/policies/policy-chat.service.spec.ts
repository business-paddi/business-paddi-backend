import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { BusinessAccessService } from '../business/business-access.service';
import { PolicyService } from './policy.service';
import { PolicyChatService } from './policy-chat.service';

function harness() {
  const existing = [{ id: 'vacation', name: 'Vacation' }];
  const db = {
    user: { findUnique: jest.fn().mockResolvedValue({ name: 'David Okoye' }) },
    policyClass: { findMany: jest.fn().mockResolvedValue(existing) },
    businessPolicy: { count: jest.fn().mockResolvedValue(0) },
  };
  const access = {
    require: jest.fn().mockResolvedValue({
      member: { business: { name: 'Business Paddi' } },
      permissions: ['policies:view', 'policies:create'],
    }),
  };
  const policies = {
    createClasses: jest
      .fn()
      .mockResolvedValue({ classes: existing, createdCount: 1 }),
  };
  const inference = { infer: jest.fn() };
  const service = new PolicyChatService(
    db as unknown as PrismaService,
    access as unknown as BusinessAccessService,
    policies as unknown as PolicyService,
  );
  return { db, access, policies, inference, service };
}

describe('guided policy chat', () => {
  it('routes stale AI requests to the form without inference or writes', async () => {
    const { service, inference, policies } = harness();
    const result = await service.respond('user', 'business', {
      action: 'describe_policy',
      classId: 'vacation',
      text: 'One week in December',
      followUps: ['Engineering'],
      answer: 'Full time',
    });
    expect(result.step).toBe('policy_ready');
    expect(result.nextStep).toEqual({
      type: 'policy_form',
      classId: 'vacation',
    });
    expect(result.input).toEqual({ kind: 'none' });
    expect(result.inference).toBeUndefined();
    expect(inference.infer).not.toHaveBeenCalled();
    expect(policies.createClasses).not.toHaveBeenCalled();
  });

  it('does not call inference for foreign classes, unauthorized users or invalid requests', async () => {
    const { service, inference, access } = harness();
    expect(
      (
        await service.respond('user', 'business', {
          action: 'describe_policy',
          classId: 'foreign',
          text: 'Leave',
        })
      ).step,
    ).toBe('choose_class');
    await expect(
      service.respond('user', 'business', {
        action: 'describe_policy',
        classId: 'vacation',
        text: ' ',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.respond('user', 'business', {
        action: 'help',
        followUps: ['irrelevant'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    access.require.mockRejectedValue(new ForbiddenException());
    await expect(
      service.respond('user', 'business', {
        action: 'describe_policy',
        classId: 'vacation',
        text: 'Leave',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(inference.infer).not.toHaveBeenCalled();
  });
  it('welcomes a new workspace by name, explains the concepts, and offers class creation', async () => {
    const { service, db } = harness();
    db.policyClass.findMany.mockResolvedValue([]);
    const result = await service.start('user', 'business');
    expect(result.step).toBe('create_class');
    expect(result.messages[0].text).toContain('Hey David');
    expect(result.messages[0].text).toContain('Business Paddi');
    expect(result.messages.map((message) => message.text).join(' ')).toContain(
      'Classes group policies',
    );
    expect(result.replies.map((reply) => reply.request.action)).toContain(
      'create_class',
    );
    expect(result.input.kind).toBe('none');
  });

  it('lists existing classes even when no policies have been created', async () => {
    const { service } = harness();
    const result = await service.start('user', 'business');
    expect(result.step).toBe('choose_class');
    expect(result.classes).toEqual([{ id: 'vacation', name: 'Vacation' }]);
    expect(result.replies).toContainEqual({
      id: 'use_class:vacation',
      label: 'Use Vacation',
      request: { action: 'use_class', classId: 'vacation' },
    });
    expect(result.messages[0].text).not.toContain('welcome');
  });

  it('greets a returning workspace without calling it a first policy', async () => {
    const { service, db } = harness();
    db.businessPolicy.count.mockResolvedValue(3);
    expect(
      (await service.start('user', 'business')).messages[0].text,
    ).toContain('What policies');
  });

  it('does not claim that an existing workspace with no classes is new', async () => {
    const { service, db } = harness();
    db.policyClass.findMany.mockResolvedValue([]);
    db.businessPolicy.count.mockResolvedValue(2);
    const result = await service.start('user', 'business');
    expect(result.messages[0].text).not.toContain('welcome');
    expect(result.step).toBe('create_class');
  });

  it('returns a class-name composer and suggested requests without writing anything', async () => {
    const { service, policies } = harness();
    const result = await service.respond('user', 'business', {
      action: 'create_class',
    });
    expect(result.input).toMatchObject({
      kind: 'class_names',
      field: 'text',
      submit: { action: 'save_classes' },
    });
    expect(
      result.replies.some((reply) => reply.label === 'Create Vacation'),
    ).toBe(false);
    expect(
      result.replies.some((reply) => reply.label === 'Create Benefits'),
    ).toBe(true);
    expect(policies.createClasses).not.toHaveBeenCalled();
  });

  it('accepts a short class-name reply, creates audited classes through the existing service, and offers selection', async () => {
    const { service, policies, db } = harness();
    const classes = [
      { id: 'holiday', name: 'Holiday' },
      { id: 'vacation', name: 'Vacation' },
    ];
    policies.createClasses.mockResolvedValue({ classes, createdCount: 2 });
    db.policyClass.findMany.mockResolvedValue(classes);
    const result = await service.respond('user', 'business', {
      action: 'save_classes',
      text: 'Holiday and Vacation',
    });
    expect(policies.createClasses).toHaveBeenCalledWith('user', 'business', {
      text: 'Create classes Holiday and Vacation',
    });
    expect(result.step).toBe('choose_class');
    expect(result.effect).toEqual({
      type: 'classes_saved',
      classIds: ['holiday', 'vacation'],
      createdCount: 2,
    });
    expect(
      result.replies.some((reply) => reply.request.classId === 'holiday'),
    ).toBe(true);
  });

  it('supports a suggested name and keeps existing classes idempotent', async () => {
    const { service, policies } = harness();
    policies.createClasses.mockResolvedValue({
      classes: [{ id: 'vacation', name: 'Vacation' }],
      createdCount: 0,
    });
    const result = await service.respond('user', 'business', {
      action: 'save_classes',
      names: ['Vacation'],
    });
    expect(policies.createClasses).toHaveBeenCalledWith('user', 'business', {
      names: ['Vacation'],
    });
    expect(result.messages[0].text).toContain('already exist');
    expect(result.effect?.createdCount).toBe(0);
  });

  it('does not double-prefix a complete create-classes sentence', async () => {
    const { service, policies } = harness();
    await service.respond('user', 'business', {
      action: 'save_classes',
      text: 'Create classes Vacation',
    });
    expect(policies.createClasses).toHaveBeenCalledWith('user', 'business', {
      text: 'Create classes Vacation',
    });
  });

  it('keeps invalid names in the conversation while propagating operational failures', async () => {
    const { service, policies } = harness();
    policies.createClasses.mockRejectedValue(
      new BadRequestException('invalid names'),
    );
    const result = await service.respond('user', 'business', {
      action: 'save_classes',
      text: '??',
    });
    expect(result.step).toBe('create_class');
    expect(result.input.kind).toBe('class_names');
    expect(result.effect).toBeUndefined();
    policies.createClasses.mockRejectedValue(new Error('database offline'));
    await expect(
      service.respond('user', 'business', {
        action: 'save_classes',
        text: 'Vacation',
      }),
    ).rejects.toThrow('database offline');
  });

  it('selects a class using current tenant data without creating a policy', async () => {
    const { service, policies } = harness();
    const result = await service.respond('user', 'business', {
      action: 'use_class',
      classId: 'vacation',
    });
    expect(result.step).toBe('policy_ready');
    expect(result.selectedClass).toEqual({ id: 'vacation', name: 'Vacation' });
    expect(result.nextStep).toEqual({
      type: 'policy_form',
      classId: 'vacation',
    });
    expect(result.input).toEqual({ kind: 'none' });
    expect(policies.createClasses).not.toHaveBeenCalled();
  });

  it('recovers from foreign or stale class IDs without echoing them as valid selections', async () => {
    const { service, db } = harness();
    const result = await service.respond('user', 'business', {
      action: 'use_class',
      classId: 'another-business-class',
    });
    expect(result.step).toBe('choose_class');
    expect(result.selectedClass).toBeUndefined();
    expect(db.policyClass.findMany).toHaveBeenCalledWith({
      where: { businessId: 'business' },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  });

  it('checks permission before reading private context or saving classes', async () => {
    const { service, access, db, policies } = harness();
    access.require.mockRejectedValue(new ForbiddenException());
    await expect(
      service.respond('user', 'business', {
        action: 'save_classes',
        text: 'Vacation',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(db.policyClass.findMany).not.toHaveBeenCalled();
    expect(policies.createClasses).not.toHaveBeenCalled();
  });

  it('does not offer creation actions to a read-only user', async () => {
    const { service, access } = harness();
    access.require.mockResolvedValue({
      member: { business: { name: 'Business Paddi' } },
      permissions: ['policies:view'],
    });
    const result = await service.start('user', 'business');
    expect(result.step).toBe('read_only');
    expect(result.replies.map((reply) => reply.request.action)).toEqual([
      'help',
    ]);
  });

  it('uses live data after restart and keeps response messages scoped to the current turn', async () => {
    const { service, db } = harness();
    db.user.findUnique.mockResolvedValue({ name: 'Ada Okoye' });
    const result = await service.respond('user', 'business', {
      action: 'restart',
    });
    expect(result.context.firstName).toBe('Ada');
    expect(
      result.messages.every((message) => message.role === 'assistant'),
    ).toBe(true);
    expect(new Set(result.messages.map((message) => message.id)).size).toBe(
      result.messages.length,
    );
  });

  it('rejects ambiguous inputs and action/payload mismatches before saving', async () => {
    const { service, policies } = harness();
    const invalid = [
      {
        action: 'save_classes' as const,
        text: 'Vacation',
        names: ['Benefits'],
      },
      { action: 'save_classes' as const },
      { action: 'use_class' as const },
      { action: 'help' as const, classId: 'vacation' },
      { action: 'create_class' as const, text: 'Vacation' },
    ];
    for (const input of invalid)
      await expect(
        service.respond('user', 'business', input),
      ).rejects.toBeInstanceOf(BadRequestException);
    expect(policies.createClasses).not.toHaveBeenCalled();
  });
});
