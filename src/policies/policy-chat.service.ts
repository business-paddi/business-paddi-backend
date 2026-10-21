import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { BusinessAccessService } from '../business/business-access.service';
import { PrismaService } from '../database/prisma.service';
import { PolicyService } from './policy.service';
// import { PolicyInferenceService } from './policy-inference.service';
import { POLICY_CHAT_ACTIONS, PolicyChatReplyDto } from './policy-chat.dto';
import type {
  ChatClass,
  PolicyChatReply,
  PolicyChatResponse,
} from './policy-chat.types';

const POLICY_HELP =
  'A policy describes a rule or benefit for people in your business—for example, who can take a vacation or receive a work benefit.';
const CLASS_HELP =
  'Classes group policies by what they relate to, such as Payments, Vacation, Benefits, Work equipment or Documents. You choose the names that fit your business.';

@Injectable()
export class PolicyChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessAccessService,
    private readonly policies: PolicyService,
    // private readonly inference: PolicyInferenceService,
  ) {}

  private reply(
    label: string,
    request: PolicyChatReplyDto,
    id: string = request.action,
  ): PolicyChatReply {
    return { id, label, request };
  }

  private async context(userId: string, businessId: string, editing = false) {
    const access = await this.access.require(
      userId,
      businessId,
      editing ? ['policies:view', 'policies:create'] : ['policies:view'],
    );
    const [user, classes, policyCount] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true },
      }),
      this.prisma.policyClass.findMany({
        where: { businessId },
        select: { id: true, name: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.businessPolicy.count({ where: { businessId } }),
    ]);
    if (!user) throw new NotFoundException('User not found');
    return {
      classes,
      context: {
        businessId,
        businessName: access.member.business.name,
        firstName: user.name.trim().split(/\s+/)[0] || 'there',
        policyCount,
        classCount: classes.length,
        canCreate: access.permissions.includes('policies:create'),
      },
    };
  }

  private response(
    data: Awaited<ReturnType<PolicyChatService['context']>>,
    step: PolicyChatResponse['step'],
    texts: string[],
    replies: PolicyChatReply[],
    extra: Partial<PolicyChatResponse> = {},
  ): PolicyChatResponse {
    return {
      flowVersion: 1,
      mode: 'guided',
      step,
      context: data.context,
      classes: data.classes,
      messages: texts.map((text) => ({
        id: randomUUID(),
        role: 'assistant',
        text,
      })),
      replies,
      input: { kind: 'none' },
      ...extra,
    };
  }

  private choose(
    data: Awaited<ReturnType<PolicyChatService['context']>>,
    texts: string[],
  ): PolicyChatResponse {
    if (!data.context.canCreate)
      return this.response(
        data,
        'read_only',
        [
          ...texts,
          'You can view policies here. Ask a business administrator for permission to create policies and classes.',
        ],
        [this.reply('What are policies and classes?', { action: 'help' })],
      );
    if (!data.classes.length)
      return this.response(
        data,
        'create_class',
        [...texts, 'You do not have any classes yet. Let’s start there.'],
        [
          this.reply('I want to create a class', { action: 'create_class' }),
          this.reply('Explain policies and classes', { action: 'help' }),
        ],
      );
    return this.response(
      data,
      'choose_class',
      [
        ...texts,
        'Here are your existing classes. Which one will we add a policy to today, or would you like to create a class?',
      ],
      [
        ...data.classes.map((item) =>
          this.reply(
            `Use ${item.name}`,
            { action: 'use_class', classId: item.id },
            `use_class:${item.id}`,
          ),
        ),
        this.reply('I want to create a class', { action: 'create_class' }),
        this.reply('Explain policies and classes', { action: 'help' }),
      ],
    );
  }

  private classPrompt(
    data: Awaited<ReturnType<PolicyChatService['context']>>,
    feedback?: string,
  ): PolicyChatResponse {
    const suggestions = [
      'Payments',
      'Vacation',
      'Benefits',
      'Work equipment',
      'Documents',
    ];
    return this.response(
      data,
      'create_class',
      [
        ...(feedback ? [feedback] : []),
        'What would you like to call your classes?',
        CLASS_HELP,
        'Choose a suggestion to create that class, or type your own names—for example, “Holiday and Vacation”.',
      ],
      [
        ...suggestions
          .filter(
            (name) =>
              !data.classes.some(
                (item) => item.name.toLowerCase() === name.toLowerCase(),
              ),
          )
          .map((name) =>
            this.reply(
              `Create ${name}`,
              { action: 'save_classes', names: [name] },
              `suggestion:${name.toLowerCase().replace(/\s+/g, '_')}`,
            ),
          ),
        this.reply(
          data.classes.length ? 'Use an existing class instead' : 'Back',
          { action: 'choose_class' },
        ),
      ],
      {
        input: {
          kind: 'class_names',
          field: 'text',
          placeholder: 'Holiday and Vacation',
          maxLength: 2000,
          submitLabel: 'Create classes',
          submit: { action: 'save_classes' },
        },
      },
    );
  }

  async start(userId: string, businessId: string): Promise<PolicyChatResponse> {
    const data = await this.context(userId, businessId);
    const { firstName, businessName, policyCount, classCount } = data.context;
    const greeting =
      policyCount === 0 && classCount === 0
        ? [
            `Hey ${firstName}, welcome to Business Paddi’s policy engine. Let’s define the rules ${businessName} will live by.`,
            POLICY_HELP,
            CLASS_HELP,
          ]
        : [
            `Hello ${firstName}! ${policyCount === 0 ? 'What will the first policy' : 'What policies will we create'} for ${businessName}${policyCount === 0 ? ' be' : ''} today?`,
          ];
    return this.choose(data, greeting);
  }

  private validate(input: PolicyChatReplyDto) {
    if (!POLICY_CHAT_ACTIONS.includes(input.action))
      throw new BadRequestException('Choose a supported chat action.');
    if (
      !['save_classes', 'describe_policy'].includes(input.action) &&
      (input.text !== undefined || input.names !== undefined)
    )
      throw new BadRequestException(
        'Class names are only accepted when saving classes.',
      );
    if (
      !['use_class', 'describe_policy'].includes(input.action) &&
      input.classId !== undefined
    )
      throw new BadRequestException(
        'A class selection is only accepted with use_class.',
      );
    if (
      ['use_class', 'describe_policy'].includes(input.action) &&
      !input.classId
    )
      throw new BadRequestException('Choose a class.');
    if (
      input.action !== 'describe_policy' &&
      (input.followUps !== undefined || input.answer !== undefined)
    )
      throw new BadRequestException(
        'Clarification answers are only accepted when describing a policy.',
      );
    if (
      input.action === 'describe_policy' &&
      (!input.text?.trim() || input.names !== undefined)
    )
      throw new BadRequestException('Describe the policy in text.');
    if (
      input.action === 'save_classes' &&
      Boolean(input.text?.trim()) === Boolean(input.names)
    )
      throw new BadRequestException(
        'Provide either class names or a text reply.',
      );
  }

  async respond(
    userId: string,
    businessId: string,
    input: PolicyChatReplyDto,
  ): Promise<PolicyChatResponse> {
    const editing = [
      'create_class',
      'save_classes',
      'use_class',
      'describe_policy',
    ].includes(input.action);
    const data = await this.context(userId, businessId, editing);
    this.validate(input);
    if (input.action === 'restart') return this.start(userId, businessId);
    if (input.action === 'help')
      return this.choose(data, [POLICY_HELP, CLASS_HELP]);
    if (input.action === 'choose_class') return this.choose(data, []);
    if (input.action === 'create_class') return this.classPrompt(data);
    if (input.action === 'describe_policy') {
      const selectedClass = data.classes.find(
        (item) => item.id === input.classId,
      );
      if (!selectedClass)
        return this.choose(data, [
          'That class is no longer available. Please choose a current class.',
        ]);
      // AI drafting is disabled; retain the integration for a later rollout.
      /*
      const followUps = [
        ...(input.followUps ?? []),
        ...(input.answer?.trim() ? [input.answer.trim()] : []),
      ];
      const inference = await this.inference.infer(
        userId,
        businessId,
        selectedClass.id,
        input.text!,
        followUps,
      );
      const needsInput = inference.status === 'needs_input';
      return this.response(
        data,
        needsInput ? 'clarify_policy' : 'review_policy',
        [
          inference.draft.summary,
          ...(needsInput
            ? inference.questions.map((q) => q.message)
            : [
                'Here is the draft for you to review. No policy has been created yet.',
              ]),
          ...(!needsInput && !inference.persistence.canCreateWithCurrentApi
            ? inference.persistence.blockers
            : []),
        ],
        [this.reply('Choose a different class', { action: 'choose_class' })],
        {
          selectedClass,
          inference,
          input: {
            kind: 'policy_clarification',
            field: 'answer',
            placeholder: needsInput
              ? 'Answer the questions above…'
              : 'Describe any corrections…',
            maxLength: 1000,
            submitLabel: needsInput ? 'Continue' : 'Refine draft',
            submit: inference.continuation,
          },
        },
      );
*/
      return this.response(
        data,
        'policy_ready',
        [
          'AI policy drafting is temporarily disabled. Use the policy form to define this policy.',
        ],
        [this.reply('Choose a different class', { action: 'choose_class' })],
        {
          selectedClass,
          nextStep: { type: 'policy_form', classId: selectedClass.id },
          input: { kind: 'none' },
        },
      );
    }
    if (input.action === 'use_class') {
      const selectedClass = data.classes.find(
        (item) => item.id === input.classId,
      );
      if (!selectedClass)
        return this.choose(data, [
          'That class is no longer available in this business. Please choose one of the current classes.',
        ]);
      return this.response(
        data,
        'policy_ready',
        [
          `${selectedClass.name} it is. The policy we describe next will belong to this class.`,
          'Use the policy form to define the policy, its affected people and any dates or conditions.',
        ],
        [
          this.reply('Choose a different class', { action: 'choose_class' }),
          this.reply('Create another class', { action: 'create_class' }),
        ],
        {
          selectedClass,
          nextStep: { type: 'policy_form', classId: selectedClass.id },
          input: { kind: 'none' },
        },
      );
    }
    try {
      const text = input.text?.trim();
      const result = await this.policies.createClasses(
        userId,
        businessId,
        input.names
          ? { names: input.names }
          : {
              text: /^create\s/i.test(text!) ? text : `Create classes ${text}`,
            },
      );
      const refreshed = await this.context(userId, businessId);
      const names = result.classes
        .map((item: ChatClass) => item.name)
        .join(', ');
      return {
        ...this.choose(refreshed, [
          result.createdCount > 0
            ? `Your classes are ready: ${names}.`
            : `These classes already exist: ${names}. You can use them right away.`,
        ]),
        effect: {
          type: 'classes_saved',
          classIds: result.classes.map((item: ChatClass) => item.id),
          createdCount: result.createdCount,
        },
      };
    } catch (error) {
      if (!(error instanceof BadRequestException)) throw error;
      return this.classPrompt(
        data,
        'I couldn’t use those class names. Try names such as “Holiday and Vacation”. Use letters, numbers, spaces, apostrophes, parentheses, slashes or hyphens, with no more than 100 characters per name and 20 classes at a time.',
      );
    }
  }
}
