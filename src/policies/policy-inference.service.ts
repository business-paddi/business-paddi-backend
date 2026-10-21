import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BusinessAccessService } from '../business/business-access.service';
import { PrismaService } from '../database/prisma.service';
import { isCalendarDate } from './policy-parser';
import { PolicyInferenceProvider } from './policy-inference.provider';
import type {
  InferenceQuestion,
  PolicyInferenceResult,
} from './policy-inference.types';

@Injectable()
export class PolicyInferenceService {
  // Prevent double submits and bound free-tier use per user/business in this process.
  private readonly requests = new Map<
    string,
    { since: number; count: number; busy: boolean }
  >();
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessAccessService,
    private readonly provider: PolicyInferenceProvider,
  ) {}

  async infer(
    userId: string,
    businessId: string,
    classId: string,
    text: string,
    followUps: string[] = [],
  ): Promise<PolicyInferenceResult> {
    const access = await this.access.require(userId, businessId, [
      'policies:view',
      'policies:create',
    ]);
    if (
      !text?.trim() ||
      text.length > 2000 ||
      followUps.length > 10 ||
      followUps.some(
        (s) => typeof s !== 'string' || !s.trim() || s.length > 1000,
      ) ||
      text.length + followUps.join('').length > 8000
    )
      throw new BadRequestException(
        'Provide a policy description and no more than ten short clarification answers (8000 characters total).',
      );
    const selectedClass = await this.prisma.policyClass.findFirst({
      where: { businessId, id: classId },
      select: { id: true, name: true },
    });
    if (!selectedClass)
      throw new NotFoundException('Choose a class in this business.');
    const now = Date.now();
    for (const [key, state] of this.requests)
      if (!state.busy && now - state.since >= 60000) this.requests.delete(key);
    const key = `${businessId}:${userId}`;
    const state = this.requests.get(key) ?? {
      since: now,
      count: 0,
      busy: false,
    };
    if (state.busy || state.count >= 10)
      throw new HttpException(
        'Please wait before asking the policy assistant again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    state.count++;
    state.busy = true;
    this.requests.set(key, state);
    try {
      const canViewEmployees = access.permissions.includes('employees:view');
      const [groups, employmentTypes, rows] = await Promise.all([
        this.prisma.employeeGroup.findMany({
          where: { businessId, status: 'active' },
          select: { id: true, name: true },
          orderBy: { id: 'asc' },
          take: 101,
        }),
        this.prisma.employeeType.findMany({
          where: { businessId, status: 'active' },
          select: { id: true, name: true },
          orderBy: { id: 'asc' },
          take: 101,
        }),
        canViewEmployees
          ? this.prisma.businessEmployee.findMany({
              where: { businessId, status: 'active' },
              select: { id: true, fullName: true },
              orderBy: { id: 'asc' },
              take: 101,
            })
          : Promise.resolve([]),
      ]);
      const employees = rows
        .slice(0, 100)
        .map((e) => ({ id: e.id, name: e.fullName }));
      const refs = {
        selectedClass,
        groups: groups.slice(0, 100),
        employmentTypes: employmentTypes.slice(0, 100),
        employees,
        employeeDirectoryTruncated: rows.length > 100,
        canViewEmployees,
      };
      const { extraction: draft, model } = await this.provider.extract(
        text,
        followUps,
        refs,
      );
      // A valid-looking but foreign/hallucinated ID is never accepted as a reference.
      for (const [ids, choices] of [
        [draft.groupIds, refs.groups],
        [draft.employeeIds, employees],
        [draft.employmentTypeIds, refs.employmentTypes],
      ] as const) {
        if (ids.some((id) => !choices.some((choice) => choice.id === id)))
          throw new BadGatewayException(
            'The policy assistant could not match the audience to this business. Please clarify the group or employee names.',
          );
      }
      const questions: InferenceQuestion[] = draft.missing.map((q) => ({
        ...q,
      }));
      const ask = (field: InferenceQuestion['field'], message: string) => {
        if (!questions.some((q) => q.field === field))
          questions.push({ field, message });
      };
      const hasSpecificAudience =
        draft.groupIds.length > 0 ||
        draft.employeeIds.length > 0 ||
        draft.employmentTypeIds.length > 0;
      if (!hasSpecificAudience && draft.allEmployees !== true)
        ask(
          'audience',
          'Which groups, employment types or employees should this policy affect, or does it apply to everyone?',
        );
      if (
        draft.allEmployees === true &&
        (draft.groupIds.length || draft.employeeIds.length)
      )
        ask(
          'audience',
          'Does this apply to everyone, or only the selected groups and employees?',
        );
      if (draft.durationDays !== null) {
        if (!draft.startsOn)
          ask(
            'startsOn',
            'When should this allowance start? Please provide the exact date including the year.',
          );
        if (!draft.endsOn)
          ask(
            'endsOn',
            'When should this allowance end? Please provide the exact date including the year.',
          );
      }
      for (const field of ['startsOn', 'endsOn'] as const)
        if (draft[field] !== null && !isCalendarDate(draft[field]))
          ask(
            field,
            'Please provide a real calendar date including the year (YYYY-MM-DD).',
          );
      if (draft.startsOn && !draft.endsOn)
        ask('endsOn', 'What is the end date, including the year?');
      if (draft.endsOn && !draft.startsOn)
        ask('startsOn', 'What is the start date, including the year?');
      if (
        draft.startsOn &&
        draft.endsOn &&
        isCalendarDate(draft.startsOn) &&
        isCalendarDate(draft.endsOn)
      ) {
        if (draft.endsOn < draft.startsOn)
          ask(
            'endsOn',
            'The end date is before the start date. What should the end date be?',
          );
        else if (
          draft.durationDays &&
          draft.durationDays >
            (Date.parse(draft.endsOn) - Date.parse(draft.startsOn)) / 86400000 +
              1
        )
          ask(
            'durationDays',
            'The allowance is longer than the selected date window. Please clarify the duration or dates.',
          );
      }
      const uniqueQuestions = questions
        .filter(
          (q, i) =>
            questions.findIndex(
              (other) => other.field === q.field && other.message === q.message,
            ) === i,
        )
        .map((q) => ({
          ...q,
          ...(['groupIds', 'audience'].includes(q.field)
            ? { options: refs.groups }
            : q.field === 'employmentTypeIds'
              ? { options: refs.employmentTypes }
              : q.field === 'employeeIds'
                ? { options: employees }
                : {}),
        }));
      const audienceUnclear = uniqueQuestions.some((q) =>
        ['audience', 'groupIds', 'employeeIds', 'employmentTypeIds'].includes(
          q.field,
        ),
      );
      const base =
        draft.groupIds.length || draft.employeeIds.length
          ? {
              OR: [
                ...(draft.groupIds.length
                  ? [{ groups: { some: { groupId: { in: draft.groupIds } } } }]
                  : []),
                ...(draft.employeeIds.length
                  ? [{ id: { in: draft.employeeIds } }]
                  : []),
              ],
            }
          : {};
      const candidateCount =
        canViewEmployees && !audienceUnclear
          ? await this.prisma.businessEmployee.count({
              where: {
                businessId,
                status: 'active',
                ...base,
                ...(draft.employmentTypeIds.length
                  ? { employeeTypeId: { in: draft.employmentTypeIds } }
                  : {}),
              },
            })
          : null;
      const blockers: string[] = [];
      if (uniqueQuestions.length)
        blockers.push(
          'Answer the clarification questions before reviewing the policy.',
        );
      if (
        draft.groupIds.length !== 1 ||
        draft.employeeIds.length ||
        draft.employmentTypeIds.length ||
        draft.allEmployees
      )
        blockers.push(
          'The current policy creation API supports one group. Broader or individual audiences remain draft-only.',
        );
      if (draft.constraints.length)
        blockers.push(
          'Additional constraints are preserved in this draft; the current creation API cannot enforce them.',
        );
      if (
        !draft.startsOn ||
        !draft.endsOn ||
        !isCalendarDate(draft.startsOn) ||
        !isCalendarDate(draft.endsOn)
      )
        blockers.push(
          'The current creation API requires exact start and end dates.',
        );
      const name = draft.name ?? `${selectedClass.name} policy`;
      const createPayload = blockers.length
        ? null
        : {
            classId,
            groupId: draft.groupIds[0],
            name,
            startsOn: draft.startsOn!,
            endsOn: draft.endsOn!,
            ...(draft.durationDays ? { durationDays: draft.durationDays } : {}),
          };
      const fields = {
        name: draft.name,
        summary: draft.summary,
        groupIds: draft.groupIds,
        employeeIds: draft.employeeIds,
        employmentTypeIds: draft.employmentTypeIds,
        allEmployees: draft.allEmployees,
        durationDays: draft.durationDays,
        startsOn: draft.startsOn,
        endsOn: draft.endsOn,
        constraints: draft.constraints,
      };
      return {
        status: uniqueQuestions.length ? 'needs_input' : 'ready_for_review',
        model,
        draft: { ...fields, name, classId, className: selectedClass.name },
        questions: uniqueQuestions,
        affectedPeople: {
          candidateCount,
          constraintsEvaluated: false,
          groups: refs.groups.filter((g) => draft.groupIds.includes(g.id)),
          employees: employees.filter((e) => draft.employeeIds.includes(e.id)),
          employmentTypes: refs.employmentTypes.filter((e) =>
            draft.employmentTypeIds.includes(e.id),
          ),
          matching: 'groups_or_named_employees_then_employment_type',
        },
        continuation: { action: 'describe_policy', classId, text, followUps },
        persistence: {
          canCreateWithCurrentApi: blockers.length === 0,
          blockers,
          createPayload,
        },
      };
    } finally {
      state.busy = false;
    }
  }
}
